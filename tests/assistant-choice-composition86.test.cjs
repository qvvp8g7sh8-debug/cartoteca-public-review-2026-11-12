const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  choiceTemporalComposition,
  choiceOrdinalComposition,
} = require('../src/server/modules/assistant/dialogue/choice-temporal-composition.cjs');
function setup(kind = 'client') {
  const f = dialogueFixture({ ambiguous: true });
  if (kind === 'staff') {
    f.members.push({
      accountId: 'maria',
      displayName: 'Мария Иванова',
      role: 'cosmetologist',
      status: 'active',
    });
    f.services.push({ id: 'clean-maria', name: 'Чистка', duration: 30, staffId: 'maria' });
    const workspace = f.c.platform.workspaceSettings();
    workspace.rooms[0].staffIds.push('maria');
    f.c.platform.workspaceSettings = () => workspace;
  }
  if (kind === 'service')
    f.services.push(
      { id: 'prx', name: 'Пилинг PRX', duration: 60, staffId: 'owner' },
      { id: 'tca', name: 'Пилинг TCA', duration: 45, staffId: 'owner' },
    );
  const first = f.start(
    {
      query: kind === 'client' ? 'Семёнова' : 'Анна Семёнова',
      serviceQuery: kind === 'service' ? 'пилинг' : 'Чистка',
      ...(kind === 'staff' ? { staffQuery: 'Неведомый' } : {}),
    },
    { openWhenComplete: true },
  );
  assert.equal(first.dialogue.step, kind);
  const id = first.dialogue.id;
  return {
    ...f,
    get result() {
      return f.result;
    },
    entry: () => f.flow.get(f.c, f.member, f.state, id),
    turn: (text) => f.answer({ text }).result,
  };
}
for (const [kind, role] of [
  ['client', 'клиента'],
  ['staff', 'специалиста'],
  ['service', 'услугу'],
])
  for (const raw of [
    'Вторую на сегодня в 16:00',
    'На сегодня в 16:00 вторую',
    `Второго ${role} на сегодня в шестнадцать тридцать`,
    `На сегодня в шестнадцать тридцать второго ${role}`,
  ])
    test('a current ' + kind + ' choice composes with a complete temporal answer: ' + raw, () => {
      const f = setup(kind),
        original = JSON.stringify(f.patients);
      const selected = [...f.entry().options.values()][1];
      assert.equal(selected.kind, kind);
      const result = f.turn(raw),
        data = f.entry().data;
      assert.equal(result.action?.type, 'prepareAppointment');
      assert.equal(data.date, day);
      assert.equal(data.time, raw.includes('тридцать') ? '16:30' : '16:00');
      assert.equal(
        kind === 'client' ? data.patient.id : kind === 'staff' ? data.staff.id : data.service.id,
        selected.value,
      );
      assert.equal(data.durationSource, 'service');
      assert.equal(JSON.stringify(f.patients), original);
    });
for (const kind of ['client', 'staff', 'service'])
  test('a current ' + kind + ' remains selected while its invalid clock is clarified', () => {
    const f = setup(kind),
      original = JSON.stringify(f.patients);
    const selected = [...f.entry().options.values()][1];
    f.turn('вторую на сегодня в 25:00');
    const data = f.entry().data;
    assert.equal(
      kind === 'client' ? data.patient.id : kind === 'staff' ? data.staff.id : data.service.id,
      selected.value,
    );
    assert.equal(data.date, day);
    assert.equal(data.time, null);
    assert.equal(data.timeRequired, true);
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue.step, 'time');
    const result = f.turn('в 16:00');
    assert.equal(result.action?.type, 'prepareAppointment');
    assert.equal(result.action.date, day);
    assert.equal(result.action.time, '16:00');
    assert.equal(JSON.stringify(f.patients), original);
  });
