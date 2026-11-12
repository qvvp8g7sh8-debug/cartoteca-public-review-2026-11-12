const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const field = (result, key) => result.dialogue?.fields.find((row) => row.key === key)?.value;
function fixture() {
  const f = dialogueFixture();
  f.patients.push({
    ...f.patients[0],
    id: randomUUID(),
    firstName: 'Ольга',
    name: 'Ольга Семёнова',
    phone: '+79990000002',
    appointments: [],
  });
  f.members.push({
    accountId: 'other',
    displayName: 'Мария Соколова',
    role: 'cosmetologist',
    status: 'active',
  });
  f.services.push(
    { id: 'consult', name: 'Консультация', duration: 60, staffId: 'owner' },
    { id: 'massage', name: 'Массаж', duration: 45, staffId: 'other' },
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
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day, duration: 30 });
  assert.equal(f.result.dialogue.phase, 'period');
  f.answer({ text: 'любое время' });
  assert.equal(f.result.dialogue.phase, 'slots');
  const offered = f.result;
  f.answer({ choice: offered.dialogue.options[0].id });
  assert.equal(f.result.dialogue.step, 'review');
  return { f, offered, selectedTime: field(f.result, 'time') };
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('changing the client after choosing a window preserves the selected slot and opens only the new client form', () => {
  const { f, selectedTime } = fixture();
  f.answer({ text: 'клиента на Ольгу Семёнову' });
  assert.match(field(f.result, 'client'), /Ольга/);
  assert.equal(field(f.result, 'time'), selectedTime);
  const result = f.answer({ text: 'открой форму' }).result;
  assert.equal(result.action.patientId, f.patients[1].id);
  assert.equal(result.action.time, selectedTime);
  noSave(f);
});

test('changing the service after choosing a window retains explicitly selected duration and rechecks the final service', () => {
  const { f, selectedTime } = fixture();
  f.answer({ text: 'услугу на консультацию' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(field(f.result, 'duration'), '30 мин');
  const result = f.answer({ text: 'открой' }).result;
  assert.deepEqual(result.action.serviceIds, ['consult']);
  assert.equal(result.action.duration, 30);
  assert.equal(result.action.time, selectedTime);
  noSave(f);
});

test('changing the performer after choosing a window clears the old service and accepts only the new performer catalog', () => {
  const { f, selectedTime } = fixture();
  f.answer({ text: 'специалиста на Марию Соколову' });
  assert.equal(f.result.dialogue.step, 'service');
  assert.equal(field(f.result, 'service'), undefined);
  assert.equal(field(f.result, 'time'), selectedTime);
  assert.ok(
    f.result.dialogue.options.every(
      (row) => !row.label.includes('Чистка') && !row.label.includes('Консультация'),
    ),
  );
  f.answer({ text: 'Массаж' });
  const result = f.answer({ text: 'открой форму' }).result;
  assert.equal(result.action.staffId, 'other');
  assert.deepEqual(result.action.serviceIds, ['massage']);
  assert.equal(result.action.duration, 30);
  noSave(f);
});

test('an old window or review option cannot be reused after returning to client clarification', () => {
  const { f, offered } = fixture();
  const readyId = f.result.dialogue.options[0].id;
  f.answer({ edit: 'client' });
  const before = structuredClone(f.flow.get(f.c, f.member, f.state, f.result.dialogue.id).data);
  for (const choice of [offered.dialogue.options[0].id, readyId])
    assert.throws(() => f.answer({ choice }), { status: 409 });
  assert.deepEqual(f.flow.get(f.c, f.member, f.state, f.result.dialogue.id).data, before);
  assert.equal(f.result.dialogue.step, 'client');
  noSave(f);
});

test('occupancy changing after review produces fresh alternatives before any form handoff', () => {
  const { f, selectedTime } = fixture();
  f.busy.push({ date: day, time: selectedTime, duration: 30, staffId: 'owner', roomId: 'main' });
  const result = f.answer({ text: 'открой' }).result;
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'time');
  assert.match(field(result, 'client'), /Анна/);
  assert.ok(result.dialogue.options.every((row) => !row.label.includes(selectedTime + '–')));
  noSave(f);
});

test('an exact handoff retry remains manual and a different new command cannot repeat the completed dialogue', () => {
  const { f } = fixture();
  const accepted = f.answer({ text: 'открой' });
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.deepEqual(replay.action, accepted.result.action);
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { ...accepted.body, text: 'запиши' },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  noSave(f);
});

test('write and save utterances cannot bypass missing client or service data', () => {
  const f = dialogueFixture();
  f.start({ date: day, time: '10:00' });
  for (const text of ['запиши', 'сохрани запись']) {
    const result = f.answer({ text }).result;
    assert.equal(result.action, null);
    assert.equal(result.dialogue.step, 'client');
  }
  noSave(f);
});

test('save or unrelated compound commands at review never create an appointment or open an unrequested action', () => {
  const { f } = fixture();
  for (const text of ['сохрани', 'запиши и отправь клиенту', 'открой карточку клиента']) {
    const result = f.answer({ text }).result;
    assert.equal(result.action, null);
    assert.equal(result.dialogue.step, 'review');
  }
  noSave(f);
});

test('write at a fully reviewed draft opens its ordinary form for manual saving', () => {
  const { f, selectedTime } = fixture();
  const result = f.answer({ text: 'запиши' }).result;
  assert.equal(result.action?.type, 'prepareAppointment');
  assert.equal(result.action.patientId, f.patients[0].id);
  assert.equal(result.action.time, selectedTime);
  assert.equal(result.dialogue, null);
  noSave(f);
});

test('cancelling after window selection prevents later write confirmation from reviving the draft', () => {
  const { f } = fixture();
  const id = f.result.dialogue.id;
  const result = f.answer({ text: 'отмена' }).result;
  assert.equal(result.action, null);
  assert.equal(result.dialogue, null);
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { dialogueId: id, dialogueVersion: 0, text: 'запиши' },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  noSave(f);
});
