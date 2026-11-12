const { fail } = require('../../../../shared/errors.cjs');
const { boundedText, keys } = require('../access/defaults.cjs');
const { createSpeechTickets, speechIdentity } = require('./speech-tickets.cjs');
const { createSpeechCache } = require('./speech-cache.cjs');
const { createSpeechGeneration } = require('./speech-generation.cjs');
const { MAX_MP3_SECONDS } = require('./mp3-audio.cjs');
const {
  beginAssistantTiming,
  assistantOutcome,
} = require('../../../infrastructure/assistant-timing.cjs');
const {
  speechEncoding,
  PCM_METADATA,
  MAX_PCM_SECONDS,
  PCM_BYTES_PER_SECOND,
} = require('./pcm-audio.cjs');
const {
  createSpeechOutput,
  streamTimewebSpeech,
  MAX_AUDIO_BYTES,
} = require('../providers/timeweb/timeweb-speech-stream.cjs');
function speechPayload(text) {
  return {
    input: text,
    instructions:
      'Прочитай только переданный текст, без вступлений и добавлений. ' +
      'Говори чётко, умеренно быстрым разговорным темпом, без растягивания слов и длинных пауз. ' +
      'Начинай сразу; между предложениями делай короткие естественные паузы. ' +
      'Имена, даты, время и числа произноси разборчиво.',
  };
}
function createSpeechService({
  scope,
  invoke,
  budget,
  fetchImpl,
  authorizeSpeech = () => {},
  taskEvidence = () => undefined,
  ticketCapacity = undefined,
}) {
  const tickets = createSpeechTickets({ capacity: ticketCapacity }),
    cache = createSpeechCache();
  const directSessions = new Map(),
    directCapacity = ticketCapacity ?? 128;
  let directActive = 0;
  function directLease(sessionId) {
    const active = directSessions.get(sessionId) || 0;
    if (directActive >= directCapacity || active >= 4)
      throw Object.assign(fail(503, 'Озвучивание занято. Повторите ответ немного позже.'), {
        code: 'ASSISTANT_DIRECT_SPEECH_CAPACITY',
        retryAfter: 2,
        outcomeUnknown: false,
      });
    directActive++;
    directSessions.set(sessionId, active + 1);
    return () => {
      directActive--;
      const remaining = directSessions.get(sessionId) - 1;
      if (remaining) directSessions.set(sessionId, remaining);
      else directSessions.delete(sessionId);
    };
  }
  async function speak(c, body) {
    keys(body, ['text', 'policyVersion', 'stream', 'format', 'taskRequestId', 'speechToken']);
    const encoding = speechEncoding(body.format);
    if (body.stream !== undefined && typeof body.stream !== 'boolean')
      throw fail(400, 'Выберите режим озвучивания.');
    const { state, member } = scope(c, body.policyVersion);
    if (
      encoding.format === 'pcm' &&
      (body.stream !== true || state.providers.tts.provider !== 'timeweb')
    )
      throw fail(400, 'Потоковый PCM недоступен для выбранного режима озвучивания.');
    const text = boundedText(
      body.text,
      state.policy.limits.maxReplyChars,
      'голосовой ответ',
    ).trim();
    if (!text) throw fail(400, 'Нет текста для озвучивания.');
    const assistantTask = authorizeSpeech(c, body);
    if (assistantTask) c = { ...c, assistantTask };
    if (body.stream === true && state.providers.tts.provider === 'timeweb') {
      if (!state.credentials.timeweb)
        throw fail(503, 'Провайдер не настроен. Обратитесь к администратору.');
      return {
        text,
        streamUrl: tickets.issue(
          c,
          state,
          member,
          text,
          encoding.format,
          assistantTask
            ? { taskRequestId: body.taskRequestId, speechToken: body.speechToken }
            : undefined,
        ),
        mimeType: encoding.mimeType,
        ...(encoding.format === 'pcm' ? PCM_METADATA : {}),
        policyVersion: state.revision,
        demo: false,
      };
    }
    const payload = speechPayload(text);
    const reserved =
      (Buffer.byteLength(JSON.stringify(payload)) * state.rates.ttsInput +
        Math.ceil(MAX_AUDIO_BYTES / 32000) * state.rates.ttsOutput) /
      1000000;
    const result = await invoke(c, body.policyVersion, 'tts', state, payload, reserved, () => ({
      audioBase64: null,
      mimeType: null,
      text,
    }));
    scope(c, body.policyVersion);
    return {
      audioBase64: result.audioBase64,
      mimeType: result.mimeType,
      text,
      policyVersion: state.revision,
      demo: result.demo,
      ...(state.providers.tts.provider === 'local' ? { local: true } : {}),
      usage: result.usage,
    };
  }
  async function speakAudio(c) {
    const parameters = c.url.searchParams;
    if (
      [...parameters.keys()].length !== 3 ||
      ['ticket', 'accountContext', 'organizationContext'].some(
        (name) => parameters.getAll(name).length !== 1,
      )
    )
      throw fail(400, 'Некорректный запрос озвучивания.');
    if (
      parameters.get('accountContext') !== (c.current.accountId || '') ||
      parameters.get('organizationContext') !== (c.current.organizationId || '')
    )
      throw Object.assign(fail(428, 'Учётная запись изменилась. Откройте кабинет заново.'), {
        code: 'AUTH_CONTEXT_CHANGED',
        outcomeUnknown: false,
      });
    const { state, ticket } = tickets.take(c, c.url.searchParams.get('ticket'), scope);
    return streamSpeech(c, state, ticket);
  }
  async function prepareTurnSpeech(c, body, response) {
    const fallback = () => {
      tickets.discardTurn(c.current.sessionId);
      return response;
    };
    if (
      body.speech?.format !== 'pcm' ||
      body.speech?.stream !== true ||
      body.speech?.mode !== 'answerable' ||
      body.cancel === true ||
      !response.dialogue ||
      !response.speechPermit?.token ||
      !response.taskRequestId
    )
      return fallback();
    // This is only an optional delivery hint after the task has completed.
    // Ticket preparation must neither start paid synthesis nor hide its result.
    try {
      const { state, member } = scope(c, response.policyVersion);
      const text = response.speechPermit.answerableText;
      if (
        state.providers.tts.provider !== 'timeweb' ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > state.policy.limits.maxReplyChars
      )
        return fallback();
      const proof = {
        text,
        policyVersion: response.policyVersion,
        taskRequestId: response.taskRequestId,
        speechToken: response.speechPermit.token,
      };
      if (!state.credentials.timeweb) return fallback();
      authorizeSpeech(c, proof);
      const ticket = tickets.issueTurn(
        c,
        state,
        member,
        text,
        {
          taskRequestId: proof.taskRequestId,
          speechToken: proof.speechToken,
        },
        response.dialogue,
      );
      if (!ticket) return fallback();
      if (ticket.replay) return { ...response, speechReplay: true };
      return {
        ...response,
        speech: {
          text,
          ...ticket,
          mimeType: 'audio/pcm',
          ...PCM_METADATA,
          policyVersion: state.revision,
          demo: false,
        },
      };
    } catch {
      // Capacity or a changed scope leaves the ordinary protected POST path.
      return fallback();
    }
  }
  async function speakPcm(c, body) {
    keys(body, ['text', 'policyVersion', 'format', 'taskRequestId', 'speechToken']);
    if (body.format !== 'pcm') throw fail(400, 'Выберите потоковый PCM.');
    const { state, member } = scope(c, body.policyVersion);
    if (state.providers.tts.provider !== 'timeweb')
      throw fail(400, 'Потоковый PCM недоступен для выбранного режима озвучивания.');
    if (!state.credentials.timeweb)
      throw fail(503, 'Провайдер не настроен. Обратитесь к администратору.');
    const text = boundedText(
      body.text,
      state.policy.limits.maxReplyChars,
      'голосовой ответ',
    ).trim();
    if (!text) throw fail(400, 'Нет текста для озвучивания.');
    const descriptor = {
      text,
      format: 'pcm',
      version: state.revision,
      identity: speechIdentity(c, state, member, 'pcm'),
      proof: { taskRequestId: body.taskRequestId, speechToken: body.speechToken },
    };
    const release = directLease(c.current.sessionId);
    try {
      return await streamSpeech(
        { ...c, assistantSpeechPolicyVersion: state.revision },
        state,
        descriptor,
      );
    } finally {
      release();
    }
  }
  async function streamSpeech(c, state, ticket) {
    const encoding = speechEncoding(ticket.format);
    const proof = { ...ticket.proof, text: ticket.text, policyVersion: ticket.version };
    const assistantTask = authorizeSpeech(c, proof);
    if (assistantTask) c = { ...c, assistantTask };
    const guard = () => {
      const fresh = scope(c, ticket.version);
      authorizeSpeech(c, proof);
      if (speechIdentity(c, fresh.state, fresh.member, encoding.format) !== ticket.identity)
        throw fail(409, 'Настройки озвучивания изменились. Повторите ответ.');
    };
    const output = createSpeechOutput(
      c,
      guard,
      state.policy.limits.requestTimeoutMs,
      encoding.format,
    );
    const cached = cache.claim(state, c.current.organizationId, ticket.text, encoding.format);
    const payload = speechPayload(ticket.text);
    // One generic generation owns the bounded paid reservation. PCM is constrained
    // by both its fixed sample rate and the unchanged byte ceiling.
    // Followers retain their existing zero-cost request reservation and fresh guards.
    const maxSeconds =
      encoding.format === 'pcm'
        ? Math.min(MAX_PCM_SECONDS, MAX_AUDIO_BYTES / PCM_BYTES_PER_SECOND)
        : MAX_MP3_SECONDS;
    const amount =
      (Buffer.byteLength(JSON.stringify(payload)) * state.rates.ttsInput +
        Math.ceil(maxSeconds) * state.rates.ttsOutput) /
      1000000;
    const actualCost = (seconds) =>
      (Buffer.byteLength(JSON.stringify(payload)) * state.rates.ttsInput +
        Math.ceil(seconds) * state.rates.ttsOutput) /
      1000000;
    let reservation,
      waiter,
      admissionEnd,
      outbound = false,
      settled = false,
      delegated = false;
    const settle = (cost) => {
      if (!settled) {
        const end = beginAssistantTiming(c.assistantTiming, 'settlement', 'tts', 'timeweb');
        try {
          const committed = budget.settle(reservation, cost);
          if (committed && typeof committed.then === 'function')
            return committed.then(
              () => {
                settled = true;
                end();
              },
              (error) => {
                end(assistantOutcome(error));
                throw error;
              },
            );
          settled = true;
          end();
        } catch (error) {
          end(assistantOutcome(error));
          throw error;
        }
      }
    };
    try {
      output.check();
      admissionEnd = beginAssistantTiming(c.assistantTiming, 'admission', 'tts', 'timeweb');
      const admission = budget.reserve(
        c.current,
        ticket.version,
        'tts',
        cached && !cached.owner ? 0 : amount,
        taskEvidence(c),
      );
      reservation = admission && typeof admission.then === 'function' ? await admission : admission;
      admissionEnd();
      output.check();
      if (cached?.owner) {
        const generation = createSpeechGeneration({
          timeoutMs: state.policy.limits.requestTimeoutMs,
          run: (sharedOutput, sent) =>
            streamTimewebSpeech({
              provider: state.providers.tts,
              key: state.credentials.timeweb,
              payload,
              output: sharedOutput,
              fetchImpl,
              assistantTiming: c.assistantTiming,
              collect: true,
              format: encoding.format,
              onOutbound: () => {
                guard();
                const end = beginAssistantTiming(
                  c.assistantTiming,
                  'outbound-mark',
                  'tts',
                  'timeweb',
                );
                try {
                  const marked = budget.markOutbound?.(reservation);
                  const finish = () => {
                    try {
                      guard();
                      sent();
                      end();
                    } catch (error) {
                      end(assistantOutcome(error));
                      throw error;
                    }
                  };
                  if (marked && typeof marked.then === 'function')
                    return marked.then(finish, (error) => {
                      end(assistantOutcome(error));
                      throw error;
                    });
                  return finish();
                } catch (error) {
                  end(assistantOutcome(error));
                  throw error;
                }
              },
            }),
          complete(result) {
            const committed = settle(actualCost(result.seconds));
            if (committed && typeof committed.then === 'function')
              return committed.then(() => cached.finish(result.bytes));
            cached.finish(result.bytes);
          },
          failed(error, sent) {
            let committed;
            try {
              committed = settle(sent ? null : 0);
            } catch (failure) {
              cached.fail(error);
              throw failure;
            }
            if (committed && typeof committed.then === 'function')
              return committed.finally(() => cached.fail(error));
            cached.fail(error);
          },
        });
        cached.bindGeneration(generation);
        waiter = generation.attach(output, true);
        generation.start();
        delegated = true;
        await waiter.wait();
        output.end();
      } else {
        let actual = 0;
        if (cached) {
          let result;
          const end = beginAssistantTiming(c.assistantTiming, 'tts-cache-wait', 'tts', 'timeweb');
          try {
            if (cached.generation) {
              waiter = cached.generation.attach(output);
              result = await waiter.wait();
            } else result = await output.wait(cached.promise);
            output.check();
            if (result.error) throw result.error;
            end();
          } catch (error) {
            end(assistantOutcome(error));
            throw error;
          }
          await output.write(result.bytes);
        } else {
          const result = await streamTimewebSpeech({
            provider: state.providers.tts,
            key: state.credentials.timeweb,
            payload,
            output,
            format: encoding.format,
            fetchImpl,
            assistantTiming: c.assistantTiming,
            onOutbound: () => {
              guard();
              const end = beginAssistantTiming(
                c.assistantTiming,
                'outbound-mark',
                'tts',
                'timeweb',
              );
              try {
                const marked = budget.markOutbound?.(reservation);
                const finish = () => {
                  try {
                    guard();
                    outbound = true;
                    end();
                  } catch (error) {
                    end(assistantOutcome(error));
                    throw error;
                  }
                };
                if (marked && typeof marked.then === 'function')
                  return marked.then(finish, (error) => {
                    end(assistantOutcome(error));
                    throw error;
                  });
                return finish();
              } catch (error) {
                end(assistantOutcome(error));
                throw error;
              }
            },
          });
          actual = actualCost(result.seconds);
        }
        output.check();
        const committed = settle(actual);
        if (committed && typeof committed.then === 'function') await committed;
        output.end();
      }
    } catch (error) {
      admissionEnd?.(assistantOutcome(error));
      output.observationFailed(error);
      // The original HTTP owner may leave while its shared paid generation runs for B.
      if (!delegated) {
        if (cached?.owner) cached.fail(error);
        if (reservation) {
          const committed = settle(outbound ? null : 0);
          if (committed && typeof committed.then === 'function') await committed;
        }
      }
      if (c.res.headersSent && !c.res.destroyed) c.res.destroy();
      throw error;
    } finally {
      waiter?.dispose();
      output.dispose();
    }
  }
  return {
    prepareTurnSpeech,
    speak,
    speakAudio,
    speakPcm,
    stats: tickets.stats,
    clearSession: tickets.clearSession,
    clearAccount: tickets.clearAccount,
  };
}
module.exports = { createSpeechService, speechPayload };