test('a source-independent day proposal retains a client choice and independently stated clock', () => {
  const f = setup();
  f.turn('вторую на двадцатое в 16:00');
  assert.equal(f.entry().data.patient.id, f.patients[1].id);
  assert.equal(f.entry().data.date, null);
  assert.equal(f.entry().data.dateProposal.day, 20);
  assert.equal(f.entry().data.time, '16:00');
  assert.match(f.result.text, /января/u);
  assert.equal(f.result.action, null);
});
test('an explicit duration composes with a service choice and overrides only its default length', () => {
  const f = setup('service');
  f.turn('вторую на сегодня в 16:00 на 30 минут');
  assert.equal(f.result.action?.type, 'prepareAppointment');
  assert.equal(f.entry().data.duration, 30);
  assert.equal(f.entry().data.durationSource, 'manual');
  assert.equal(f.result.action.time, '16:00');
});
for (const [raw, time] of [
  ['Вторую на сегодня на12часов', '12:00'],
  ['На сегодня в16часов второго клиента', '16:00'],
])
  test('known compact clock forms compose with the current choice: ' + raw, () => {
    const f = setup();
    f.turn(raw);
    assert.equal(f.result.action?.type, 'prepareAppointment');
    assert.equal(f.result.action.patientId, f.patients[1].id);
    assert.equal(f.result.action.time, time);
    assert.equal(f.result.action.duration, 30);
  });
for (const raw of [
  'Пожалуйста, вторую на сегодня в 16:00',
  'На сегодня в 16:00 второго клиента, пожалуйста',
])
  test('fixed courtesy words do not interrupt a complete current choice: ' + raw, () => {
    const f = setup();
    f.turn(raw);
    assert.equal(f.result.action?.type, 'prepareAppointment');
    assert.equal(f.result.action.patientId, f.patients[1].id);
    assert.equal(f.result.action.time, '16:00');
  });
test('an invalid explicit duration retains the selected service and requires its length', () => {
  const f = setup('service');
  f.turn('вторую на сегодня в 16:00 на 7 минут');
  assert.equal(f.entry().data.service.id, 'tca');
  assert.equal(f.entry().data.date, day);
  assert.equal(f.entry().data.time, '16:00');
  assert.equal(f.entry().data.durationSource, 'required');
  assert.equal(f.result.dialogue.step, 'duration');
  assert.equal(f.result.action, null);
});
test('period proof retains the current client choice without inventing an exact clock', () => {
  const f = setup();
  f.turn('вторую на сегодня вечером');
  assert.equal(f.entry().data.patient.id, f.patients[1].id);
  assert.equal(f.entry().data.date, day);
  assert.equal(f.entry().data.time, null);
  assert.equal(f.entry().data.timeWindow.kind, 'evening');
  assert.equal(f.result.action, null);
});
for (const raw of [
  'вторую на сегодня в 16:00 если получится',
  'вторую на сегодня в 16:00 или в 17:00',
  'вторую на сегодня в 16:00 и отмени третью',
  'вторую на чистку на сегодня в 16:00',
  'не вторую на сегодня в 16:00',
  'вторую на сегодня первого клиента',
  'вторую на сегодня 1',
  '2 на сегодня вторую',
])
  test('whole choice composition rejects an unconsumed condition or entity: ' + raw, () => {
    const f = setup();
    assert.equal(choiceTemporalComposition(f.entry(), raw, f.clock), null);
  });
