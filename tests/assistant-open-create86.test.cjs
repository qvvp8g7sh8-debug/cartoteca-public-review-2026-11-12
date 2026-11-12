const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createDialogueStore,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const {
  createClientCardFlow,
} = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const {
  continuationExamples,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  clientCorrectionQuery,
  isClientCorrectionQuery,
} = require('../src/server/modules/assistant/dialogue/client-correction.cjs');

function cardFixture({ role = 'owner' } = {}) {
  const f = dialogueFixture({ ambiguous: true, role });
  f.state.policy.commands.clients = true;
  const memory = createDialogueStore();
  const cards = createClientCardFlow({ memory });
  let result;
  return {
    ...f,
    memory,
    cards,
    start(query = 'Семёновой') {
      result = cards.start(
        f.c,
        { intent: 'clientCard', query },
        f.state,
        f.member,
        f.clock,
        memory.beginCommand(f.c, f.member, f.state),
      );
      return result;
    },
    answer(input) {
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        ...input,
      };
      result = cards.continueDialogue(f.c, body, f.state, f.member, f.clock);
      return { result, body };
    },
    get result() {
      return result;
    },
  };
}
const corrections = [
  'Измени клиента на Ольгу Семёнову',
  'Клиента поменяй на Ольгу Семёнову',
  'Нет, клиент Ольга Семёнова',
  'Нет, Ольга Семёнова',
  'Не Анна, а Ольга Семёнова',
  'Нет, не Анна Семёнова, а Ольга Семёнова',
];
for (const text of corrections)
  test(
    'card correction consumes the whole final identity without repeating an empty question: ' +
      text,
    () => {
      const f = cardFixture();
      f.start();
      const before = JSON.stringify(f.patients);
      const { result, body } = f.answer({ text });
      assert.deepEqual(result.action, { type: 'clientCard', patientId: f.patients[1].id });
      assert.equal(result.dialogue, null);
      assert.equal(JSON.stringify(f.patients), before);
      assert.deepEqual(
        f.cards.continueDialogue(f.c, body, f.state, f.member, f.clock),
        result,
        'replay opens the same identity without a new choice',
      );
    },
  );

for (const text of corrections)
  test(
    'create client clarification preserves service, date, time and catalog length: ' + text,
    () => {
      const f = dialogueFixture({ ambiguous: true });
      const first = f.start(
        { query: 'Семёнова', serviceQuery: 'Чистка', date: day, time: '10:00' },
        { openWhenComplete: true },
      );
      assert.equal(first.dialogue.step, 'client');
      assert.ok(first.dialogue.options.length >= 2);
      const before = JSON.stringify(f.patients);
      const { result } = f.answer({ text });
      assert.equal(result.action?.type, 'prepareAppointment');
      assert.equal(result.action.patientId, f.patients[1].id);
      assert.equal(result.action.date, day);
      assert.equal(result.action.time, '10:00');
      assert.deepEqual(result.action.serviceIds, ['clean']);
      assert.equal(result.action.duration, 30);
      assert.equal(JSON.stringify(f.patients), before);
    },
  );

test('card correction retains ambiguity for the fresh query and invalidates old opaque choices', () => {
  const f = cardFixture();
  f.patients.push({
    ...f.patients[1],
    id: 'synthetic-third-semenova',
    middleName: 'Петровна',
    name: 'Ольга Петровна Семёнова',
  });
  const first = f.start();
  const oldChoice = first.dialogue.options[0].id;
  const { result } = f.answer({ text: 'Измени клиента на Ольгу Семёнову' });
  assert.equal(result.action, null);
  assert.equal(result.dialogue.options.length, 2);
  const entry = f.memory.get(f.c, f.member, f.state, result.dialogue.id);
  assert.equal(entry.data.clientQuery, 'Ольгу Семёнову');
  assert.throws(() => f.answer({ choice: oldChoice }), { status: 409 });
  assert.equal(f.result.dialogue.version, result.dialogue.version);
  assert.equal(
    f.answer({ choice: result.dialogue.options[1].id }).result.action.patientId,
    'synthetic-third-semenova',
  );
});

