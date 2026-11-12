const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { hints } = require('../src/server/modules/assistant/behavior/example-features.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { selectExamples } = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const { modelPayload, parseModelIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const { continuationPayload } = require('../src/server/modules/assistant/dialogue/continuation/continuation-prompt.cjs');
const {
  continuationExamples,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
const { parseContinuation } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const { intentEnvelope } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const {
  normalizeManagementRequest,
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const {
  createAppointmentExecution,
} = require('../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const current = require('../src/server/modules/assistant/behavior/scenarios/appointment-current-commands.json');
const clock = { date: '2026-10-18', hour: 9, minute: 0 };
function state(provider = 'timeweb') {
  const value = initialState();
  value.providers.llm.provider = provider;
  value.policy.exampleSelection = 'automatic';
  for (const key of Object.keys(value.policy.commands)) value.policy.commands[key] = true;
  return value;
}
const context = (step) => ({
  step,
  role: 'owner',
  clock,
  selected: {},
  missingFields: ['time'],
  options: [],
});

test('management requests select the actual action instead of unrelated phone changes or new bookings', () => {
  const value = state();
  for (const [text, intent] of [
    ['Измени запись.', 'moveAppointment'],
    ['Перенеси запись Анны на час позже', 'moveAppointment'],
    ['Перенеси запись Анны на час раньше', 'moveAppointment'],
    ['Отмени запись Морозовой', 'cancelAppointment'],
    ['Удали запись Морозовой', 'cancelAppointment'],
    ['Открой запись Ивановой', 'editAppointment'],
  ]) {
    assert.equal(hints(text).get(intent), 1.4, text);
    const selected = selectExamples(text, value.policy, { clock });
    assert.equal(
      selected.examples[0].expected.intent,
      intent,
      JSON.stringify({ text, selected: selected.metadata }),
    );
  }
});

test('negative and conditional actions do not acquire a supported management task hint', () => {
  const value = state();
  for (const text of [
    'Не переноси запись Анны',
    'Не отменяй запись Морозовой',
    'Не удаляй запись Морозовой',
    'Если свободно, удали запись Морозовой',
    'Если свободно, перенеси запись Анны',
    'Перенеси запись и отмени запись',
  ]) {
    const found = hints(text);
    for (const name of [
      'moveAppointment',
      'cancelAppointment',
      'editAppointment',
      'prepareAppointment',
    ])
      assert.equal(found.has(name), false, text + '/' + name);
    assert.ok(found.get('help') > 0, text);
    assert.equal(
      selectExamples(text, value.policy, { clock }).examples[0].expected.intent,
      'help',
      text,
    );
  }
});

test('current examples keep the exact initial wire schema and literal entity spans', () => {
  assert.deepEqual(
    current.map((row) => row.id).sort(),
    [
      'current-relative-source-service',
      'current-relative-source-staff',
      'current-keep-time-needs-date',
      'current-cancel-source-service',
      'current-move-source-service',
      'current-open-source-service',
      'current-open-appointments-day',
      'current-change-appointment',
      'current-open-appointment',
      'current-relative-move-hour',
      'current-noon-not-duration',
      'current-date-clock-first',
      'current-cancel-selected-appointment',
      'current-move-with-window-search',
      'current-move-morning-period',
      'current-move-source-partial-date',
      'current-cancel-source-staff-date',
    ].sort(),
  );
  for (const row of current) {
    const wire = intentEnvelope(row.current.intent);
    assert.deepEqual(parseModelIntent(JSON.stringify(wire)), row.current.intent);
    for (const field of ['query', 'staffQuery', 'serviceQuery'])
      if (wire[field]) assert.ok(row.text.includes(wire[field]), row.id + '/' + field);
    assert.equal(wire.duration, null);
  }
  const noon = current.find((row) => row.id === 'current-noon-not-duration');
  assert.equal(noon.current.intent.time, '12:00');
  const bare = intentEnvelope(
    current.find((row) => row.id === 'current-date-clock-first').current.intent,
  );
  assert.equal(bare.date, null);
  assert.equal(bare.time, '10:00');
  const relative = intentEnvelope(
    current.find((row) => row.id === 'current-relative-move-hour').current.intent,
  );
  assert.equal(relative.date, null);
  assert.equal(relative.time, null);
});

test('current deletion example parses only source coordinates; source choice still needs bound consent before soft cancellation', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(clock.date + 'T05:00:00Z'));
  const row = current.find((item) => item.id === 'current-cancel-selected-appointment');
  assert.ok(row);
  const parsed = parseModelIntent(JSON.stringify(intentEnvelope(row.current.intent)));
  assert.deepEqual(parsed, row.current.intent);
  assert.equal(parsed.query, 'Анны Ивановой');
  assert.equal(parsed.date, '2026-10-19');
  assert.equal(parsed.time, '18:00');
  assert.ok(row.text.includes(parsed.query));
  const grounded = prepareManagementIntent(parsed, row.text, clock);
  assert.deepEqual(grounded.intent, parsed);
  assert.equal(grounded.constraints.date, parsed.date);
  assert.equal(grounded.constraints.time, parsed.time);
  for (const extra of [{ question: 'Отменить?' }, { action: 'cancel' }, { consent: true }])
    assert.throws(() => parseModelIntent(JSON.stringify({ ...intentEnvelope(parsed), ...extra })), {
      status: 502,
    });

  const f = cancellationFixture(t);
  Object.assign(f.clock, clock);
  const store = f.storage.read();
  Object.assign(store.patients[0], { lastName: 'Иванова', name: 'Анна Иванова' });
  const selected = {
    ...structuredClone(f.source),
    id: randomUUID(),
    date: parsed.date,
    time: parsed.time,
  };
  const other = { ...structuredClone(selected), id: randomUUID(), time: '12:00' };
  store.patients[0].appointments.push(selected, other);
  f.storage.write(store);
  const before = structuredClone(f.storage.readSelected([f.patients[0].id]).patients[0]);
  const revision = f.storage.get('revision');
  const start = (intent, constraints) =>
    f.management.start(
      f.c,
      intent,
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
      constraints,
    );
  let reply = start(grounded.intent, grounded.constraints);
  assert.equal(reply.dialogue.phase, 'cancelConfirmation');
  assert.equal(reply.text, 'Отменить завтра в 18:00?');
  assert.equal(reply.action, null);

  const raw = 'Удалить запись Анны Ивановой';
  const initial = normalizeManagementRequest({ intent: 'help' }, raw, f.clock);
  reply = start(prepareManagementIntent(initial, raw, f.clock).intent);
  assert.equal(reply.dialogue.phase, 'appointmentChoice');
  assert.equal(reply.dialogue.options.length, 3);
  const entry = f.flow.get(f.c, f.member, f.state, reply.dialogue.id);
  const choice = [...entry.options].find(
    ([, option]) => option.value.appointmentId === selected.id,
  );
  assert.ok(choice);
  reply = f.management.continueDialogue(
    f.c,
    { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, choice: choice[0] },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(reply.dialogue.phase, 'cancelConfirmation');
  assert.equal(reply.text, 'Отменить завтра в 18:00?');
  assert.equal(reply.dialogue.options[0].label, 'Да, отменить');
  assert.equal(reply.action, null, 'choosing a real source is not cancellation consent');
  assert.deepEqual(f.storage.readSelected([f.patients[0].id]).patients[0], before);
  assert.equal(f.storage.get('revision'), revision);
  const api = createAppointmentExecution({
    ...f.options,
    now: () => Date.parse(clock.date + 'T05:00:00Z'),
  });
  await assert.rejects(
    api.execute(f.c, { executionId: reply.dialogue.id, policyVersion: f.state.revision }),
    { status: 409 },
  );
  const confirmation = {
    dialogueId: reply.dialogue.id,
    dialogueVersion: reply.dialogue.version,
    text: 'Да, удали',
  };
  reply = f.management.continueDialogue(f.c, confirmation, f.state, f.member, f.clock);
  assert.equal(reply.action.type, 'cancelAppointment');
  assert.equal(f.calls(), 0);
  const request = { executionId: reply.action.executionId, policyVersion: f.state.revision };
  const saved = await api.execute(f.c, request);
  assert.equal(saved.cancelled, true);
  assert.equal(saved.appointmentId, selected.id);
  const after = f.storage.readSelected([f.patients[0].id]).patients[0];
  assert.equal(after.appointments.length, before.appointments.length, 'history stays in storage');
  assert.equal(after.appointments.find((item) => item.id === selected.id).status, 'cancelled');
  for (const item of before.appointments)
    if (item.id !== selected.id)
      assert.deepEqual(
        after.appointments.find((value) => value.id === item.id),
        item,
      );
  const replay = await api.execute(f.c, request);
  assert.equal(replay.alreadySaved, true);
  assert.equal(replay.cancelled, true);
  assert.equal(f.calls(), 1, 'replay never repeats cancellation');
});

test('retrieval ACL and byte budgets still apply to all current management examples', () => {
  const value = state();
  for (const text of [
    'Измени запись',
    'Перенеси запись Анны на час позже',
    'Отмени запись',
    'Удали запись',
    'Открой запись Ивановой',
  ]) {
    const before = structuredClone(value);
    const disabled = selectExamples(
      text,
      { ...value.policy, commands: { calendar: true, clients: true, prepareAppointment: false } },
      { clock },
    );
    assert.ok(
      disabled.examples.every(
        (row) =>
          ![
            'moveAppointment',
            'cancelAppointment',
            'editAppointment',
            'prepareAppointment',
          ].includes(row.expected.intent),
      ),
    );
    const packed = selectExamples(text, value.policy, { clock, maxWireBytes: 450 });
    assert.ok(
      Buffer.byteLength(JSON.stringify(JSON.stringify(packed.examples)), 'utf8') - 2 <= 450,
    );
    const empty = selectExamples(text, value.policy, { clock, maxWireBytes: 0 });
    assert.deepEqual(empty.examples, []);
    assert.deepEqual(value, before);
  }
});

test('continuation examples omit unrelated zero-overlap fillers but retain relevant safety and schema', () => {
  const unknown = continuationExamples('абракадабра', context('staff'));
  assert.equal(unknown.examples.length, 1);
  assert.equal(unknown.examples[0].expected.operation, 'clarify');
  assert.deepEqual(
    unknown.metadata.selected.map((row) => row.id),
    ['dialogue-no-input'],
  );
  const safety = continuationExamples(
    'Сохрани запись и отправь клиенту сообщение',
    context('time'),
  );
  assert.ok(safety.metadata.selected.some((row) => row.id === 'follow-unsupported-save'));
  for (const step of ['client', 'staff', 'service', 'date', 'time', 'duration', 'review']) {
    const built = continuationExamples('На девятнадцатое на десять утра', context(step));
    assert.ok(built.examples.length > 0 && built.examples.length <= 6);
    assert.ok(built.metadata.bytes <= 4096);
    for (const example of built.examples) parseContinuation(JSON.stringify(example.expected));
  }
});

test('both prompt stages keep server responsibilities and composed clock context without adding actions or questions', () => {
  for (const provider of ['timeweb', 'codex']) {
    const value = state(provider);
    for (const text of [
      'На девятнадцатое на десять утра запиши Анну Иванову на консультацию',
      'Запиши Анну Иванову на консультацию на завтра на двенадцать часов',
      'Консультацию Анне Ивановой завтра в 12:00',
    ]) {
      const built = modelPayload(text, value, 'Europe/Moscow');
      assert.deepEqual(
        built.payload.messages.map((row) => row.role),
        ['system', 'user'],
      );
      assert.equal(built.payload.messages[1].content, text);
      assert.match(built.payload.messages[0].content, /сдвиг вычисляет сервер/u);
      assert.match(
        built.payload.messages[0].content,
        /Этот intent и выбор приёма не являются согласием или исполнением/u,
      );
      assert.match(
        built.payload.messages[0].content,
        /Модель не возвращает вопрос, action, ID или согласие/u,
      );
      assert.match(
        built.payload.messages[0].content,
        /завтра на два часа тридцать минут.*time14:30,duration=null/u,
      );
      assert.match(
        built.payload.messages[0].content,
        /завтра с14до17 на один час двадцать минут.*time=null,duration80/u,
      );
      assert.ok(
        Buffer.byteLength(JSON.stringify({ messages: built.payload.messages }) + '\n') <= 32768,
      );
    }
    const built = continuationPayload(
      'Завтра на два часа тридцать минут',
      value,
      context('time'),
      'Europe/Moscow',
    );
    assert.match(built.payload.messages[0].content, /ответе о времени.*time14:30,duration=null/u);
    assert.match(built.payload.messages[0].content, /сервер сам выполняет разрешённое действие/u);
    assert.match(
      built.payload.messages[0].content,
      /cancel — остановить текущий черновик, не отменить существующий приём/u,
    );
    assert.equal(built.payload.messages[1].content, 'Завтра на два часа тридцать минут');
  }
});
