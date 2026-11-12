const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const fields = () => ({
  client: null,
  staff: null,
  service: null,
  date: null,
  time: null,
  duration: null,
});
const clarify = (field) => ({ operation: 'clarify', fields: fields(), choice: null, field });
function fixture(t, { step = 'client', query, ambiguous = false, services } = {}) {
  const base = dialogueFixture({ ambiguous });
  if (services)
    base.services.splice(
      0,
      base.services.length,
      ...services.map((name, index) => ({
        id: 'service-' + index,
        name,
        duration: 30,
        staffId: 'owner',
      })),
    );
  const store = base.c.tenantStore('org');
  let writes = 0,
    result,
    last;
  store.save = store.write = () => {
    writes++;
    throw Error('Save is forbidden');
  };
  result = base.flow.start(
    base.c,
    {
      intent: 'prepareAppointment',
      query:
        query ??
        (step === 'client' ? (ambiguous ? 'Семёнова' : 'Несуществующаяфамилия') : 'Анна Семёнова'),
      serviceQuery: step === 'client' ? 'Чистка' : services ? 'Чистка' : 'Несуществующаяуслуга',
      date: day,
      time: '10:00',
      duration: 45,
    },
    base.state,
    base.member,
    base.clock,
    base.flow.beginCommand(base.c, base.member, base.state),
  );
  const entry = () => base.flow.get(base.c, base.member, base.state, result.dialogue.id);
  const body = (operation) => ({
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    policyVersion: base.state.revision,
    ...operation,
  });
  const f = {
    ...base,
    entry,
    answer(operation) {
      last = body(operation);
      result = base.flow.continueDialogue(base.c, last, base.state, base.member, base.clock);
      return result;
    },
    text(text) {
      return f.answer({ text });
    },
    model(text) {
      last = body({ text });
      const snapshot = base.flow.prepareModelTurn(
        base.c,
        last,
        base.state,
        base.member,
        base.clock,
      );
      assert.ok(snapshot);
      result = base.flow.applyModelTurn(
        base.c,
        last,
        base.state,
        base.member,
        base.clock,
        clarify(step),
        snapshot,
      );
      return result;
    },
    replay() {
      return base.flow.continueDialogue(base.c, last, base.state, base.member, base.clock);
    },
    noSave() {
      assert.equal(writes, 0);
      assert.ok(base.patients.every((row) => row.appointments.length === 0));
    },
  };
  Object.defineProperty(f, 'result', { get: () => result });
  t.after(() => f.noSave());
  return f;
}
const known = (f) => {
  const {
    patient,
    staff,
    service,
    serviceChosen,
    date,
    time,
    timeWindow,
    duration,
    durationSource,
  } = f.entry().data;
  return {
    patient,
    staff,
    service,
    serviceChosen,
    date,
    time,
    timeWindow,
    duration,
    durationSource,
  };
};
const semanticOptions = (f) =>
  [...f.entry().options.values()].map((row) => JSON.stringify(row)).sort();
const failures = (f, answer = 'Несуществующаяфамилия') => {
  for (let i = 0; i < 3; i++) f.text(answer);
};
const clientFailure = 'Не удалось уточнить клиента. Проверьте имя или телефон.';
const clientChoices = 'Не удалось уточнить клиента. Выберите его на экране.';
const serviceFailure = 'Не удалось уточнить услугу. Проверьте название.';
const serviceChoices = 'Не удалось уточнить услугу. Выберите её на экране.';

test('initial client questions distinguish an empty query from an unsuccessful lookup without reciting card-creation rules', (t) => {
  const empty = fixture(t, { query: '' });
  assert.equal(empty.result.dialogue.prompt, 'Как зовут клиента?');
  const unknown = fixture(t);
  assert.equal(unknown.result.dialogue.prompt, 'Клиент не найден. Уточните имя или телефон.');
  assert.doesNotMatch(unknown.result.text, /Новые карточки|вручную/iu);
  assert.equal(unknown.result.dialogue.manualInputRequired, undefined);
});

