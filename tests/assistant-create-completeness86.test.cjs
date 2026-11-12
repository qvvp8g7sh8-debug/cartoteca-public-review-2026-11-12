const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const {
  omittedEntityRoles,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-entity-completeness.cjs');
const fields = { client: null, staff: null, service: null, date: null, time: null, duration: null };
const proposal = (values = {}, operation = 'patch') => ({
  operation,
  fields: { ...fields, ...values },
  choice: null,
  field: operation === 'clarify' ? 'time' : null,
});
function fixture() {
  const f = dialogueFixture({ ambiguous: true });
  f.services.push({ id: 'massage', name: 'Массаж', duration: 60, staffId: 'owner' });
  f.members.push({
    accountId: 'maria',
    displayName: 'Мария Иванова',
    firstName: 'Мария',
    lastName: 'Иванова',
    role: 'cosmetologist',
    status: 'active',
  });
  f.services.push({ id: 'maria-clean', name: 'Чистка', duration: 45, staffId: 'maria' });
  const settings = f.c.platform.workspaceSettings;
  f.c.platform.workspaceSettings = () => {
    const value = settings();
    value.rooms[0].staffIds.push('maria');
    return value;
  };
  let result = f.start(
    { query: 'Анна Семёнова', serviceQuery: 'Чистка' },
    { openWhenComplete: true },
  );
  const id = result.dialogue.id;
  return {
    ...f,
    entry: () => f.flow.get(f.c, f.member, f.state, id),
    get result() {
      return result;
    },
    model(text, value) {
      const body = { dialogueId: id, dialogueVersion: result.dialogue.version, text };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot, text);
      result = f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, value, snapshot);
      return result;
    },
    local(text) {
      const body = { dialogueId: id, dialogueVersion: result.dialogue.version, text };
      result = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
      return result;
    },
  };
}
for (const [field, raw, answer, expectedId] of [
  ['client', 'Клиента поменяй на Ольгу Семёнову на сегодня в 16:00', 'Ольга Семёнова', 1],
  ['client', 'На сегодня в 16:00 клиента поменяй на Ольгу Семёнову', 'Ольга Семёнова', 1],
  ['client', 'Клиент Ольга Семёнова, сегодня в 16:00', 'Ольга Семёнова', 1],
  ['service', 'Услугу поменяй на массаж, на сегодня в 16:00', 'Массаж', 'massage'],
  ['service', 'Сегодня в 16:00 услуга массаж', 'Массаж', 'massage'],
  ['staff', 'Сегодня в 16:00 сотрудник Мария Иванова', 'Мария Иванова', 'maria'],
])
  test('an omitted explicit ' + field + ' cannot auto-complete with the old entity: ' + raw, () => {
    const f = fixture();
    const before = JSON.stringify(f.patients);
    const result = f.model(raw, proposal({ date: day, time: '16:00' }));
    assert.equal(result.action, null);
    assert.equal(result.dialogue.step, field);
    const data = f.entry().data;
    assert.equal(data.date, day);
    assert.equal(data.time, '16:00');
    if (field === 'client') {
      assert.equal(data.patient, null);
      assert.equal(data.service.id, 'clean');
    } else if (field === 'service') {
      assert.equal(data.service, null);
      assert.equal(data.patient.id, f.patients[0].id);
    } else {
      assert.equal(data.staff, null);
      assert.equal(data.patient.id, f.patients[0].id);
    }
    const completed = f.local(answer);
    assert.equal(
      completed.action?.type,
      'prepareAppointment',
      JSON.stringify({ completed, data: f.entry().data }),
    );
    if (field === 'client') assert.equal(completed.action.patientId, f.patients[expectedId].id);
    if (field === 'service') {
      assert.deepEqual(completed.action.serviceIds, [expectedId]);
      assert.equal(completed.action.duration, 60);
    }
    if (field === 'staff') {
      assert.equal(completed.action.staffId, expectedId);
      assert.deepEqual(completed.action.serviceIds, ['maria-clean']);
    }
    assert.equal(JSON.stringify(f.patients), before);
  });

test('omitted labelled roles remain unresolved for period replies and clarify/ready proposals', () => {
  for (const value of [
    proposal({ date: day }),
    proposal({}, 'slots'),
    proposal({}, 'clarify'),
    proposal({}, 'ready'),
  ]) {
    const f = fixture();
    const result = f.model('Сегодня после обеда клиент Ольга Семёнова', value);
    assert.equal(result.action, null);
    assert.equal(result.dialogue.step, 'client');
    assert.equal(f.entry().data.patient, null);
    assert.equal(f.entry().data.date, day);
    assert.equal(f.entry().data.timeWindow.kind, 'day');
    assert.equal(f.entry().data.time, null);
    assert.equal(f.entry().data.service.id, 'clean');
  }
});

test('all explicitly omitted roles are cleared together while a correctly supplied role and temporal facts survive', () => {
  const f = fixture();
  const result = f.model(
    'Давайте сегодня в 16:00, клиент Ольга Семёнова, услуга Массаж',
    proposal({ client: 'Ольга Семёнова', date: day, time: '16:00' }),
  );
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'service');
  assert.equal(f.entry().data.patient.id, f.patients[1].id);
  assert.equal(f.entry().data.service, null);
  assert.equal(f.entry().data.time, '16:00');
  const other = fixture();
  other.model(
    'Давайте сегодня в 16:00, клиент Ольга Семёнова, услуга Массаж',
    proposal({ date: day, time: '16:00' }),
  );
  assert.equal(other.entry().data.patient, null);
  assert.equal(other.entry().data.service, null);
  assert.equal(other.entry().data.date, day);
});

