const { fail } = require('../../../../../shared/errors.cjs');
const { createMp3Validator } = require('../../speech/mp3-audio.cjs');
const {
  createPcmValidator,
  speechEncoding,
  PCM_METADATA,
  MAX_AUDIO_BYTES,
} = require('../../speech/pcm-audio.cjs');
const { assertSignal, waitForAbort, disposeBody } = require('../../buffered-request.cjs');
const {
  beginAssistantTiming,
  assistantOutcome,
} = require('../../../../infrastructure/assistant-timing.cjs');
const { createSpeechPackets } = require('./speech-packets.cjs');
const BASE = 'https://api.timeweb.ai/v1';
function createSpeechOutput(c, guard, timeoutMs, format = 'mp3') {
  const encoding = speechEncoding(format);
  const controller = new AbortController();
  const firstWriteEnd = beginAssistantTiming(
    c.assistantTiming,
    'tts-first-write',
    'tts',
    'timeweb',
    true,
  );
  const stopped = () => fail(499, 'Озвучивание остановлено.');
  const abort = () => controller.abort(stopped());
  const timer = setTimeout(
    () => controller.abort(fail(502, 'Истекло время озвучивания.')),
    timeoutMs,
  );
  const disconnected = () => {
    if (!c.res.writableFinished) abort();
  };
  c.req.on('aborted', abort);
  c.res.on('close', disconnected);
  function check() {
    assertSignal(controller.signal);
    if (c.req.aborted || c.res.destroyed) {
      abort();
      assertSignal(controller.signal);
    }
    guard();
  }
  function wait(promise, options) {
    assertSignal(controller.signal);
    return waitForAbort(promise, controller.signal, options);
  }
  return {
    signal: controller.signal,
    check,
    wait,
    async write(buffer) {
      check();
      if (!c.res.headersSent) {
        c.res.writeHead(200, {
          'Content-Type': encoding.mimeType,
          ...(Number.isSafeInteger(c.assistantSpeechPolicyVersion)
            ? { 'X-Assistant-Policy-Version': String(c.assistantSpeechPolicyVersion) }
            : {}),
          ...(format === 'pcm'
            ? {
                'X-Audio-Sample-Rate': String(PCM_METADATA.sampleRate),
                'X-Audio-Channels': String(PCM_METADATA.channels),
                'X-Audio-Sample-Format': PCM_METADATA.sampleFormat,
              }
            : {}),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Accept-Ranges': 'none',
        });
        // Header hooks may change scope; validate again before the first byte.
        check();
      }
      // Later packets already passed the fresh guard at entry to write().
      // No await or response hook separates that guard from this write.
      const accepted = c.res.write(buffer);
      if (buffer.length) firstWriteEnd();
      if (!accepted) {
        const end = beginAssistantTiming(c.assistantTiming, 'tts-backpressure', 'tts', 'timeweb');
        try {
          await wait(
            new Promise((resolve, reject) => {
              const cleanup = () => {
                c.res.removeListener('drain', drained);
                c.res.removeListener('error', errored);
                controller.signal.removeEventListener('abort', cancelled);
              };
              const drained = () => {
                cleanup();
                resolve();
              };
              const errored = (error) => {
                cleanup();
                reject(error);
              };
              const cancelled = () => {
                cleanup();
                reject(stopped());
              };
              c.res.once('drain', drained);
              c.res.once('error', errored);
              controller.signal.addEventListener('abort', cancelled, { once: true });
            }),
          );
          check();
          end();
        } catch (error) {
          end(assistantOutcome(error));
          throw error;
        }
      }
    },
    end() {
      check();
      c.res.end();
    },
    dispose() {
      firstWriteEnd(
        controller.signal.aborted ? assistantOutcome(controller.signal.reason) : 'cancelled',
      );
      clearTimeout(timer);
      c.req.removeListener('aborted', abort);
      c.res.removeListener('close', disconnected);
      abort();
    },
    observationFailed(error) {
      firstWriteEnd(assistantOutcome(error));
    },
  };
}
async function streamTimewebSpeech({
  provider,
  key,
  payload,
  output,
  fetchImpl = globalThis.fetch,
  onOutbound = () => {},
  collect = false,
  format = 'mp3',
  assistantTiming,
}) {
  const encoding = speechEncoding(format);
  let reader,
    unconsumed,
    cancelled = false;
  const cancelReader = () => {
    if (!reader || cancelled) return;
    cancelled = true;
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  };
  const chunks = [];
  let validator,
    total = 0;
  const preparationEnd = beginAssistantTiming(
    assistantTiming,
    'provider-prepare',
    'tts',
    'timeweb',
  );
  const providerEnd = beginAssistantTiming(assistantTiming, 'provider-complete', 'tts', 'timeweb');
  let headersEnd, firstByteEnd;
  try {
    output.check();
    preparationEnd();
    const admitted = onOutbound();
    if (admitted && typeof admitted.then === 'function') await admitted;
    output.check();
    headersEnd = beginAssistantTiming(assistantTiming, 'provider-headers', 'tts', 'timeweb');
    firstByteEnd = beginAssistantTiming(assistantTiming, 'provider-first-byte', 'tts', 'timeweb');
    const response = await output.wait(
      fetchImpl(BASE + '/audio/speech', {
        method: 'POST',
        redirect: 'error',
        signal: output.signal,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          ...payload,
          voice: provider.voice,
          response_format: encoding.format,
          ...(format === 'pcm' ? { speed: encoding.speed } : {}),
        }),
      }),
      { onLate: disposeBody },
    );
    unconsumed = response;
    headersEnd();
    output.check();
    if (!response.ok)
      throw fail(response.status === 429 ? 429 : 502, 'Провайдер озвучивания временно недоступен.');
    const contentType = (response.headers.get('content-type') || '').trim().toLowerCase();
    const mime = contentType.split(';')[0].trim();
    // The exact Timeweb endpoint documents raw PCM, but two bounded synthetic
    // probes returned raw-PCM candidates mislabeled audio/mpeg. Trust only this
    // explicit response_format contract plus a rejection guard before first write.
    // Raw PCM has no magic signature; this is not absolute codec identification.
    const mislabeledPcm = format === 'pcm' && contentType === 'audio/mpeg';
    const length = Number(response.headers.get('content-length'));
    if (
      !(format === 'pcm'
        ? contentType === 'audio/pcm' || mislabeledPcm
        : ['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(mime)) ||
      (Number.isFinite(length) && length > MAX_AUDIO_BYTES) ||
      !response.body?.getReader
    )
      throw fail(
        502,
        format === 'pcm' ? 'Провайдер не вернул поток PCM.' : 'Провайдер не вернул поток MP3.',
      );
    validator =
      format === 'pcm'
        ? createPcmValidator({ rejectEncodedPrefix: mislabeledPcm })
        : createMp3Validator();
    reader = response.body.getReader();
    unconsumed = null;
    const nextPacket = createSpeechPackets(reader, output.signal, cancelReader, MAX_AUDIO_BYTES);
    while (true) {
      const { done, value } = await nextPacket();
      if (done) {
        output.check();
        break;
      }
      const chunk = Buffer.from(value);
      if (chunk.length) firstByteEnd();
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) throw fail(502, 'Аудио провайдера превышает ограничение.');
      if (collect) chunks.push(chunk);
      const verified = validator.push(chunk);
      if (verified) await output.write(verified);
      else output.check();
    }
    const completed = validator.finish();
    if (completed.tail) await output.write(completed.tail);
    output.check();
    providerEnd();
    return {
      bytes: collect ? Buffer.concat(chunks) : null,
      byteLength: total,
      seconds: completed.seconds,
    };
  } catch (error) {
    preparationEnd(assistantOutcome(error));
    providerEnd(assistantOutcome(error));
    headersEnd?.(assistantOutcome(error));
    firstByteEnd?.(assistantOutcome(error));
    if (error.status) throw error;
    output.check();
    throw fail(502, 'Не удалось получить озвучивание от провайдера.');
  } finally {
    cancelReader();
    disposeBody(unconsumed);
  }
}
module.exports = { createSpeechOutput, streamTimewebSpeech, MAX_AUDIO_BYTES };