test('fresh card correction never crosses employee client scope', () => {
  const f = cardFixture({ role: 'cosmetologist' });
  f.patients[1].createdBy = 'another-specialist';
  f.start('Несуществующая');
  const { result } = f.answer({ text: 'Измени клиента на Ольгу Семёнову' });
  assert.equal(result.action, null);
  const entry = f.memory.get(f.c, f.member, f.state, result.dialogue.id);
  assert.ok([...entry.options.values()].every((row) => row.value !== f.patients[1].id));
  assert.equal(entry.data.patient, null);
});

test('client edits without a new identity reset only the client and retain the create draft', () => {
  for (const text of ['другой клиент', 'измени клиента']) {
    const f = dialogueFixture();
    const first = f.start({
      query: 'Анна Семёнова',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    });
    assert.equal(first.dialogue.step, 'review');
    const { result } = f.answer({ text });
    const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
    assert.equal(result.dialogue.step, 'client');
    assert.equal(entry.data.patient, null);
    assert.equal(entry.data.date, day);
    assert.equal(entry.data.time, '10:00');
    assert.equal(entry.data.service.id, 'clean');
    assert.equal(entry.data.duration, 30);
  }
});

test('a non-client repair cannot become a client solely because it has the same negative grammar', () => {
  const f = dialogueFixture();
  const first = f.start({ query: 'Анна Семёнова', date: day, time: '10:00' });
  assert.equal(first.dialogue.step, 'service');
  const { result } = f.answer({ text: 'Не чистка, а массаж' });
  assert.equal(result.action, null);
  const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  assert.equal(entry.data.patient.id, f.patients[0].id);
  assert.equal(entry.data.clientQuery, 'Анна Семёнова');
  assert.equal(entry.data.date, day);
  assert.equal(entry.data.time, '10:00');
});

test('client correction grammar does not consume dates, commands, alternatives or second clauses', () => {
  for (const text of [
    'Измени клиента на Ольгу завтра',
    'Нет, Ольга или Анна',
    'Не Анна, а Ольга и отмени запись',
    'Не Анна, а Ольга на завтра',
    'Нет, если Ольга',
    'Измени клиента на Ольгу. Услугу поменяй на чистку',
    'Нет, завтра в 12:00',
    'Нет, не Анна, а Ольга или Ирина',
    'Не Анна или Ольга, а Ирина',
  ])
    assert.equal(clientCorrectionQuery(text, { allowBareCorrection: true }), null, text);
  assert.equal(
    clientCorrectionQuery('Нет, Ольга Семёнова'),
    null,
    'bare correction needs explicit client scope',
  );
  assert.deepEqual(clientCorrectionQuery('Не Анна, а Ольга Семёнова'), { query: 'Ольга Семёнова' });
  assert.equal(isClientCorrectionQuery('Ольга Семёнова'), true);
  assert.equal(isClientCorrectionQuery('завтра'), false);
});

const proposal = (fields) => ({
  operation: 'patch',
  fields: {
    client: null,
    staff: null,
    service: null,
    date: null,
    time: null,
    duration: null,
    ...fields,
  },
  choice: null,
  field: null,
});
for (const text of [
  'Клиента поменяй на Ольгу Семёнову на сегодня в 16:00',
  'Поменяй клиента на Ольгу Семёнову на сегодня в 16:00',
  'Нет, клиент Ольга Семёнова, давайте сегодня в 16:00',
])
  test(
    'a composite client correction reaches model extraction and is applied atomically: ' + text,
    () => {
      const f = dialogueFixture({ ambiguous: true });
      const first = f.start({
        query: 'Анна Семёнова',
        serviceQuery: 'Чистка',
        date: day,
        time: '10:00',
      });
      const before = JSON.stringify(f.patients);
      const body = { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot, 'a composite correction must not be swallowed by a one-name local patch');
      const result = f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal({
          client: text.includes('Ольга') ? 'Ольга Семёнова' : 'Ольгу Семёнову',
          date: day,
          time: '16:00',
        }),
        snapshot,
      );
      const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
      assert.equal(entry.data.patient?.id, f.patients[1].id);
      assert.equal(entry.data.date, day);
      assert.equal(entry.data.time, '16:00');
      assert.equal(entry.data.service.id, 'clean');
      assert.equal(entry.data.duration, 30);
      assert.equal(result.dialogue.step, 'review');
      assert.equal(JSON.stringify(f.patients), before);
    },
  );

