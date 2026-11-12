const { fail } = require('../../../../../shared/errors.cjs');
const { finalizeProviderWav } = require('../../speech/audio.cjs');
const {
  assertSignal,
  signalError,
  disposeBody,
  waitForAbort,
} = require('../../buffered-request.cjs');
const BASE = 'https://api.timeweb.ai/v1';
const {
  beginAssistantTiming,
  assistantOutcome,
} = require('../../../../infrastructure/assistant-timing.cjs');
async function readBounded(response, maxBytes, guard, signal, firstByte) {
  const chunks = [];
  let size = 0,
    reader,
    cancelled = false,
    sawFirst = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      Promise.resolve(reader ? reader.cancel() : response.body?.cancel?.()).catch(() => {});
    } catch {}
  };
  try {
    if (!response.body?.getReader) throw fail(502, 'Провайдер не вернул ответ.');
    reader = response.body.getReader();
    while (true) {
      assertSignal(signal);
      guard();
      const { done, value } = await waitForAbort(reader.read(), signal, { onAbort: cancel });
      assertSignal(signal);
      guard();
      if (done) break;
      if (!sawFirst && value.byteLength) {
        sawFirst = true;
        try {
          firstByte?.();
        } catch {}
      }
      size += value.byteLength;
      if (size > maxBytes) throw fail(502, 'Ответ провайдера превышает ограничение.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    cancel();
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
}
async function callTimeweb({
  kind,
  provider,
  key,
  payload,
  timeoutMs,
  guard,
  fetchImpl = globalThis.fetch,
  onOutbound = () => {},
  signal,
  assistantTiming,
}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signalError(signal));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(
    () => controller.abort(fail(502, 'Истекло время ответа помощника.')),
    timeoutMs,
  );
  const check = () => {
    assertSignal(controller.signal);
    guard();
    assertSignal(controller.signal);
  };
  let unconsumed, headersEnd, firstByteEnd;
  try {
    const headers = { Authorization: 'Bearer ' + key };
    let body, route;
    if (kind === 'stt') {
      route = '/audio/transcriptions';
      body = new FormData();
      body.set('model', provider.model);
      body.set('file', new globalThis.Blob([payload.bytes], { type: 'audio/wav' }), 'voice.wav');
      body.set('language', 'ru');
      body.set('response_format', 'json');
      if (payload.prompt) body.set('prompt', payload.prompt);
    } else {
      route = kind === 'llm' ? '/chat/completions' : '/audio/speech';
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({
        model: provider.model,
        ...payload,
        ...(kind === 'llm' && /^deepseek\//i.test(provider.model)
          ? { thinking: { type: 'disabled' } }
          : {}),
        ...(kind === 'tts' ? { voice: provider.voice, response_format: 'wav' } : {}),
      });
    }
    check();
    const admitted = onOutbound();
    if (admitted && typeof admitted.then === 'function') await admitted;
    check();
    headersEnd = beginAssistantTiming(assistantTiming, 'provider-headers', kind, 'timeweb');
    firstByteEnd = beginAssistantTiming(assistantTiming, 'provider-first-byte', kind, 'timeweb');
    const response = await waitForAbort(
      fetchImpl(BASE + route, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: controller.signal,
      }),
      controller.signal,
      { onLate: disposeBody },
    );
    unconsumed = response;
    headersEnd();
    check();
    if (!response.ok) {
      throw fail(
        response.status === 429 ? 429 : 502,
        response.status === 401 || response.status === 403
          ? 'Провайдер отклонил ключ. Обратитесь к администратору.'
          : 'Провайдер помощника временно недоступен.',
      );
    }
    unconsumed = null;
    const bytes = await readBounded(
      response,
      kind === 'tts' ? 4 * 1024 * 1024 : 65536,
      check,
      controller.signal,
      firstByteEnd,
    );
    if (kind === 'tts') {
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      // Timeweb may label a requested WAV as MPEG; the existing PCM validator remains authoritative.
      const mislabeledWav =
        mime === 'audio/mpeg' &&
        bytes.length >= 12 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WAVE';
      if (
        (!['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'].includes(mime) &&
          !mislabeledWav) ||
        !bytes.length
      )
        throw fail(502, 'Провайдер не вернул голосовой ответ.');
      const completed = finalizeProviderWav(bytes);
      return {
        audioBase64: completed.bytes.toString('base64'),
        mimeType: 'audio/wav',
        usage: {
          input_tokens: Buffer.byteLength(JSON.stringify(payload)),
          output_tokens: Math.ceil(completed.seconds),
        },
        usageEstimated: true,
      };
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw fail(502, 'Провайдер вернул некорректный ответ.');
    }
    if (kind === 'stt') {
      if (typeof value.text !== 'string')
        throw fail(502, 'Провайдер не вернул распознанный текст.');
      return {
        text: value.text,
        usage: value.usage || {
          input_tokens: Math.ceil(payload.seconds * 10) + Buffer.byteLength(payload.prompt || ''),
          output_tokens: Buffer.byteLength(value.text),
        },
        usageEstimated: !value.usage,
      };
    }
    const choice = value.choices?.[0];
    if (choice?.finish_reason === 'length')
      throw fail(502, 'Лимита ответа модели не хватило. Ответ не применён.');
    const message = choice?.message;
    if (!message || message.tool_calls?.length || typeof message.content !== 'string')
      throw fail(502, 'Не получена поддерживаемая команда помощника.');
    if (!message.content.trim())
      throw fail(502, 'Модель не вернула текст ответа. Повторите запрос.');
    return { text: message.content, usage: value.usage };
  } catch (error) {
    headersEnd?.(assistantOutcome(error));
    firstByteEnd?.(assistantOutcome(error));
    if (error.status) throw error;
    throw fail(
      502,
      controller.signal.aborted
        ? 'Истекло время ответа помощника.'
        : 'Не удалось связаться с провайдером помощника.',
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    disposeBody(unconsumed);
  }
}
module.exports = { callTimeweb, readBounded };
