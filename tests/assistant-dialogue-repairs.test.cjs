const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRepair } = require('../src/server/modules/assistant/dialogue/dialogue-repair-apply.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const complete = { query: 'Анну Семенову', serviceQuery: 'Чистка', date: day, time: '10:00' };
const field = (result, key) => result.dialogue.fields.find((row) => row.key === key)?.value;
function current(f) {
  return f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
}
function otherDays(f) {
  f.c.platform.workSchedules.view = () => ({
    days: Object.fromEntries(
      [day, '2099-01-06', '2099-01-07'].map((date) => [
        date,
        { status: 'working', intervals: [['09:00', '18:00']] },
      ]),
    ),
    closures: {},
  });
}

test('repair patches validate all values before replacing any selected booking field', () => {
  const f = dialogueFixture();
  f.start(complete);
  const entry = current(f),
    before = structuredClone(entry.data);
  const result = applyRepair(
    entry,
    {
      kind: 'patch',
      edits: [
        { field: 'duration', text: '45 минут' },
        { field: 'time', text: '25:00' },
      ],
    },
    f.clock,
  );
  assert.match(result.message, /не применены/);
  assert.deepEqual(entry.data, before);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('repair dependency order clears old specialist service and preserves unrelated selected values', () => {
  const f = dialogueFixture();
  f.start(complete);
  const entry = current(f),
    patient = structuredClone(entry.data.patient);
  const result = applyRepair(
    entry,
    {
      kind: 'patch',
      edits: [
        { field: 'service', text: 'Консультация' },
        { field: 'duration', text: '45 минут' },
        { field: 'staff', text: 'Новый Специалист' },
      ],
    },
    f.clock,
  );
  assert.deepEqual(result, {});
  assert.deepEqual(entry.data.patient, patient);
  assert.equal(entry.data.date, day);
  assert.equal(entry.data.time, '10:00');
  assert.equal(entry.data.staff, null);
  assert.equal(entry.data.staffQuery, 'Новый Специалист');
  assert.equal(entry.data.serviceQuery, 'Консультация');
  assert.equal(entry.data.service, null);
  assert.equal(entry.data.duration, 45);
  assert.equal(entry.data.durationSource, 'manual');
  assert.equal(entry.data.roomId, '');
});

test('relative time uses the selected clock value and never crosses midnight implicitly', () => {
  const entry = { data: { date: day, time: '10:00', duration: 30, roomId: 'main' } };
  assert.deepEqual(applyRepair(entry, { kind: 'shiftTime', minutes: 30 }, { date: day }), {});
  assert.equal(entry.data.time, '10:30');
  assert.equal(entry.data.roomId, '');
  for (const [time, minutes] of [
    ['23:45', 30],
    ['00:15', -30],
  ]) {
    entry.data.time = time;
    const before = structuredClone(entry.data);
    assert.match(
      applyRepair(entry, { kind: 'shiftTime', minutes }, { date: day }).message,
      /меняет день/,
    );
    assert.deepEqual(entry.data, before);
  }
  const missing = { data: { date: day } };
  assert.match(
    applyRepair(missing, { kind: 'shiftTime', minutes: 30 }, { date: day }).message,
    /исходные дату и время/,
  );
  assert.deepEqual(missing.data, { date: day });
});

test('relative dates require a selected date and reject past dates without partial mutation', () => {
  const entry = { data: { date: day, time: '10:00', duration: 30 } };
  assert.deepEqual(applyRepair(entry, { kind: 'shiftDate', days: 1 }, { date: day }), {});
  assert.equal(entry.data.date, '2099-01-06');
  const before = structuredClone(entry.data);
  assert.match(
    applyRepair(entry, { kind: 'shiftDate', days: -2 }, { date: day }).message,
    /не применены/,
  );
  assert.deepEqual(entry.data, before);
  assert.match(
    applyRepair({ data: {} }, { kind: 'shiftDate', days: 1 }, { date: day }).message,
    /исходную дату/,
  );
});

test('explicit corrections work at another missing step without becoming a client query', () => {
  const f = dialogueFixture();
  f.start({ ...complete, query: undefined });
  assert.equal(f.result.dialogue.step, 'client');
  const result = f.answer({ text: 'поменяй время на 11:30' }).result;
  assert.equal(result.dialogue.step, 'client');
  assert.equal(field(result, 'time'), '11:30');
  assert.equal(current(f).data.clientQuery, '');
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('relative spoken corrections preserve booking identity and only explicit review opens a manual form', () => {
  const f = dialogueFixture();
  otherDays(f);
  f.start(complete);
  f.answer({ text: 'на полчаса позже' });
  assert.equal(field(f.result, 'time'), '10:30');
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.action, null);
  f.answer({ text: 'на день позже' });
  assert.equal(field(f.result, 'date'), '2099-01-06');
  assert.equal(field(f.result, 'time'), '10:30');
  assert.match(field(f.result, 'client'), /Анна/);
  assert.equal(f.result.action, null);
  const done = f.answer({ text: 'открой форму' }).result;
  assert.equal(done.action.type, 'prepareAppointment');
  assert.equal(done.action.date, '2099-01-06');
  assert.equal(done.action.time, '10:30');
  assert.equal(done.action.patientId, f.patients[0].id);
  assert.match(done.text, /^Подготовил запись: /u);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('client correction resolves a declined existing full name and preserves the other fields', () => {
  const f = dialogueFixture({ ambiguous: true });
  f.start(complete);
  f.answer({ text: 'поменяй клиента на Ольгу Семёнову' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.match(field(f.result, 'client'), /Ольга/);
  assert.equal(field(f.result, 'time'), '10:00');
  const done = f.answer({ text: 'открой форму' }).result;
  assert.equal(done.action.patientId, f.patients[1].id);
  assert.equal(
    f.patients.every((patient) => patient.appointments.length === 0),
    true,
  );
});

test('save requests and another task return local guidance without changing the booking', () => {
  const f = dialogueFixture();
  f.start(complete);
  for (const text of ['сохрани запись', 'покажи расписание на неделю', 'попозже']) {
    const before = structuredClone(current(f).data),
      version = f.result.dialogue.version;
    const accepted = f.answer({ text });
    assert.equal(accepted.result.action, null, text);
    assert.equal(accepted.result.dialogue.version, version + 1, text);
    assert.deepEqual(current(f).data, before, text);
    assert.deepEqual(
      f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock),
      accepted.result,
    );
  }
  assert.equal(f.patients[0].appointments.length, 0);
});

test('a corrected occupied time presents current real windows and never opens a form automatically', () => {
  const f = dialogueFixture();
  f.start(complete);
  f.busy.push({ date: day, time: '10:30', duration: 30, staffId: 'owner', roomId: 'main' });
  f.answer({ text: 'на полчаса позже' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  assert.ok(f.result.dialogue.options.length > 0);
  assert.ok(f.result.dialogue.options.every((option) => !option.label.includes('10:30–')));
  assert.match(field(f.result, 'client'), /Анна/);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('new repairs keep version and account scope checks and cannot reuse an old option', () => {
  const f = dialogueFixture();
  const initial = f.start(complete);
  const accepted = f.answer({ text: 'поменяй время на 11:30' });
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { ...accepted.body, text: 'поменяй время на 12:00' },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  assert.throws(
    () =>
      f.flow.continueDialogue(
        { ...f.c, current: { ...f.c.current, accountId: 'other' } },
        { ...accepted.body, dialogueVersion: accepted.result.dialogue.version },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  assert.throws(() => f.answer({ choice: initial.dialogue.options[0].id }), { status: 409 });
  assert.equal(f.result.action, null);
});

test('a multipart spoken correction applies together and preserves the prepared client', () => {
  const f = dialogueFixture();
  otherDays(f);
  f.start(complete);
  const result = f.answer({ text: 'поменяй дату на завтра, время на 11:30' }).result;
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'review');
  assert.equal(field(result, 'date'), '2099-01-06');
  assert.equal(field(result, 'time'), '11:30');
  assert.match(field(result, 'client'), /Анна/);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('availability search accepts date corrections before a slot is selected and invalidates old choices', () => {
  const f = dialogueFixture();
  otherDays(f);
  const ticket = f.flow.beginCommand(f.c, f.member, f.state);
  const initial = f.flow.startAvailability(
    f.c,
    {
      text: 'Найдены окна',
      action: null,
      slots: [
        {
          date: day,
          time: '10:00',
          endTime: '10:30',
          duration: 30,
          staffId: 'owner',
          staffName: 'Тестовый Специалист',
          roomId: 'main',
        },
      ],
    },
    f.state,
    f.member,
    f.clock,
    ticket,
    { intent: 'availability', date: day, duration: 30 },
  );
  const corrected = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: initial.dialogue.id,
      dialogueVersion: initial.dialogue.version,
      text: 'поменяй дату на завтра',
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(corrected.action, null);
  assert.equal(corrected.dialogue.step, 'availability');
  assert.ok(corrected.dialogue.options.length > 0);
  assert.ok(corrected.dialogue.options.every((option) => option.label.startsWith('2099-01-06')));
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        {
          dialogueId: corrected.dialogue.id,
          dialogueVersion: corrected.dialogue.version,
          choice: initial.dialogue.options[0].id,
        },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  const guided = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: corrected.dialogue.id,
      dialogueVersion: corrected.dialogue.version,
      text: 'поменяй дату',
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(guided.dialogue.step, 'availability');
  assert.match(guided.text, /новое значение/);
  assert.equal(f.patients[0].appointments.length, 0);
});


function prepare(f, text) {
  return f.flow.prepareModelTurn(f.c, {
    policyVersion: f.state.revision, dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version, text,
  }, f.state, f.member, f.clock);
}
function additionalStaff(f, sameService = false) {
  f.members.push({ accountId: 'other', displayName: 'Елена Петрова', role: 'cosmetologist', status: 'active' });
  f.services.push({ id: 'other-service', name: sameService ? 'Чистка' : 'Массаж', duration: 45, staffId: 'other' });
  const settings = f.c.platform.workspaceSettings();
  settings.rooms[0].staffIds.push('other');
  settings.rooms[0].staffMode = 'multiple';
  f.c.platform.workspaceSettings = () => settings;
}
function slots(f) {
  return [...current(f).options.values()].filter((row) => row.kind === 'slot').map((row) => row.value);
}

test('explicit replacement grammar targets the new value and retains ambiguity boundaries', () => {
  const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
  const entry = { step: 'client', data: {}, options: new Map() };
  for (const [text, expected] of [
    ['услугу вместо чистки на массаж', { kind: 'patch', edits: [{ field: 'service', text: 'массаж' }], confirm: false }],
    ['поменяй клиента вместо Анны Семеновой на Ольгу Семенову', { kind: 'patch', edits: [{ field: 'client', text: 'ольгу семенову' }], confirm: false }],
    ['дату вместо сегодня на завтра', { kind: 'patch', edits: [{ field: 'date', text: '2099-01-06' }], confirm: false }],
    ['время вместо 10:00 на 12:00', { kind: 'patch', edits: [{ field: 'time', text: '12:00' }], confirm: false }],
    ['другой клиент', { kind: 'edit', field: 'client' }],
    ['другая услуга', { kind: 'edit', field: 'service' }],
    ['другого сотрудника', { kind: 'edit', field: 'staff' }],
    ['время не подходит', { kind: 'rejectTime' }],
    ['покажи другое время', { kind: 'rejectTime' }],
  ]) assert.deepEqual(repairOperation(entry, text, { date: day }), expected, text);
  for (const text of ['услугу вместо чистки на массаж или консультацию', 'время не подходит или завтра', 'не в 10:00, а в 12:00'])
    assert.equal(repairOperation(entry, text, { date: day }).kind, 'localHelp', text);
});

test('each explicit field edit focuses that field while an earlier client answer is missing', () => {
  for (const [text, target] of [
    ['другой клиент', 'client'], ['поменяй услугу', 'service'],
    ['измени дату', 'date'], ['поменяй время', 'time'], ['поменяй сотрудника', 'staff'],
  ]) {
    const f = dialogueFixture();
    additionalStaff(f);
    f.start({ ...complete, query: undefined });
    const before = structuredClone(current(f).data);
    assert.equal(prepare(f, text), null, 'Strict edit does not need an LLM call: ' + text);
    f.answer({ text });
    assert.equal(f.result.dialogue.step, target, text);
    const data = current(f).data;
    assert.equal(data.clientQuery, '', text);
    if (target !== 'date') assert.equal(data.date, before.date, text);
    if (target !== 'time') assert.equal(data.time, before.time, text);
    assert.equal(f.result.action, null, text);
    assert.equal(f.patients[0].appointments.length, 0, text);
  }
});

test('changing a service before the missing client returns to that client only after choosing the service', () => {
  const f = dialogueFixture();
  f.services.push({ id: 'consult', name: 'Консультация', duration: 45, staffId: 'owner' });
  f.start({ ...complete, query: undefined });
  f.answer({ text: 'поменяй услугу' });
  assert.equal(f.result.dialogue.step, 'service');
  f.answer({ text: 'Консультация' });
  assert.equal(f.result.dialogue.step, 'client');
  assert.match(field(f.result, 'service'), /Консультация/);
  assert.equal(field(f.result, 'date'), day);
  assert.equal(field(f.result, 'time'), '10:00');
  f.answer({ text: 'Анна Семенова' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(field(f.result, 'duration'), '45 мин');
});

test('a client edit during an unresolved service keeps that service query and all temporal fields', () => {
  const f = dialogueFixture({ ambiguous: true });
  f.start({ ...complete, serviceQuery: 'Неизвестная услуга' });
  assert.equal(f.result.dialogue.step, 'service');
  f.answer({ text: 'другой клиент' });
  assert.equal(f.result.dialogue.step, 'client');
  f.answer({ text: 'Ольга Семенова' });
  assert.equal(f.result.dialogue.step, 'service');
  assert.match(field(f.result, 'client'), /Ольга/);
  assert.equal(current(f).data.serviceQuery, 'Неизвестная услуга');
  assert.equal(current(f).data.date, day);
  assert.equal(current(f).data.time, '10:00');
});

test('full named values correct client service date and time at another step without a model or lost fields', () => {
  const f = dialogueFixture({ ambiguous: true });
  otherDays(f);
  f.services.push({ id: 'consult', name: 'Консультация', duration: 45, staffId: 'owner' });
  f.start({ ...complete, query: undefined });
  for (const text of ['услугу вместо чистки на консультацию', 'дату на завтра', 'время на 12:00', 'клиента на Ольгу Семенову']) {
    assert.equal(prepare(f, text), null, text);
    f.answer({ text });
  }
  assert.equal(f.result.dialogue.step, 'review');
  assert.match(field(f.result, 'client'), /Ольга/);
  assert.match(field(f.result, 'service'), /Консультация/);
  assert.equal(field(f.result, 'date'), '2099-01-06');
  assert.equal(field(f.result, 'time'), '12:00');
  assert.equal(f.result.action, null);
});

test('a specialist change resolves the same full service in the new catalog and rechecks its whole duration', () => {
  const f = dialogueFixture();
  additionalStaff(f, true);
  f.start(complete);
  const original = structuredClone(current(f).data);
  f.answer({ text: 'специалиста на Елену Петрову' });
  assert.equal(f.result.dialogue.step, 'review');
  const data = current(f).data;
  assert.equal(data.staff.id, 'other');
  assert.equal(data.service.id, 'other-service');
  assert.equal(data.duration, 45);
  assert.deepEqual(data.patient, original.patient);
  assert.equal(data.date, original.date);
  assert.equal(data.time, original.time);
  f.busy.push({ date: day, time: '10:30', duration: 30, staffId: 'other', roomId: 'main' });
  f.answer({ text: 'специалиста на Елену Петрову' });
  assert.equal(f.result.dialogue.step, 'time', 'A newly occupied part of the longer service prevents readiness');
  assert.equal(f.result.action, null);
});

test('an unavailable service after a specialist change retains its name and asks only that dependent field', () => {
  const f = dialogueFixture();
  additionalStaff(f);
  f.start({ ...complete, query: undefined });
  const accepted = f.answer({ text: 'специалиста на Елену Петрову' });
  assert.equal(f.result.dialogue.step, 'service');
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(replay.dialogue.step, 'service', 'An exact retry must keep the explicitly requested dependent field');
  assert.deepEqual(replay, accepted.result);
  const data = current(f).data;
  assert.equal(data.staff.id, 'other');
  assert.equal(data.service, null);
  assert.equal(data.serviceQuery, 'Чистка');
  assert.equal(data.date, day);
  assert.equal(data.time, '10:00');
  assert.equal(data.clientQuery, '');
  assert.equal(data.patient, null);
});

test('a closed-day consent stays bound to its exact performer and date after a specialist change', () => {
  const f = dialogueFixture();
  additionalStaff(f, true);
  f.c.platform.workSchedules.view = () => ({ days: {}, closures: {} });
  f.start(complete);
  assert.equal(f.result.dialogue.phase, 'closedDay');
  f.answer({ text: 'да' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(current(f).data.closedDayConfirmation, day + '|owner');
  f.answer({ text: 'специалиста на Елену Петрову' });
  assert.equal(f.result.dialogue.phase, 'closedDay');
  assert.equal(current(f).data.staff.id, 'other');
  assert.equal(current(f).data.closedDayConfirmation, day + '|owner');
  assert.equal(f.result.action, null);
});

test('rejecting the selected clock offers fresh fitting starts on the same date and replay does not advance again', () => {
  const f = dialogueFixture();
  f.start(complete);
  const before = structuredClone(current(f).data);
  assert.equal(prepare(f, 'время не подходит'), null);
  const first = f.answer({ text: 'время не подходит' });
  assert.equal(f.result.dialogue.phase, 'slots');
  assert.ok(slots(f).length);
  assert.ok(slots(f).every((slot) => slot.date === day && slot.time !== before.time));
  const data = current(f).data;
  for (const key of ['patient', 'staff', 'service', 'date', 'duration']) assert.deepEqual(data[key], before[key], key);
  const history = structuredClone(data.shownSlots);
  assert.deepEqual(f.flow.continueDialogue(f.c, first.body, f.state, f.member, f.clock), first.result);
  assert.deepEqual(current(f).data.shownSlots, history);
  const firstSlots = slots(f);
  f.busy.push({ ...firstSlots[0], duration: 30 });
  f.answer({ text: 'другое время' });
  assert.ok(slots(f).length);
  const rejected = new Set([before.time, ...firstSlots.map((slot) => slot.time)]);
  assert.ok(slots(f).every((slot) => !rejected.has(slot.time) && slot.date === day));
  assert.equal(f.patients[0].appointments.length, 0);
  assert.equal(f.result.action, null);
  assert.doesNotMatch(f.result.text, /Слышу отрицание|несколько возможных/);
});

test('rejecting displayed starts does not repeat the previous page or cross to another day', () => {
  const f = dialogueFixture();
  f.start({ ...complete, time: undefined });
  f.answer({ text: 'любое время' });
  const shown = slots(f);
  assert.ok(shown.length > 1);
  f.answer({ text: 'время не подходит' });
  assert.ok(slots(f).length);
  assert.ok(slots(f).every((slot) => slot.date === day && !shown.some((old) => old.time === slot.time)));
  assert.equal(current(f).data.service.id, 'clean');
  assert.equal(current(f).data.duration, 30);
});

test('repair focus never expands employee scope and old choice/version checks still apply', () => {
  const f = dialogueFixture({ role: 'cosmetologist' });
  f.members[0].role = 'cosmetologist';
  additionalStaff(f, true);
  f.start(complete);
  const old = f.result;
  f.answer({ text: 'специалиста на Елену Петрову' });
  assert.equal(f.result.dialogue.step, 'staff');
  assert.ok([...current(f).options.values()].every((row) => row.value === 'owner'));
  assert.equal(f.result.action, null);
  assert.throws(() => f.answer({ choice: old.dialogue.options[0].id }), { status: 409 });
  assert.throws(() => f.flow.continueDialogue(
    { ...f.c, current: { ...f.c.current, accountId: 'other' } },
    { dialogueId: f.result.dialogue.id, dialogueVersion: f.result.dialogue.version, text: 'время на 12:00' },
    f.state, f.member, f.clock,
  ), { status: 409 });
});
