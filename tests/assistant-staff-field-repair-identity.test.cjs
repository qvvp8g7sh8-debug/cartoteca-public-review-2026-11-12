const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const { isFastContinuation } = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
function fixture(role = 'salon_admin') {
  const f = dialogueFixture({ role });
  f.c.current.accountId =
    role === 'salon_admin' ? 'admin' : role === 'cosmetologist' ? 'worker' : 'owner';
  f.members.splice(
    0,
    f.members.length,
    { accountId: 'owner', displayName: 'Виктор Лабораторный', role: 'owner', status: 'active' },
    { accountId: 'worker', displayName: 'Ирина Орлова', role: 'cosmetologist', status: 'active' },
    {
      accountId: 'admin',
      displayName: 'Евгений Лабораторный',
      role: 'salon_admin',
      status: 'active',
    },
  );
  f.patients[0].createdBy = 'worker';
  f.patients.push({
    id: 'client-irina',
    firstName: 'Ирина',
    lastName: 'Орлова',
    name: 'Ирина Орлова',
    createdBy: 'worker',
    phone: '+79990001001',
    appointments: [],
  });
  f.patients.push({
    id: 'client-oleg',
    firstName: 'Олег',
    lastName: 'Иванов',
    name: 'Олег Иванов',
    createdBy: 'worker',
    phone: '+79990001002',
    appointments: [],
  });
  f.services.splice(
    0,
    f.services.length,
    { id: 'owner-primary', name: 'Первичная консультация', duration: 60, staffId: 'owner' },
    { id: 'worker-primary', name: 'Первичная консультация', duration: 60, staffId: 'worker' },
    { id: 'owner-milk', name: 'Молочный пилинг', duration: 30, staffId: 'owner' },
    { id: 'worker-milk', name: 'Молочный пилинг', duration: 30, staffId: 'worker' },
  );
  f.c.platform.workspaceSettings = () => ({
    enabled: false,
    mode: 'separate',
    staffRules: [],
    rooms: [
      {
        id: 'main',
        name: 'Общий',
        active: true,
        staffIds: ['owner', 'worker', 'second'],
        preventOverlap: false,
      },
    ],
  });
  f.changed();
  const entry = () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  const body = (text) => ({
    policyVersion: f.state.revision,
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    text,
  });
  const prepare = (text) => f.flow.prepareModelTurn(f.c, body(text), f.state, f.member, f.clock);
  return { f, entry, body, prepare };
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));
const fields = (value) =>
  Object.fromEntries((value.dialogue?.fields || []).map((row) => [row.key, row.value]));
const known = {
  query: 'Анна Семёнова',
  serviceQuery: 'Первичная консультация',
  date: day,
  time: '12:00',
};

test('a current exact staff answer bypasses the model and keeps the namesake client separate', () => {
  for (const text of ['Ирина Орлова', 'Ирине Орловой', 'к Ирине Орловой', 'у Ирины Орловой']) {
    const { f, entry, prepare } = fixture();
    f.start(known, { openWhenComplete: true });
    assert.equal(f.result.dialogue.step, 'staff');
    const anna = entry().data.patient.id;
    assert.equal(
      prepare(text),
      null,
      'A known current staff answer must not become a model client patch',
    );
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue, null);
    assert.equal(result.action.type, 'prepareAppointment');
    assert.equal(result.action.patientId, anna);
    assert.notEqual(result.action.patientId, 'client-irina');
    assert.equal(result.action.staffId, 'worker');
    assert.deepEqual(result.action.serviceIds, ['worker-primary']);
    assert.equal(result.action.date, day);
    assert.equal(result.action.time, '12:00');
    assert.equal(result.action.duration, 60);
    noSave(f);
  }
});

test('an ambiguous exact given name or duplicate full name stays a local staff question', () => {
  for (const secondName of ['Ирина Петрова', 'Ирина Орлова']) {
    const { f, entry, prepare } = fixture();
    f.members.push({
      accountId: 'second',
      displayName: secondName,
      role: 'cosmetologist',
      status: 'active',
    });
    f.services.push({
      id: 'second-primary',
      name: 'Первичная консультация',
      duration: 60,
      staffId: 'second',
    });
    f.start(known);
    const anna = entry().data.patient.id;
    const answer = secondName === 'Ирина Орлова' ? 'Ирина Орлова' : 'Ирина';
    assert.equal(prepare(answer), null);
    const result = f.answer({ text: answer }).result;
    assert.equal(result.dialogue.step, 'staff');
    assert.equal(result.dialogue.options.length, 2);
    assert.equal(entry().data.staff, null);
    assert.equal(entry().data.patient.id, anna);
    assert.equal(entry().data.date, day);
    assert.equal(entry().data.time, '12:00');
    assert.equal(result.action, null);
    noSave(f);
  }
});

test('explicit client labels and other current steps are not stolen by the staff shortcut', () => {
  const { f, entry, prepare } = fixture();
  f.start(known);
  assert.equal(prepare('Клиент Ирина Орлова'), null, 'The explicit client repair remains local');
  f.answer({ text: 'Клиент Ирина Орлова' });
  assert.equal(entry().data.patient.id, 'client-irina');
  assert.equal(entry().data.staff, null);
  assert.equal(f.result.dialogue.step, 'staff');
  assert.equal(entry().data.date, day);
  assert.equal(entry().data.time, '12:00');
  const atTime = fixture('owner');
  atTime.f.start({ ...known, time: undefined });
  assert.equal(atTime.f.result.dialogue.step, 'time');
  assert.equal(
    isFastContinuation('Ирина Орлова', atTime.entry(), atTime.f.clock, atTime.f.c),
    false,
  );
  noSave(f);
  noSave(atTime.f);
});

