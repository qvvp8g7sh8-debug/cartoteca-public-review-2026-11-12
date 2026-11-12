const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');

function step(version, kind, options = []) {
  return {
    policyVersion: 1,
    demo: false,
    text: kind === 'date' ? 'На какую дату?' : 'Уточните выбор',
    action: null,
    dialogue: {
      id: 'synthetic-click-dialogue',
      version,
      step: kind,
      prompt: kind === 'date' ? 'На какую дату?' : 'Уточните выбор',
      input: { type: 'text', field: kind },
      options,
      fields: [{ key: 'client', label: 'Клиент', value: 'Анна Синтетическая' }],
      canEdit: ['client'],
    },
  };
}

test('clicking an offered choice during its question interrupts audio and continues the same voice dialogue', async (t) => {
  for (const kind of ['client', 'service', 'staff', 'availability']) {
    const f = fixture(t);
    let turns = 0;
    f.control.turn = async () => ++turns === 1
      ? step(1, kind, [{ id: 'opaque-' + kind, label: 'Синтетический выбор' }])
      : step(2, 'date');
    await f.hold();
    const first = f.transcript('Подготовь синтетическую запись');
    await flush();
    const oldAudio = f.played.at(-1);
    const button = f.$('[data-assistant-picker="' + kind + '"] [data-assistant-choice]');
    assert.equal(button.disabled, false, kind + ': selection must work during the question');
    button.click();
    await flush();
    assert.equal(await oldAudio.gate.promise, false, kind + ': previous question stopped');
    const requests = f.turns();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, {
      dialogueId: 'synthetic-click-dialogue',
      dialogueVersion: 1,
      choice: 'opaque-' + kind,
      policyVersion: 1,
    });
    await f.finishSpeech();
    await first;
    assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.captures.length, 2, 'next answer is listened to automatically');
    assert.equal(f.$('.voice-assistant-session').hidden, false);
    assert.equal(f.$('.voice-assistant-dialog').open, false);
    assert.deepEqual(f.opened, []);
  }
});

test('manual client choice invalidates an old transcription without leaving voice mode or sending its late text', async (t) => {
  const f = fixture(t);
  let turns = 0;
  f.control.turn = async () => ++turns === 1
    ? step(1, 'client', [{ id: 'opaque-client', label: 'Анна Синтетическая' }])
    : step(2, 'date');
  await f.hold();
  const first = f.transcript('Подготовь запись');
  await flush();
  await f.finishSpeech();
  await first;
  const transcription = deferred();
  f.control.stt = () => transcription.promise;
  const oldInput = f.captures.at(-1).complete('synthetic-old-audio');
  await flush();
  const button = f.$('[data-assistant-picker="client"] [data-assistant-choice]');
  assert.equal(button.disabled, false);
  button.click();
  await flush();
  const selected = f.turns().at(-1).body;
  assert.equal(selected.choice, 'opaque-client');
  transcription.resolve({ text: 'Запоздалая другая фамилия', policyVersion: 1 });
  await oldInput;
  await flush();
  assert.equal(f.turns().length, 2);
  await f.finishSpeech();
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.captures.length, 3);
  assert.equal(f.calls.filter(c => c.route.endsWith('/execute')).length, 0);
});

test('a pending choice turn blocks double clicks and stale detached choices without stopping the next question', async (t) => {
  const f = fixture(t);
  const response = deferred();
  let turns = 0;
  f.control.turn = async () => ++turns === 1
    ? step(1, 'client', [{ id: 'opaque-client', label: 'Анна Синтетическая' }])
    : response.promise;
  await f.hold();
  const first = f.transcript('Подготовь запись');
  await flush();
  await f.finishSpeech();
  await first;
  const stale = f.$('[data-assistant-picker="client"] [data-assistant-choice]');
  stale.click();
  stale.click();
  await flush();
  assert.equal(f.turns().length, 2);
  response.resolve(step(2, 'service', [{ id: 'opaque-service', label: 'Консультация' }]));
  await flush();
  const nextAudio = f.played.at(-1);
  stale.click();
  await flush();
  assert.equal(f.played.at(-1), nextAudio);
  assert.equal(f.turns().length, 2);
  await f.finishSpeech();
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.captures.length, 3);
  assert.equal(f.calls.filter(c => c.route.endsWith('/execute')).length, 0);
});