function permutations(values) {
  return values.length < 2
    ? [values]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, i) => i !== index)).map((tail) => [value, ...tail]),
      );
}
for (const phrases of permutations([
  'клиент Анна Семёнова',
  'услуга Чистка',
  'дата сегодня',
  'время 10:00',
]))
  test('complete create fields resolve in any whole-clause order: ' + phrases.join('; '), () => {
    const f = dialogueFixture({ ambiguous: true });
    const first = f.start({ query: 'Несуществующая' }, { openWhenComplete: true });
    const body = {
      dialogueId: first.dialogue.id,
      dialogueVersion: first.dialogue.version,
      text: phrases.join('; '),
    };
    const before = JSON.stringify(f.patients);
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    const result = snapshot
      ? f.flow.applyModelTurn(
          f.c,
          body,
          f.state,
          f.member,
          f.clock,
          proposal({ client: 'Анна Семёнова', service: 'Чистка', date: day, time: '10:00' }),
          snapshot,
        )
      : f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    assert.equal(result.action?.type, 'prepareAppointment');
    assert.equal(result.action.patientId, f.patients[0].id);
    assert.equal(result.action.date, day);
    assert.equal(result.action.time, '10:00');
    assert.equal(result.action.duration, 30);
    assert.deepEqual(result.action.serviceIds, ['clean']);
    assert.equal(JSON.stringify(f.patients), before);
  });

test('labelled correction acknowledgement never removes inner denial, alternatives, conditions or preserved-field guards', () => {
  for (const text of [
    'Нет, клиент не Ольга Семёнова, дата сегодня, время 16:00',
    'Нет, клиент Ольга Семёнова или Анна Семёнова, дата сегодня',
    'Нет, клиент Ольга Семёнова, если сегодня свободно',
    'Я хочу: клиент Ольга Семёнова. Услугу не меняй.',
  ]) {
    const f = dialogueFixture({ ambiguous: true });
    const first = f.start({
      query: 'Анна Семёнова',
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
    });
    const body = { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text };
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    assert.ok(snapshot, text);
    const fields = { client: 'Ольга Семёнова' };
    if (text.includes('не меняй')) fields.service = 'Чистка';
    const result = f.flow.applyModelTurn(
      f.c,
      body,
      f.state,
      f.member,
      f.clock,
      proposal(fields),
      snapshot,
    );
    const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
    assert.equal(result.action, null, text);
    assert.equal(entry.data.patient?.id, f.patients[0].id, text);
    assert.equal(entry.data.service.id, 'clean', text);
    assert.equal(entry.data.date, day, text);
  }
});

test('opening a real existing appointment uses spoken date and clock as source filters and never prepares a move', (t) => {
  const f = moveExecutionFixture(t, {
    enabled: false,
    targetDate: null,
    targetTime: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
      f.addBooking({ date: '2099-01-06', time: '10:00' });
    },
  });
  const raw = 'Открой запись Анны Семёновой на сегодня в 10:00';
  const prepared = prepareManagementIntent(
    { intent: 'editAppointment', query: 'Анны Семёновой', date: day, time: '10:00' },
    raw,
    f.clock,
  );
  const before = structuredClone(f.rows());
  const result = f.start(prepared.intent, prepared.constraints);
  assert.equal(result.action?.type, 'appointmentPreview');
  assert.equal(result.action.operation, 'edit');
  assert.equal(result.action.appointmentId, before[0].id);
  assert.equal(result.dialogue, null);
  assert.deepEqual(f.rows(), before);
  assert.equal(f.calls(), 0);
});