test('current scope names are fresh after classification and inaccessible employees are never selected', () => {
  for (const mutation of ['rename', 'inactive']) {
    const { f, entry, prepare } = fixture();
    f.start(known);
    const anna = entry().data.patient.id;
    assert.equal(prepare('Ирина Орлова'), null);
    if (mutation === 'rename') f.members[1].displayName = 'Ирина Другая';
    else f.members[1].status = 'inactive';
    f.changed();
    const result = f.answer({ text: 'Ирина Орлова' }).result;
    assert.equal(result.dialogue.step, 'staff', mutation);
    assert.equal(entry().data.staff, null);
    assert.equal(entry().data.patient.id, anna);
    assert.equal(result.action, null);
    noSave(f);
  }
  const { f, entry } = fixture('cosmetologist');
  f.start({ ...known, staffQuery: 'Виктор Лабораторный' });
  f.answer({ text: 'Виктор Лабораторный' });
  assert.equal(entry().data.staff, null);
  assert.equal(f.result.dialogue.step, 'staff');
  assert.ok(f.result.dialogue.options.every((row) => row.label === 'Ирина Орлова'));
  noSave(f);
});

test('replacement markers are stripped only at explicit field boundaries for clients staff and services', () => {
  const current = { step: 'time', data: {}, options: new Map() };
  for (const [text, field, value] of [
    ['Клиент другой, Олег Иванов.', 'client', 'олег иванов'],
    ['Пациент другой: Олег Иванов', 'client', 'олег иванов'],
    ['Сотрудник другой, Ирина Орлова.', 'staff', 'ирина орлова'],
    ['Услуга другая — Молочный пилинг.', 'service', 'молочный пилинг'],
    ['Другого клиента, Олег Иванов', 'client', 'олег иванов'],
    ['Другую услугу: Молочный пилинг', 'service', 'молочный пилинг'],
    ['Поменяй другого сотрудника, Ирина Орлова', 'staff', 'ирина орлова'],
  ])
    assert.deepEqual(
      repairOperation(current, text, { date: day }),
      { kind: 'patch', edits: [{ field, text: value }], confirm: false },
      text,
    );
  assert.deepEqual(repairOperation(current, 'Услуга Другая консультация', { date: day }), {
    kind: 'patch',
    edits: [{ field: 'service', text: 'другая консультация' }],
    confirm: false,
  });
  assert.deepEqual(repairOperation(current, 'Клиент другой', { date: day }), {
    kind: 'edit',
    field: 'client',
  });
  assert.equal(
    repairOperation(current, 'Клиент другой, Олег или Алексей', { date: day }).kind,
    'localHelp',
  );
});

test('changing the client with a replacement marker at the time step keeps all other fields for every role', () => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const { f, entry, prepare } = fixture(role),
      staff = role === 'cosmetologist' ? 'Ирина Орлова' : 'Виктор Лабораторный';
    f.start({ ...known, staffQuery: staff, time: undefined });
    const before = structuredClone(entry().data);
    assert.equal(f.result.dialogue.step, 'time');
    assert.equal(prepare('Клиент другой, Олег Иванов.'), null);
    const result = f.answer({ text: 'Клиент другой, Олег Иванов.' }).result;
    assert.equal(result.dialogue.step, 'time', role);
    assert.equal(entry().data.patient.id, 'client-oleg');
    assert.equal(entry().data.clientQuery, 'олег иванов');
    for (const key of ['staff', 'service', 'date', 'time', 'duration', 'durationSource'])
      assert.deepEqual(entry().data[key], before[key], role + ':' + key);
    const ready = f.answer({ text: 'В 12:00' }).result;
    assert.equal(ready.dialogue.step, 'review');
    assert.equal(fields(ready).client, 'Олег Иванов · …1002');
    const form = f.answer({ text: 'открой форму' }).result;
    assert.equal(form.action.patientId, 'client-oleg');
    assert.equal(form.action.time, '12:00');
    noSave(f);
  }
});

test('staff and service replacement markers retain client date and time while re-resolving dependencies', () => {
  for (const [text, staffId, serviceId, duration] of [
    ['Сотрудник другой, Ирина Орлова.', 'worker', 'worker-primary', 60],
    ['Услуга другая, Молочный пилинг.', 'owner', 'owner-milk', 30],
  ]) {
    const { f, entry } = fixture('owner');
    f.start({ ...known, time: undefined });
    const anna = entry().data.patient.id;
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue.step, 'time');
    assert.equal(entry().data.patient.id, anna);
    assert.equal(entry().data.staff.id, staffId);
    assert.equal(entry().data.service.id, serviceId);
    assert.equal(entry().data.duration, duration);
    assert.equal(entry().data.date, day);
    assert.equal(entry().data.time, null);
    noSave(f);
  }
});

test('multipart replacement markers are one atomic patch and ambiguous replacements leave every field unchanged', () => {
  const { f, entry } = fixture('owner');
  f.start({ ...known, time: undefined });
  const result = f.answer({
    text: 'Клиент другой, Олег Иванов, другая услуга, Молочный пилинг.',
  }).result;
  assert.equal(result.dialogue.step, 'time');
  assert.equal(entry().data.patient.id, 'client-oleg');
  assert.equal(entry().data.service.id, 'owner-milk');
  assert.equal(entry().data.duration, 30);
  const before = structuredClone(entry().data);
  f.answer({ text: 'Клиент другой, Олег или Алексей, услуга другая, Молочный пилинг.' });
  assert.deepEqual(entry().data, before);
  noSave(f);
});
