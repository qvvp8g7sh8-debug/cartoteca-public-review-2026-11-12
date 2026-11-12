const test = require('node:test'),
  assert = require('node:assert/strict');
const { fixture, reply, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');
const descriptor = () => ({
  text: 'Выберите услугу',
  policyVersion: 1,
  mimeType: 'audio/pcm',
  sampleRate: 24000,
  channels: 1,
  sampleFormat: 's16le',
  playbackRate: 1,
  expiresAt: Date.now() + 30000,
  streamUrl:
    '/api/assistant/speak-audio?ticket=' +
    'a'.repeat(43) +
    '&accountContext=staff&organizationContext=org',
});
const setup = (t, ticket) => {
  const f = fixture(t, {
    scope: {
      billing: { paid: true },
      capabilities: {
        stt: { ready: true },
        tts: { ready: true, streaming: true, directPcm: false, turnTicket: true },
      },
    },
  });
  f.actions.assistantAudioFormat = () => 'pcm';
  f.control.turn = async () => ({
    ...reply(1),
    taskRequestId: 'synthetic-task',
    speechPermit: { token: 'p'.repeat(43), answerableText: 'Выберите услугу' },
    speech: ticket,
  });
  return f;
};
test('voice opts into exact answerable ticket and plays existing GET descriptor without ticket POST', async (t) => {
  const ticket = descriptor(),
    f = setup(t, ticket);
  await f.hold();
  const pending = f.transcript('Синтетическая команда');
  await flush();
  assert.deepEqual(f.turns()[0].body.speech, { format: 'pcm', stream: true, mode: 'answerable' });
  assert.equal(f.calls.filter((c) => c.route === '/api/assistant/speak').length, 0);
  assert.equal(f.played.length, 1);
  assert.equal(f.played[0].result.streamUrl, ticket.streamUrl);
  assert.equal(f.played[0].result.streamRequest, undefined);
  await f.finishSpeech();
  await pending;
});
for (const [name, change] of [
  ['expired', (x) => (x.expiresAt = Date.now() - 1)],
  ['policy', (x) => (x.policyVersion = 2)],
  ['text', (x) => (x.text = 'Другая реплика')],
  ['url', (x) => (x.streamUrl = 'https://elsewhere.test/audio')],
  ['format', (x) => (x.sampleRate = 16000)],
])
  test('invalid ' + name + ' descriptor falls back before any GET attempt', async (t) => {
    const ticket = descriptor();
    change(ticket);
    const f = setup(t, ticket);
    await f.hold();
    const pending = f.transcript('Синтетическая команда');
    await flush();
    assert.equal(f.calls.filter((c) => c.route === '/api/assistant/speak').length, 1);
    assert.equal(f.played[0].result.streamUrl, undefined);
    await f.finishSpeech();
    await pending;
  });
for (const status of [410, 403, 500])
  test(
    'GET playback failure ' + status + ' never triggers an automatic ticket POST retry',
    async (t) => {
      const f = setup(t, descriptor());
      await f.hold();
      const pending = f.transcript('Синтетическая команда');
      await flush();
      f.played[0].gate.reject(Object.assign(Error('Synthetic audio failure'), { status }));
      await pending;
      await flush();
      assert.equal(f.calls.filter((c) => c.route === '/api/assistant/speak').length, 0);
      assert.equal(f.played.length, 1);
    },
  );
test('typed command does not opt into turn ticket', async (t) => {
  const f = setup(t, undefined);
  await f.keyboard();
  f.$('[data-assistant-text]').value = 'Синтетическая команда';
  f.$('[data-assistant-send]').click();
  await flush();
  assert.equal(f.turns()[0].body.speech, undefined);
});

test('foreign identity descriptor falls back before any GET', async (t) => {
  const ticket = descriptor();
  ticket.streamUrl = ticket.streamUrl.replace('accountContext=staff', 'accountContext=other');
  const f = setup(t, ticket);
  await f.hold();
  const pending = f.transcript('Синтетическая команда');
  await flush();
  assert.equal(f.calls.filter((c) => c.route === '/api/assistant/speak').length, 1);
  await f.finishSpeech();
  await pending;
});
test('same descriptor object cannot be consumed twice even when still unexpired', async (t) => {
  const f = setup(t, descriptor());
  await f.hold();
  let pending = f.transcript('Синтетическая команда');
  await flush();
  await f.finishSpeech();
  await pending;
  pending = f.transcript('Повторная синтетическая команда');
  await flush();
  assert.equal(f.calls.filter((c) => c.route === '/api/assistant/speak').length, 1);
  assert.equal(f.played.length, 2);
  assert.equal(f.played[1].result.streamUrl, undefined);
  await f.finishSpeech();
  await pending;
});

test('acknowledged semantic speech replay skips automatic POST and listens; explicit user playback remains available', async (t) => {
  const f = setup(t, undefined);
  f.control.turn = async () => ({
    ...reply(1),
    speechReplay: true,
    taskRequestId: 'synthetic-task',
    speechPermit: {
      token: 'p'.repeat(43),
      answerableText: 'Выберите услугу',
      readonlyText: 'Выберите услугу',
    },
  });
  await f.hold();
  await f.transcript('Синтетическая команда');
  await flush();
  assert.equal(f.calls.filter((c) => c.route === '/api/assistant/speak').length, 0);
  assert.equal(f.played.length, 0);
  assert.equal(f.captures.length, 2);
  f.$('[data-assistant-voice]').click();
  await flush();
  f.$('[data-assistant-speak]').click();
  await flush();
  assert.equal(f.calls.filter((c) => c.route === '/api/assistant/speak').length, 1);
  assert.equal(f.played.length, 1);
  await f.finishSpeech();
});
