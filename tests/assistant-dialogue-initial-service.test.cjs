const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const field = (result, key) => result.dialogue?.fields.find((row) => row.key === key)?.value;
function fixture() {
  const f = dialogueFixture({ role: 'salon_admin' });
  f.c.current.accountId = 'admin';
  f.members.splice(
    0,
    f.members.length,
    { accountId: 'owner', displayName: 'Ирина Орлова', role: 'owner', status: 'active' },
    { accountId: 'other', displayName: 'Мария Соколова', role: 'cosmetologist', status: 'active' },
    {
      accountId: 'admin',
      displayName: 'Ольга Администратор',
      role: 'salon_admin',
      status: 'active',
    },
  );
  f.services.splice(
    0,
    f.services.length,
    { id: 'owner-primary', name: 'Первичная консультация', duration: 30, staffId: 'owner' },
    { id: 'other-primary', name: 'Первичная консультация', duration: 45, staffId: 'other' },
    { id: 'other-massage', name: 'Массаж', duration: 60, staffId: 'other' },
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
        staffIds: ['owner', 'other'],
        preventOverlap: false,
      },
    ],
  });
  return f;
}
const start = (f, extra = {}) =>
  f.start({
    query: 'Анна Семёнова',
    serviceQuery: 'Первичную консультацию',
    date: day,
    time: '11:00',
    ...extra,
  });
const choose = (f, name) =>
  f.answer({ choice: f.result.dialogue.options.find((row) => row.label.includes(name)).id }).result;
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('the first performer answer preserves the initially stated service and resolves only that performer catalog', () => {
  for (const input of ['text', 'choice']) {
    const f = fixture();
    assert.equal(start(f).dialogue.step, 'staff');
    const result =
      input === 'text' ? f.answer({ text: 'к Ирине Орловой' }).result : choose(f, 'Ирина');
    assert.equal(result.dialogue.step, 'review', input);
    assert.equal(field(result, 'service'), 'Первичная консультация');
    assert.equal(field(result, 'duration'), '30 мин');
    const ready = f.answer({ text: 'открой форму' }).result;
    assert.equal(ready.action.staffId, 'owner');
    assert.deepEqual(ready.action.serviceIds, ['owner-primary']);
    noSave(f);
  }
});

test('a busy initial time retains the stated service and requires an explicit clock from fresh free ranges', () => {
  const f = fixture();
  f.busy.push({ date: day, time: '11:00', duration: 30, staffId: 'owner', roomId: 'main' });
  start(f);
  const result = f.answer({ text: 'к Ирине Орловой' }).result;
  assert.equal(result.dialogue.step, 'time');
  assert.equal(field(result, 'service'), 'Первичная консультация');
  assert.equal(result.dialogue.phase, 'period');
  assert.deepEqual(result.dialogue.options.map(row => row.label), ['с 09:00 до 11:00', 'с 11:30 до 18:00']);
  assert.equal(field(result, 'date'), day);
  assert.equal(field(result, 'duration'), '30 мин');
  assert.equal(field(result, 'time'), undefined);
  assert.equal(result.action, null);
  const chosen = f.answer({ text: 'в 10:30' }).result;
  assert.equal(chosen.dialogue.step, 'review');
  assert.equal(field(chosen, 'time'), '10:30');
  assert.equal(field(chosen, 'service'), 'Первичная консультация');
  assert.equal(chosen.action, null);
  const action = f.answer({ text: 'открой форму' }).result.action;
  assert.equal(action.type, 'prepareAppointment');
  assert.equal(action.patientId, f.patients[0].id);
  assert.equal(action.staffId, 'owner');
  assert.deepEqual(action.serviceIds, ['owner-primary']);
  assert.equal(action.date, day);
  assert.equal(action.time, '10:30');
  assert.equal(action.duration, 30);
  noSave(f);
});

test('an unresolved initial service keeps a required-duration clarification after the first performer selection', () => {
  const f = fixture();
  let result = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      serviceQuery: 'Первичную консультацию',
      date: day,
      time: '11:00',
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { requireDuration: true },
  );
  const answer = (text) =>
    (result = f.flow.continueDialogue(
      f.c,
      { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
      f.state,
      f.member,
      f.clock,
    ));
  answer('к Ирине Орловой');
  assert.equal(result.dialogue.step, 'duration');
  assert.equal(field(result, 'service'), 'Первичная консультация');
  assert.equal(field(result, 'duration'), undefined);
  answer('15 минут');
  assert.equal(result.dialogue.step, 'review');
  assert.equal(answer('открой').action.duration, 15);
  noSave(f);
});

test('an ambiguous initial service remains a clarification within the selected performer catalog', () => {
  const f = fixture();
  f.services.push({
    id: 'owner-repeat',
    name: 'Повторная консультация',
    duration: 20,
    staffId: 'owner',
  });
  start(f, { serviceQuery: 'консультацию' });
  const result = choose(f, 'Ирина');
  assert.equal(result.dialogue.step, 'service');
  assert.equal(field(result, 'service'), undefined);
  assert.deepEqual(
    result.dialogue.options.map((row) => row.label),
    ['Первичная консультация · 30 мин', 'Повторная консультация · 20 мин'],
  );
  noSave(f);
});

test('an initial service existing only for another performer is not selected or exposed after choosing the owner', () => {
  const f = fixture();
  start(f, { serviceQuery: 'Массаж' });
  const result = choose(f, 'Ирина');
  assert.equal(result.dialogue.step, 'service');
  assert.equal(field(result, 'service'), undefined);
  assert.ok(result.dialogue.options.every((row) => !row.label.includes('Массаж')));
  noSave(f);
});

test('a real performer change resolves the same service name in the new catalog and refreshes its duration', () => {
  const f = fixture();
  start(f, { staffQuery: 'Ирине Орловой' });
  assert.equal(f.result.dialogue.step, 'review');
  const before = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id).data;
  assert.equal(before.service.id, 'owner-primary');
  assert.equal(before.duration, 30);
  const patient = structuredClone(before.patient);
  const result = f.answer({ text: 'специалиста на Марию Соколову' }).result;
  assert.equal(result.dialogue.step, 'review');
  const after = f.flow.get(f.c, f.member, f.state, result.dialogue.id).data;
  assert.equal(after.staff.id, 'other');
  assert.equal(after.service.id, 'other-primary');
  assert.deepEqual(after.patient, patient);
  assert.equal(field(result, 'service'), 'Первичная консультация');
  assert.equal(field(result, 'duration'), '45 мин');
  assert.equal(field(result, 'date'), day);
  assert.equal(field(result, 'time'), '11:00');
  const ready = f.answer({ text: 'открой форму' }).result;
  assert.equal(ready.action.staffId, 'other');
  assert.equal(ready.action.patientId, patient.id);
  assert.deepEqual(ready.action.serviceIds, ['other-primary']);
  assert.equal(ready.action.duration, 45);
  assert.equal(ready.action.date, day);
  assert.equal(ready.action.time, '11:00');
  noSave(f);
});