test('third unresolved client answer requests manual input while retaining the draft and bounded private state', (t) => {
  const f = fixture(t),
    before = structuredClone(known(f)),
    options = semanticOptions(f);
  f.text('Несуществующаяфамилия');
  f.text('Сложнаяфамилия');
  assert.equal(f.result.dialogue.prompt, 'Назовите полное имя или телефон клиента.');
  assert.equal(f.result.dialogue.manualInputRequired, undefined);
  f.text('Инаяфамилия');
  assert.equal(f.result.dialogue.prompt, clientFailure);
  assert.equal(f.result.text, clientFailure);
  assert.equal(f.result.dialogue.manualInputRequired, true);
  assert.equal(f.entry().data._clarificationRecovery.count, 3);
  assert.deepEqual(known(f), before);
  assert.deepEqual(semanticOptions(f), options);
  assert.equal(f.result.action, null);
  for (let i = 0; i < 3; i++) f.text('Ещефамилия');
  assert.equal(f.entry().data._clarificationRecovery.count, 3);
  assert.equal(JSON.stringify(f.result).includes('_clarificationRecovery'), false);
});

test('ambiguous clients remain visible after terminal recovery and their current choice can still prepare a form', (t) => {
  const f = fixture(t, { ambiguous: true }),
    before = structuredClone(known(f)),
    options = semanticOptions(f);
  failures(f, 'Семёнова');
  assert.equal(f.result.dialogue.prompt, clientChoices);
  assert.doesNotMatch(f.result.text, /не найден/iu);
  assert.equal(f.result.dialogue.manualInputRequired, true);
  assert.deepEqual(semanticOptions(f), options);
  assert.deepEqual(known(f), before);
  const replay = structuredClone(f.result);
  assert.deepEqual(f.replay(), replay);
  const chosen = [...f.entry().options].find(([, row]) => row.value === f.patients[0].id);
  f.answer({ choice: chosen[0] });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.dialogue.manualInputRequired, undefined);
  f.text('открой форму');
  assert.equal(f.result.action.type, 'prepareAppointment');
  assert.equal(f.result.action.patientId, f.patients[0].id);
  assert.equal(f.result.action.time, '10:00');
  assert.equal(f.result.action.duration, 45);
});

test('a client overflow is never falsely called not-found when automatic questioning stops', (t) => {
  const f = fixture(t, { ambiguous: true });
  for (let i = 0; i < 60; i++)
    f.patients.push({
      ...f.patients[0],
      id: 'overflow-client-' + i,
      name: 'Мария Семёнова',
      firstName: 'Мария',
      appointments: [],
    });
  f.changed();
  f.text('Семёнова');
  assert.equal(f.result.dialogue.options.length, 0);
  failures(f, 'Семёнова');
  assert.equal(f.result.dialogue.manualInputRequired, true);
  assert.equal(f.result.dialogue.prompt, clientFailure);
  assert.doesNotMatch(f.result.text, /не найден/iu);
  assert.equal(f.result.action, null);
});

test('service no-hit stops after three failures and a later exact text answer continues the same draft', (t) => {
  const f = fixture(t, { step: 'service' }),
    before = structuredClone(known(f));
  failures(f, 'Несуществующаяуслуга');
  assert.equal(f.result.dialogue.prompt, serviceFailure);
  assert.equal(f.result.dialogue.manualInputRequired, true);
  assert.deepEqual(known(f), before);
  f.text('Чистка');
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.dialogue.manualInputRequired, undefined);
  assert.equal(f.entry().data.patient.id, before.patient.id);
  assert.equal(f.entry().data.duration, before.duration);
  assert.equal(f.entry().data.time, before.time);
});

test('real service candidates survive manual recovery without an automatic first selection', (t) => {
  const f = fixture(t, { step: 'service', services: ['Чистка лица', 'Чистка спины'] }),
    before = structuredClone(known(f)),
    options = semanticOptions(f);
  for (let i = 0; i < 3; i++) f.model('Нужна похожаяпроцедура');
  assert.equal(f.result.dialogue.prompt, serviceChoices);
  assert.equal(f.result.dialogue.manualInputRequired, true);
  assert.deepEqual(semanticOptions(f), options);
  assert.deepEqual(known(f), before);
  assert.equal(f.entry().data.service, null);
  assert.equal(f.result.action, null);
});

test('help repeat empty input and replay do not prematurely request manual input and explicit edit clears the flag', (t) => {
  const f = fixture(t);
  f.text('Несуществующаяфамилия');
  f.text('повтори');
  assert.throws(() => f.text(''), { status: 400 });
  f.model('помоги');
  assert.equal(f.entry().data._clarificationRecovery.count, 1);
  assert.equal(f.result.dialogue.manualInputRequired, undefined);
  f.text('Другаяфамилия');
  assert.equal(f.result.dialogue.manualInputRequired, undefined);
  const before = structuredClone(f.result);
  assert.deepEqual(f.replay(), before);
  f.text('Инаяфамилия');
  assert.equal(f.result.dialogue.manualInputRequired, true);
  const saved = structuredClone(known(f));
  f.answer({ edit: 'client' });
  assert.equal(f.result.dialogue.manualInputRequired, undefined);
  assert.equal(f.entry().data._clarificationRecovery, undefined);
  assert.deepEqual(known(f), saved);
});

