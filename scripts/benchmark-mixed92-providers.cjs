const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
function createModelCassette({ latencyMs = 3000, sleep = wait } = {}) {
  assert.ok(Number.isInteger(latencyMs) && latencyMs >= 0 && latencyMs <= 30000);
  let calls = 0,
    modelCalls = 0,
    ttsCalls = 0,
    active = 0,
    peak = 0,
    aborted = 0;
  return {
    async fetch(url, options) {
      assert.ok(
        [
          'https://api.timeweb.ai/v1/chat/completions',
          'https://api.timeweb.ai/v1/audio/speech',
        ].includes(url),
      );
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      calls++;
      const tts = url.endsWith('/audio/speech');
      if (tts) ttsCalls++;
      else modelCalls++;
      active++;
      peak = Math.max(peak, active);
      try {
        await sleep(tts ? 200 : latencyMs, undefined, { signal: options.signal });
        if (tts) {
          const frame = Buffer.alloc(417);
          Buffer.from([255, 251, 144, 100]).copy(frame);
          return new Response(frame, { headers: { 'Content-Type': 'audio/mpeg' } });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: '{"intent":"clients","query":"Synthetic Client0"}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 50 },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      } catch (error) {
        if (error.name === 'AbortError') aborted++;
        throw error;
      } finally {
        active--;
      }
    },
    snapshot: () => ({
      provider: 'in-memory-cassette',
      realCalls: 0,
      latencyMs,
      calls,
      modelCalls,
      ttsCalls,
      ttsDelayMs: 200,
      active,
      peak,
      aborted,
    }),
  };
}
module.exports = { createModelCassette };