test('role words must match the field of the current options', () => {
  const f = setup();
  assert.equal(
    choiceTemporalComposition(f.entry(), 'вторую услугу на сегодня в 16:00', f.clock),
    null,
  );
});
test('stale client stamps prevent a composed choice before applying temporal fields', () => {
  const f = setup();
  f.patients[1].name = 'Ольга Петрова';
  f.patients[1].lastName = 'Петрова';
  f.changed();
  const before = structuredClone(f.entry().data);
  assert.throws(() => f.turn('вторую на сегодня в 16:00'), { status: 409 });
  assert.deepEqual(f.entry().data, before);
});
test('the pure helper binds only current client/staff/service option kinds and does not mutate drafts', () => {
  const f = setup(),
    before = JSON.stringify(f.entry().data);
  const proof = choiceTemporalComposition(f.entry(), 'Вторую на сегодня в 16:00', f.clock);
  assert.deepEqual(proof.edits, [
    { field: 'date', text: day },
    { field: 'time', text: '16:00' },
  ]);
  assert.equal(proof.choice, [...f.entry().options.keys()][1]);
  assert.equal(JSON.stringify(f.entry().data), before);
  assert.equal(
    choiceTemporalComposition(
      { ...f.entry(), step: 'review' },
      'вторую на сегодня в 16:00',
      f.clock,
    ),
    null,
  );
});
for (const [raw, remainder] of [
  ['Вторую на чистку на сегодня в 16:00', 'на чистку на сегодня в 16:00'],
  ['На массаж сегодня в 16:00 второго клиента', 'На массаж сегодня в 16:00'],
  ['Второго клиента на чистку, если сегодня свободно', 'на чистку, если сегодня свободно'],
  ['Вторую не на чистку, а на массаж', 'не на чистку, а на массаж'],
  ['Вторую на чистку и отмени запись', 'на чистку и отмени запись'],
])
  test('the ordinal extractor retains the entire remaining entity and guard scope: ' + raw, () => {
    const f = setup();
    assert.deepEqual(choiceOrdinalComposition(f.entry(), raw), {
      choice: [...f.entry().options.keys()][1],
      remainder,
    });
  });
for (const raw of [
  'первую на чистку вторую',
  'вторую на чистку вторую',
  'вторую услугу на сегодня',
])
  test(
    'the ordinal extractor rejects conflicting positions or a role from another field: ' + raw,
    () => {
      const f = setup();
      assert.equal(choiceOrdinalComposition(f.entry(), raw), null);
    },
  );
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
for (const [raw, service] of [
  ['Вторую на чистку на сегодня в 16:00', 'чистку'],
  ['На массаж сегодня в 16:00 второго клиента', 'массаж'],
])
  test(
    'a bound ordinal and model-owned service/temporal patch are applied together: ' + raw,
    () => {
      const f = setup(),
        original = JSON.stringify(f.patients);
      f.services.push({ id: 'massage', name: 'Массаж', duration: 60, staffId: 'owner' });
      f.changed();
      const body = {
        dialogueId: f.result.dialogue.id,
        dialogueVersion: f.result.dialogue.version,
        text: raw,
      };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot, 'non-temporal fields still use guarded model extraction');
      const result = f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal({ service, date: day, time: '16:00' }),
        snapshot,
      );
      assert.equal(result.action?.type, 'prepareAppointment');
      assert.equal(result.action.patientId, f.patients[1].id);
      assert.equal(result.action.date, day);
      assert.equal(result.action.time, '16:00');
      assert.equal(result.action.duration, service === 'массаж' ? 60 : 30);
      assert.equal(JSON.stringify(f.patients), original);
    },
  );
test('a stale bound ordinal cannot be applied through the model-owned composition', () => {
  const f = setup();
  const body = {
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    text: 'Вторую на чистку на сегодня в 16:00',
  };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.ok(snapshot);
  f.patients[1].lastName = 'Петрова';
  f.patients[1].name = 'Ольга Петрова';
  f.changed();
  const before = structuredClone(f.entry().data);
  assert.throws(
    () =>
      f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal({ service: 'чистку', date: day, time: '16:00' }),
        snapshot,
      ),
    { status: 409 },
  );
  assert.deepEqual(f.entry().data, before);
});
for (const [raw, extra] of [
  ['Вторую на чистку сегодня в 16:00, если свободно', {}],
  ['Вторую на чистку сегодня в 16:00 и отмени запись', {}],
  ['Вторую на чистку сегодня в 16:00', { client: 'Анна' }],
])
  test(
    'model extraction cannot commit a bound choice after an unsafe or unspoken patch: ' +
      raw +
      JSON.stringify(extra),
    () => {
      const f = setup();
      const body = {
        dialogueId: f.result.dialogue.id,
        dialogueVersion: f.result.dialogue.version,
        text: raw,
      };
      const before = structuredClone(f.entry().data);
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot);
      const result = f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal({ service: 'чистку', date: day, time: '16:00', ...extra }),
        snapshot,
      );
      assert.equal(result.action, null);
      for (const field of ['patient', 'service', 'date', 'time', 'duration'])
        assert.deepEqual(f.entry().data[field], before[field], field);
    },
  );
