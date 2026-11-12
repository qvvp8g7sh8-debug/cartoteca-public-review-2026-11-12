const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, flush, reply } = require('./helpers/assistant-voice-booking-fixture.cjs');
for (const streaming of [true, false])
  test('validated form opens before handoff audio with negotiated streaming=' + streaming + ' and never saves', async (t) => {
    const f = fixture(t, { scope: { capabilities: { stt: { ready: true, demo: false }, tts: { ready: true, demo: false, streaming } } } });
    const streamUrl = '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43);
    f.control.turn = async () => ({ intent: 'prepareAppointment', policyVersion: 1, demo: false, dialogue: null, text: 'Подготовил запись.', action: { type: 'prepareAppointment', patientId: 'synthetic-patient', staffId: 'staff', serviceIds: ['synthetic-service'], date: '2030-01-02', time: '15:30', duration: 30, roomId: 'main' } });
    f.control.speak = async () => streaming ? { streamUrl, mimeType: 'audio/mpeg', policyVersion: 1 } : { audioBase64: 'synthetic-audio', mimeType: 'audio/wav', policyVersion: 1 };
    await f.hold();
    const pending = f.transcript('Запиши Анну Синтетическую на 2 января в 15:30 на чистку');
    await flush();
    assert.equal(f.opened.length, 1);
    assert.equal(f.state.editorMode.kind, 'appointment');
    assert.equal(f.state.editorMode.id, null);
    const speech = f.calls.filter(call => call.route === '/api/assistant/speak');
    assert.equal(speech.length, 1);
    assert.equal(speech[0].body.stream, streaming ? true : undefined);
    assert.equal(f.played.length, 1);
    assert.equal(f.played[0].result.streamUrl, streaming ? streamUrl : undefined);
    await f.finishSpeech();
    await pending;
    assert.equal(f.captures.length, 1);
    assert.ok(f.calls.every(call => call.route.startsWith('/api/assistant/')));
  });

for (const terminal of [false, true])
  test('direct PCM descriptor preserves task proof for ' + (terminal ? 'terminal form handoff' : 'spoken question'), async (t) => {
    const f = fixture(t, { scope: {
      billing: { paid: true },
      capabilities: { stt: { ready: true }, tts: { ready: true, streaming: true, directPcm: true } },
    } });
    f.actions.assistantAudioFormat = () => 'pcm';
    const proof = { token: 'p'.repeat(43), answerableText: 'На какую дату?', readonlyText: 'На какую дату?', handoffText: 'Открыл форму записи. Запись не сохранена.' };
    f.control.turn = async () => terminal ? {
      text: proof.handoffText, policyVersion: 1, taskRequestId: 'synthetic-task', speechPermit: proof,
      dialogue: null, action: { type: 'prepareAppointment', patientId: 'synthetic-patient', staffId: 'staff', serviceIds: ['synthetic-service'], date: '2030-01-02', time: '15:30', duration: 30, roomId: 'main' },
    } : { ...reply(1), taskRequestId: 'synthetic-task', speechPermit: proof };
    await f.hold();
    const pending = f.transcript('Синтетическая команда');
    await flush();
    assert.equal(f.calls.filter(call => call.route === '/api/assistant/speak').length, 0);
    assert.equal(f.played.length, 1);
    const value = f.played[0].result;
    assert.equal(value.mimeType, 'audio/pcm');
    assert.equal(value.streamUrl, undefined);
    assert.equal(value.streamRequest.policyVersion, 1);
    assert.equal(value.streamRequest.taskRequestId, 'synthetic-task');
    assert.equal(value.streamRequest.speechToken, proof.token);
    assert.equal(value.streamRequest.format, 'pcm');
    assert.equal(value.streamRequest.text, terminal ? proof.handoffText : proof.answerableText);
    if (terminal) assert.equal(f.opened.length, 1);
    await f.finishSpeech(); await pending;
    assert.equal(f.state.editorMode?.id ?? null, null, 'no clinical save');
  });

test('paid terminal handoff retains captured proof through legacy streaming PCM after panel close', async (t) => {
  const f = fixture(t, { scope: {
    billing: { paid: true },
    capabilities: { stt: { ready: true }, tts: { ready: true, streaming: true, directPcm: false } },
  } });
  f.actions.assistantAudioFormat = () => 'pcm';
  const proof = { token: 'p'.repeat(43), handoffText: 'Открыл форму записи. Запись не сохранена.' };
  const streamUrl = '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43) + '&accountContext=staff&organizationContext=org';
  f.control.turn = async () => ({
    intent: 'prepareAppointment', text: proof.handoffText, policyVersion: 1,
    taskRequestId: 'synthetic-terminal-task', speechPermit: proof, dialogue: null,
    action: { type: 'prepareAppointment', patientId: 'synthetic-patient', staffId: 'staff', serviceIds: ['synthetic-service'], date: '2030-01-02', time: '15:30', duration: 30, roomId: 'main' },
  });
  f.control.speak = async () => {
    assert.equal(f.opened.length, 1, 'the form has opened and the assistant panel has closed before speech');
    assert.equal(f.$('dialog[open]'), null);
    return { streamUrl, mimeType: 'audio/pcm', policyVersion: 1, sampleRate: 24000, channels: 1, sampleFormat: 's16le', playbackRate: 1 };
  };
  await f.hold();
  const pending = f.transcript('Запиши Диану Неволину');
  await flush();
  const calls = f.calls.filter(call => call.route === '/api/assistant/speak');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].body, { text: proof.handoffText, policyVersion: 1, taskRequestId: 'synthetic-terminal-task', speechToken: proof.token, stream: true, format: 'pcm' });
  assert.equal(f.played.length, 1);
  assert.equal(f.played[0].result.mimeType, 'audio/pcm');
  assert.equal(f.played[0].result.streamUrl, streamUrl);
  assert.equal(f.played[0].result.streamRequest, undefined);
  await f.finishSpeech();
  await pending;
  assert.equal(f.captures.length, 1, 'terminal feedback does not start a new recording');
  assert.equal(f.state.editorMode.kind, 'appointment');
  assert.equal(f.state.editorMode.id, null, 'manual form remains unsaved');
  assert.ok(f.calls.every(call => call.route.startsWith('/api/assistant/')));
});
