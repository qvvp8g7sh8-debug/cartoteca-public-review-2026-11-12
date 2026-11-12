const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, flush, reply } = require('./helpers/assistant-voice-booking-fixture.cjs');

const proofCode = 'ASSISTANT_SPEECH_PROOF_REQUIRED';
const setup = (t) => {
  const f = fixture(t, { scope: {
    billing: { paid: true },
    capabilities: { stt: { ready: true }, tts: { ready: true, streaming: true, directPcm: true } },
  } });
  f.actions.assistantAudioFormat = () => 'pcm';
  f.control.turn = async () => ({ ...reply(1, 'client'), taskRequestId: 'synthetic-task',
    speechPermit: { token: 'p'.repeat(43), answerableText: 'Кого открыть?' } });
  return f;
};

test('speech-only proof refusal preserves client choice, dialogue and active listening without retry', async (t) => {
  const f = setup(t);
  await f.hold();
  const pending = f.transcript('Открой карточку Попова');
  await flush();
  assert.ok(f.$('[data-assistant-picker="client"]').open);
  const speech = f.played[0];
  speech.result.onRefused(403, proofCode);
  speech.gate.reject(Object.assign(Error('Ответ доступен на экране.'), { status: 403, code: proofCode }));
  await pending;
  await flush();
  assert.equal(f.state.assistantGeneration, 0);
  assert.ok(f.$('[data-assistant-picker="client"]').open);
  assert.equal(f.captures.length, 2, 'resume listening for this choice without retrying speech');
  assert.equal(f.played.length, 1);
  assert.equal(f.turns().length, 1);
  f.control.turn = async (body) => {
    assert.equal(body.dialogueId, 'synthetic-dialogue');
    assert.equal(body.dialogueVersion, 1);
    assert.equal(body.choice, 'opaque-option-1');
    return reply(2, 'service');
  };
  f.$('[data-assistant-picker="client"] [data-assistant-choice]').click();
  await flush();
  assert.equal(f.turns().length, 2, 'the existing choice stays actionable');
  assert.ok(f.$('[data-assistant-picker="service"]').open);
});

for (const [status, code] of [[403, 'UNKNOWN'], [409, 'UNKNOWN'], [428, proofCode], [409, proofCode]])
  test('non-speech refusal still resets the assistant: ' + status + '/' + code, async (t) => {
    const f = setup(t);
    await f.hold();
    const pending = f.transcript('Открой карточку Попова');
    await flush();
    f.played[0].result.onRefused(status, code);
    await pending;
    assert.equal(f.state.assistantGeneration, 1);
    assert.equal(f.$('[data-assistant-picker="client"]'), null);
  });