function speech(t) {
  const state = {
    assistantGeneration: 0,
    assistantScope: {
      limits: { maxAudioSeconds: 30 },
      capabilities: { stt: { ready: true, demo: false }, tts: { ready: true } },
    },
  };
  const seen = {
    requests: [],
    captures: 0,
    opened: 0,
    sent: [],
    busy: false,
    recording: false,
    barges: 0,
    voices: [],
  };
  const ui = {
    valid: () => true,
    session: 1,
    input: () => ({ value: '' }),
    get busy() {
      return seen.busy;
    },
    get recording() {
      return seen.recording;
    },
    activity(busy, recording) {
      seen.busy = busy;
      seen.recording = recording;
    },
    status() {},
    voiceState(value) {
      seen.voices.push(value);
    },
    request: async (route, body) => {
      seen.requests.push({ route, body });
      return route.endsWith('/transcribe')
        ? { text: 'Синтетический ответ' }
        : { audioBase64: 'synthetic' };
    },
    sendText: async (text) => seen.sent.push(text),
    openResult: async () => {
      seen.opened++;
    },
  };
  const root = path.resolve(__dirname, '..'),
    source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
  const actions = {
    startAssistantCapture: async (complete) => {
      seen.complete = complete;
      seen.captures++;
      return true;
    },
    stopAssistantCapture() {},
    stopAssistantAudio() {},
    stopAssistantBargeIn() {},
    startAssistantBargeIn: async () => {
      seen.barges++;
      return false;
    },
    playAssistantAudio: async () => true,
    assistantLocalVoiceReady: async () => true,
    ...vm.runInNewContext(
      source('src/client/modules/assistant-speech-text.js') + '\ncreateAssistantSpeechText',
      {},
    )(),
  };
  const controller = vm
    .runInNewContext(
      source('src/client/modules/assistant-speech.js') + '\ncreateAssistantSpeech',
      {},
    )(state, actions)
    .assistantSpeechController(ui);
  t.after(() => controller.stopVoice());
  return { seen, controller };
}
const terminalReply = (step, prompt, manualInputRequired = true) => ({
  text: prompt,
  action: null,
  dialogue: {
    id: 'same-draft',
    version: 4,
    step,
    phase: step === 'client' ? 'clientChoice' : 'serviceChoice',
    prompt,
    manualInputRequired,
    fields: [
      { key: 'date', value: day },
      { key: 'time', value: '10:00' },
    ],
    options: [{ id: 'same-current-choice', label: 'Текущий синтетический вариант' }],
  },
});

test('manual recovery is spoken once without barge-in or another automatic capture and leaves the DTO intact', async (t) => {
  for (const step of ['client', 'service']) {
    const f = speech(t);
    await f.controller.startVoice();
    await f.seen.complete('synthetic-wav', {
      autoStopped: true,
      seconds: 2,
      stopReason: 'silence',
    });
    const captures = f.seen.captures,
      sent = [...f.seen.sent],
      reply = terminalReply(step, step === 'client' ? clientChoices : serviceChoices),
      before = JSON.stringify(reply);
    await f.controller.afterReply(reply);
    assert.equal(f.controller.voiceEnabled, false);
    assert.equal(f.seen.captures, captures);
    assert.equal(f.seen.barges, 0);
    assert.equal(f.seen.opened, 0);
    assert.deepEqual(f.seen.sent, sent);
    assert.equal(JSON.stringify(reply), before);
    assert.equal(f.seen.requests.filter((row) => row.route.endsWith('/speak')).length, 1);
    assert.equal(f.seen.requests.find((row) => row.route.endsWith('/speak')).body.text, reply.text);
    await f.controller.afterReply(reply);
    assert.equal(f.seen.requests.filter((row) => row.route.endsWith('/speak')).length, 1);
  }
});

test('ordinary questions with no manual flag keep the current automatic dialogue behavior', async (t) => {
  const f = speech(t);
  await f.controller.startVoice();
  await f.seen.complete('synthetic-wav', { autoStopped: true, seconds: 2, stopReason: 'silence' });
  const captures = f.seen.captures;
  await f.controller.afterReply(terminalReply('client', 'Это Анна Семёнова?', false));
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.seen.captures, captures + 1);
  assert.equal(f.seen.opened, 0);
});
