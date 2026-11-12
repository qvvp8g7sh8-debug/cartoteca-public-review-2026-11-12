const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, flush, reply } = require('./helpers/assistant-voice-booking-fixture.cjs');
const proof = 'ASSISTANT_SPEECH_PROOF_REQUIRED';
for (const [code, keep] of [[proof, true], ['UNKNOWN', false]]) {
  test('legacy PCM speech403 ' + code + ' preserves only typed speech-proof dialogue', async (t) => {
    const f = fixture(t, { scope: { billing: { paid: true }, capabilities: { stt: { ready: true }, tts: { ready: true, streaming: true, directPcm: false } } } });
    f.actions.assistantAudioFormat = () => 'pcm';
    f.control.turn = async () => ({ ...reply(1, 'service'), taskRequestId: 'synthetic-task', speechPermit: { token: 'p'.repeat(43), answerableText: 'Выберите услугу' } });
    f.control.speak = async () => { throw Object.assign(Error('Synthetic speech refusal'), { status: 403, code }); };
    await f.hold();
    await f.transcript('Запиши Диану Неволину');
    await flush();
    assert.equal(f.state.assistantGeneration, keep ? 0 : 1);
    const picker = f.$('[data-assistant-picker="service"]');
    assert.equal(Boolean(picker?.open), keep);
    assert.equal(f.calls.filter((row) => row.route === '/api/assistant/speak').length, 1);
    assert.equal(f.played.length, 0, 'refused synthesis is never played or retried');
    if (keep) assert.equal(f.captures.length, 2, 'continue listening for the current visible step');
  });
}

test('a proof-named403 on turn still resets instead of bypassing domain authorization', async (t) => {
  const f = fixture(t);
  f.control.turn = async () => { throw Object.assign(Error('Synthetic domain refusal'), { status: 403, code: proof }); };
  await f.hold();
  await f.transcript('Запиши Диану Неволину');
  await flush();
  assert.equal(f.state.assistantGeneration, 1);
  assert.equal(f.$('[data-assistant-picker="service"]'), null);
  assert.equal(f.calls.filter((row) => row.route === '/api/assistant/speak').length, 0);
});