test('raw labelled entity alternatives preserve independent temporal proof even if the model omits or truncates them', () => {
  const clock = { date: day, hour: 8, minute: 0 };
  for (const [label, field, value] of [
    ['клиент', 'query', 'Ольга Семёнова'],
    ['пациент', 'query', 'Ольга Семёнова'],
    ['сотрудник', 'staffQuery', 'Ольга Семёнова'],
    ['специалист', 'staffQuery', 'Ольга Семёнова'],
  ])
    for (const query of [undefined, value])
      for (const raw of [
        `${label} Ольга Семёнова или Анна Семёнова, на завтра в 16:00`,
        `на завтра в 16:00, ${label} Ольга Семёнова или Анна Семёнова`,
      ]) {
        const proof = bookingTemporalConstraints(
          { intent: 'prepareAppointment', [field]: query },
          raw,
          clock,
        );
        assert.equal(proof.date, '2099-01-06', raw);
        assert.equal(proof.time, '16:00', raw);
      }
  for (const raw of [
    'клиент Ольга или Анна, сегодня или завтра в 16:00',
    'клиент Ольга или Анна, завтра в 16:00 или 17:00',
    'клиент завтра или сегодня, в 16:00',
  ]) {
    const proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, raw, clock);
    assert.ok(proof.date === null || proof.time === null, raw);
  }
});

test('a sole ready control is never a client identity and unknown spoken phone tails preserve the active choices and draft', () => {
  const f = dialogueFixture({ ambiguous: true });
  f.patients[1].firstName = 'Анна';
  f.patients[1].name = 'Анна Семёнова';
  const first = f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'Чистка',
    date: day,
    time: '10:00',
  });
  assert.equal(first.dialogue.step, 'client');
  const { result } = f.answer({ text: '9999' });
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'client');
  const pending = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  assert.equal(pending.options.size, 2);
  assert.equal(pending.data.patient, null);
  assert.equal(pending.data.date, day);
  assert.equal(pending.data.time, '10:00');
  const chosen = f.answer({ text: '2233' }).result;
  assert.equal(chosen.dialogue.step, 'review');
  const body = {
    dialogueId: chosen.dialogue.id,
    dialogueVersion: chosen.dialogue.version,
    text: 'Я хотел бы уточнить данные',
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.ok(snapshot);
  assert.equal(snapshot.context.options.length, 1);
  assert.equal(snapshot.context.options[0].kind, 'ready');
  const wire = JSON.stringify(snapshot.context);
  for (const patient of f.patients) {
    assert.equal(wire.includes(patient.id), false);
    assert.equal(wire.includes(patient.phone), false);
  }
  const unchanged = f.flow.applyModelTurn(
    f.c,
    body,
    f.state,
    f.member,
    f.clock,
    { operation: 'choice', fields: proposal({}).fields, choice: 1, field: null },
    snapshot,
  );
  assert.equal(unchanged.action, null, 'a model cannot turn unrelated speech into a ready choice');
});

test('composite client examples are selected by actual create context and accepted by the source and temporal guards', () => {
  for (const [text, client, date] of [
    ['Клиента поменяй на Ольгу Семёнову на сегодня в 16:00', 'Ольгу Семёнову', '2026-10-15'],
    ['Нет, клиент Ольга Семёнова, давайте завтра в 16:00', 'Ольга Семёнова', '2026-10-16'],
  ])
    for (const step of ['client', 'time', 'review']) {
      const context = {
        step,
        role: 'owner',
        selected: { date: null, time: null },
        missingFields: step === 'review' ? [] : [step],
        options: [],
      };
      const selected = continuationExamples(text, context);
      const example = selected.examples.find((row) => row.text === text);
      assert.ok(example, step + ': ' + text);
      assert.ok(selected.metadata.bytes <= 4096);
      assert.ok(selected.examples.length <= 6);
      const entry = { step, options: new Map(), data: {} };
      const parsed = continuationOperation(example.expected, { text }, entry, {
        date: example.referenceDate,
        hour: 8,
        minute: 0,
      });
      assert.equal(parsed.kind, 'modelPatch');
      assert.deepEqual(parsed.edits, [
        { field: 'client', text: client },
        { field: 'date', text: date },
        { field: 'time', text: '16:00' },
      ]);
      assert.deepEqual(entry.data, {});
    }
});