test('invalid or alternative omitted role queries cannot preserve an old role as an execution default', () => {
  for (const raw of [
    'Клиент Ольга или Анна, сегодня в 16:00',
    'Сегодня в 16:00 услуга неизвестная',
    'Сегодня в 16:00 клиент не Ольга',
  ]) {
    const f = fixture();
    const result = f.model(raw, proposal({ date: day, time: '16:00' }));
    assert.equal(result.action, null);
    const role = raw.includes('услуга') ? 'service' : 'client';
    assert.equal(result.dialogue.step, role);
    assert.equal(role === 'client' ? f.entry().data.patient : f.entry().data.service, null);
  }
});

test('preservation, questions, conditional requests and role words inside proven entity titles do not manufacture a role correction', () => {
  const raw = 'Нужен пилинг Клиент VIP, сегодня в 16:00';
  assert.deepEqual(omittedEntityRoles(raw, { ...fields, service: 'пилинг Клиент VIP' }), []);
  assert.deepEqual(omittedEntityRoles('Какого клиента выбрать?', fields), []);
  assert.deepEqual(omittedEntityRoles('Назови услугу, пожалуйста', fields), []);
  assert.deepEqual(omittedEntityRoles('Клиента оставь прежним', fields), []);
  assert.deepEqual(omittedEntityRoles('Не меняй клиента Ольгу', fields), []);
  const f = fixture();
  const result = f.local('Клиента не меняй. Сегодня в 16:00');
  assert.equal(result.action?.patientId, f.patients[0].id);
  const other = fixture();
  const before = structuredClone(other.entry().data);
  other.model(
    'Сегодня в 16:00 клиент Ольга Семёнова если свободно',
    proposal({ date: day, time: '16:00' }),
  );
  assert.deepEqual(other.entry().data, before);
});

for (const clause of [
  'Клиент тот же',
  'Клиента того же',
  'Клиентку ту же',
  'Услуга та же',
  'Услугу ту же',
  'Сотрудник тот же',
  'Сотрудника того же',
  'Услугу оставь ту же',
  'Клиента оставь того же',
  'Не меняй клиента',
  'Не меняй сотрудника',
  'Не меняй услугу',
])
  test(
    'explicit preservation applies the independent temporal change without reselecting a role: ' +
      clause,
    () => {
      const f = fixture();
      const result = f.local(clause + ', сегодня в 16:00');
      assert.equal(result.action?.type, 'prepareAppointment');
      assert.equal(result.action.patientId, f.patients[0].id);
      assert.equal(result.action.staffId, 'owner');
      assert.deepEqual(result.action.serviceIds, ['clean']);
      assert.equal(result.action.time, '16:00');
    },
  );

for (const clause of ['клиент Анна Семёнова', 'услуга Чистка', 'сотрудник Тестовый Специалист'])
  test(
    'a whole repetition of the resolved role does not make its missing model field a new unresolved identity: ' +
      clause,
    () => {
      const f = fixture();
      const result = f.model('Сегодня в 16:00 ' + clause, proposal({ date: day, time: '16:00' }));
      assert.equal(result.action?.type, 'prepareAppointment');
      assert.equal(result.action.patientId, f.patients[0].id);
      assert.deepEqual(result.action.serviceIds, ['clean']);
      assert.equal(result.action.staffId, 'owner');
    },
  );

test('preservation is not permission to discard another assignment to the protected role or a trailing condition', () => {
  for (const raw of [
    'Клиента того же. Клиента Ольгу Семёнову на сегодня в 16:00',
    'Услугу ту же, сегодня в 16:00 если свободно',
  ]) {
    const f = fixture();
    const first = structuredClone(f.entry().data);
    const result = f.local(raw);
    assert.equal(result.action, null);
    assert.equal(f.entry().data.patient.id, first.patient.id);
    assert.equal(f.entry().data.service.id, first.service.id);
  }
});

test('temporal fields can be explicitly preserved while only the other missing temporal field is supplied', () => {
  const date = fixture();
  date.local('сегодня');
  assert.equal(date.local('Не меняй дату, в 16:00').action?.time, '16:00');
  const time = fixture();
  time.local('в 16:00');
  assert.equal(time.local('Не меняй время, сегодня').action?.date, day);
});

test('an omitted unlabelled service assignment never reuses the previous service', () => {
  const f = fixture();
  const result = f.model('Сегодня в 16:00 на массаж', proposal({ date: day, time: '16:00' }));
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'service');
  assert.equal(f.entry().data.service, null);
  assert.equal(f.entry().data.patient.id, f.patients[0].id);
  assert.equal(f.entry().data.time, '16:00');
});

test('the server-selected ordinal example is applicable only after the choice was proven and is accepted as a patch', () => {
  const {
    continuationExamples,
  } = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
  const raw = 'Вторую на Чистку на сегодня в 16:00';
  const context = {
    step: 'date',
    role: 'owner',
    selected: {},
    missingFields: ['date', 'time'],
    options: [],
  };
  assert.equal(
    continuationExamples(raw, context).metadata.selected.some(
      (row) => row.id === 'follow-selected-client-service-time',
    ),
    false,
  );
  const selected = continuationExamples(raw, { ...context, selectionApplied: { field: 'client' } });
  const example = selected.examples.find((row) => row.text === raw);
  assert.ok(example);
  assert.deepEqual(example.selectionApplied, { field: 'client' });
  const operation = continuationOperation(
    example.expected,
    { text: 'на Чистку на сегодня в 16:00' },
    { step: 'date', data: {}, options: new Map() },
    { date: example.referenceDate, hour: 8, minute: 0 },
  );
  assert.equal(operation.kind, 'modelPatch');
  assert.deepEqual(operation.edits, [
    { field: 'service', text: 'Чистку' },
    { field: 'date', text: '2026-10-15' },
    { field: 'time', text: '16:00' },
  ]);
});
