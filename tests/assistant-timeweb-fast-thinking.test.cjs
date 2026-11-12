const test = require('node:test');
const assert = require('node:assert/strict');
const { callTimeweb } = require('../src/server/modules/assistant/providers/timeweb/timeweb.cjs');
for (const [model, expected] of [['deepseek/deepseek-flash', { type: 'disabled' }], ['openai/gpt-4.1-mini', undefined]]) {
  for (const content of ['initial command', 'continuation clarification']) {
    test(`Timeweb ${model} ${content} uses provider-specific thinking without changing output budget`, async () => {
      let sent;
      await callTimeweb({ kind: 'llm', provider: { model }, key: 'synthetic-key', timeoutMs: 1000,
        guard() {}, payload: { messages: [{ role: 'user', content }], max_tokens: 1000, temperature: 0,
          response_format: { type: 'json_object' } },
        fetchImpl: async (_url, options) => {
          sent = JSON.parse(options.body);
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"intent":"help"}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        },
      });
      assert.deepEqual(sent.thinking, expected);
      assert.equal(sent.max_tokens, 1000);
      assert.deepEqual(sent.response_format, { type: 'json_object' });
    });
  }
}
