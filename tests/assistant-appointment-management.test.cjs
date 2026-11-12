const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
function fixture(
  t,
  {
    role = 'owner',
    appointments = 1,
    intent = 'moveAppointment',
    constraints = {},
    values = {},
    closed = false,
  } = {},
) {
  const {
    createAppointmentManagementFlow,
  } = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  const source = {
    id: randomUUID(),
    date: day,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
    service: 'Историческая услуга',
    serviceItems: [{ id: 'archived', name: 'Историческая услуга', duration: 30, price: 700 }],
    notes: 'Синтетическая заметка',
  };
  f.patients[0].appointments = Array.from({ length: appointments }, (_, i) => ({
    ...structuredClone(source),
    id: i ? randomUUID() : source.id,
    time: i ? '15:00' : '10:00',
  }));
  const store = f.c.tenantStore('org');
  const selected = [];
  store.readSelected = (ids) => {
    selected.push([...ids]);
    return {
      patients: f.patients.filter((row) => ids.includes(row.id)),
      services: [],
      revision: 1,
    };
  };
  store.read = () => {
    throw Error('Full cabinet scans are forbidden');
  };
  store.indexes.appointments = () =>
    f.patients.flatMap((patient) => patient.appointments).concat(f.busy);
  let writes = 0;
  for (const key of ['save', 'write', 'saveAppointment'])
    store[key] = () => {
      writes++;
      throw Error('NO_SAVE');
    };
  const tomorrow = nextDate(day);
  f.c.platform.workSchedules.view = () => ({
    days: closed
      ? {}
      : {
          [day]: { status: 'working', intervals: [['09:00', '18:00']] },
          [tomorrow]: { status: 'working', intervals: [['09:00', '18:00']] },
        },
    closures: {},
  });
  f.state.policy.commands.clients = false;
  const flow = createAppointmentManagementFlow({ memory: f.flow });
  let result;
  const start = (overrides = {}, proof = constraints) =>
    (result = flow.start(
      f.c,
      { intent, query: 'Анна Семёнова', ...values, ...overrides },
      f.state,
      f.member,
      f.clock,
      flowMemory().beginCommand(f.c, f.member, f.state),
      proof,
    ));
  const flowMemory = () => f.flow;
  const answer = (operation) => {
    const body = {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      ...operation,
    };
    result = flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    return { result, body };
  };
  t.after(() => assert.equal(writes, 0));
  return {
    ...f,
    source,
    selected,
    flow,
    start,
    answer,
    get result() {
      return result;
    },
  };
}
function noWrite(f, before) {
  assert.equal(JSON.stringify(f.patients), before);
}
function action(f, operation, date, time) {
  assert.equal(f.result.dialogue, null);
  assert.equal(f.result.action?.type, 'appointmentPreview');
  assert.equal(f.result.action.operation, operation);
  assert.equal(f.result.action.patientId, f.patients[0].id);
  assert.equal(f.result.action.appointmentId, f.source.id);
  assert.equal(typeof f.result.action.sourceStamp, 'string');
  if (date) assert.equal(f.result.action.date, date);
  if (time) assert.equal(f.result.action.time, time);
  assert.doesNotMatch(f.result.text, /сохранено|перенесена|отменена|записал/u);
}

test('a sole active future appointment cancels only as an honest preview and keeps the record untouched', (t) => {
  const f = fixture(t, { intent: 'cancelAppointment' }),
    before = JSON.stringify(f.patients);
  f.start();
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
  f.answer({ text: 'да' });
  action(f, 'cancel');
  noWrite(f, before);
  assert.match(f.result.text, /Подготовил отмену/u);
  assert.ok(f.selected.every((ids) => ids.length === 1 && ids[0] === f.patients[0].id));
});
test('generic edit opens the same existing appointment without changing historical services or duration', (t) => {
  const f = fixture(t, { intent: 'editAppointment' }),
    before = JSON.stringify(f.patients);
  f.start();
  action(f, 'edit');
  noWrite(f, before);
  assert.equal(f.result.action.date, undefined);
});
test('an explicit date and time directly prepare a move while source snapshots remain byte-identical', (t) => {
  const f = fixture(t, { values: { date: nextDate(day), time: '12:30' } }),
    before = JSON.stringify(f.patients);
  f.start();
  action(f, 'move', nextDate(day), '12:30');
  noWrite(f, before);
});
test('a clock-only move retains its proven source date; a date-only move requires an explicit clock', (t) => {
  const f = fixture(t);
  f.start({ time: '10:15' });
  action(f, 'move', day, '10:15');
  f.start({ date: nextDate(day) });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.action, null);
  f.answer({ text: 'в 10:00' });
  action(f, 'move', nextDate(day), '10:00');
});
test('a move with no target asks for date and clock without silently inheriting its source time', (t) => {
  const f = fixture(t);
  f.start();
  assert.equal(f.result.dialogue.step, 'date');
  f.answer({ text: 'завтра' });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.action, null);
  f.answer({ text: 'в 10:00' });
  action(f, 'move', nextDate(day), '10:00');
});
test('multiple appointments require a specific current source and never choose the first automatically', (t) => {
  const f = fixture(t, { appointments: 2, values: { date: nextDate(day), time: '12:30' } });
  f.start();
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'appointment');
  assert.equal(f.result.dialogue.options.length, 2);
  assert.doesNotMatch(f.result.dialogue.options[0].label, /2099-01-05/u);
  const second = f.patients[0].appointments[1];
  f.answer({ choice: f.result.dialogue.options[1].id });
  assert.equal(f.result.action.appointmentId, second.id);
  assert.equal(f.result.action.date, nextDate(day));
  assert.equal(f.result.action.time, '12:30');
});
test('source appointment dates filter cancellation only and a no-match filter never falls back to another record', (t) => {
  const f = fixture(t, { intent: 'cancelAppointment', appointments: 2 });
  f.patients[0].appointments[1].date = nextDate(day);
  f.start({ date: nextDate(day) });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  f.answer({ text: 'да' });
  assert.equal(f.result.action.appointmentId, f.patients[0].appointments[1].id);
  f.start({ date: nextDate(nextDate(day)) });
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /не найден|нет(?:[ .]|$)/iu);
});
test('an explicit ambiguous source constraint prevents silently cancelling even a sole appointment', (t) => {
  const f = fixture(t, { intent: 'cancelAppointment' });
  f.start({}, { date: null });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'appointment');
  f.answer({ text: 'сегодня' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  f.answer({ text: 'да' });
  action(f, 'cancel');
});
test('an explicit invalid destination time asks for that clock instead of falling back to the source clock', (t) => {
  const f = fixture(t);
  f.start({ date: nextDate(day) }, { time: null });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  f.answer({ text: 'в 12:30' });
  action(f, 'move', nextDate(day), '12:30');
});
test('a different booking blocks the destination; free ranges require an explicit exact clock', (t) => {
  const f = fixture(t);
  f.busy.push({
    id: randomUUID(),
    date: day,
    time: '12:00',
    duration: 60,
    staffId: 'owner',
    roomId: 'main',
  });
  f.start({ time: '12:00' });
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /занято/u);
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  f.answer({ text: 'в 14:00' });
  assert.equal(f.result.action.type, 'appointmentPreview');
  assert.notEqual(f.result.action.time, '12:00');
  assert.equal(f.result.action.appointmentId, f.source.id);
});
test('closed target dates require one owner consent and remain forbidden to an employee', async (t) => {
  for (const role of ['owner', 'salon_admin', 'cosmetologist'])
    await t.test(role, (t) => {
      const f = fixture(t, { role, closed: true, values: { date: nextDate(day), time: '12:00' } });
      f.start();
      assert.equal(f.result.dialogue.phase, 'closedDay');
      assert.equal(f.result.action, null);
      f.answer({ text: 'да-да' });
      if (role === 'cosmetologist') assert.equal(f.result.action, null);
      else action(f, 'move', nextDate(day), '12:00');
    });
});
test('an appointment changed during clarification is rejected rather than previewing a stale source', (t) => {
  const f = fixture(t);
  f.start();
  f.patients[0].appointments[0].duration = 60;
  assert.throws(() => f.answer({ text: 'завтра' }), { status: 409 });
});
test('an employee cannot preview a colleague appointment even in an otherwise visible client card', (t) => {
  const f = fixture(t, { role: 'cosmetologist', intent: 'cancelAppointment' });
  f.patients[0].appointments[0].staffId = 'colleague';
  f.start();
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /нет|не найден|не наш[её]л/iu);
});
test('completed cancelled and past appointments cannot become future-management candidates', (t) => {
  for (const mode of ['completed', 'cancelled', 'past']) {
    const f = fixture(t, { intent: 'cancelAppointment' });
    if (mode === 'past') f.patients[0].appointments[0].date = '2001-01-01';
    else f.patients[0].appointments[0].status = mode;
    f.start();
    assert.equal(f.result.action, null, mode);
  }
});
test('policy denial happens before selected-record reads and preview cancellation never cancels the actual appointment', (t) => {
  const f = fixture(t);
  f.state.policy.commands.prepareAppointment = false;
  assert.throws(() => f.start(), { status: 403 });
  assert.equal(f.selected.length, 0);
  f.state.policy.commands.prepareAppointment = true;
  const before = JSON.stringify(f.patients);
  f.start();
  f.answer({ cancel: true });
  assert.equal(f.result.action, null);
  noWrite(f, before);
});
test('the public availability path cannot exclude a fabricated appointment through values', (t) => {
  const { verifyAvailability } = require('../src/server/modules/assistant/actions/availability.cjs');
  const f = fixture(t);
  assert.equal(
    verifyAvailability(f.c, {
      date: day,
      time: '10:15',
      duration: 30,
      staffId: 'owner',
      excludeAppointmentId: f.source.id,
    }),
    null,
  );
});
test('an ambiguous explicit target remains unresolved when the user answers only the other coordinate', (t) => {
  const f = fixture(t);
  f.start({}, { date: null, time: null });
  assert.equal(f.result.dialogue.step, 'date');
  f.answer({ text: 'завтра' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  f.answer({ text: 'завтра' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  f.answer({ text: 'в 12:30' });
  action(f, 'move', nextDate(day), '12:30');
});
test('changing the date after a busy request rechecks the requested hour rather than reverting to the old appointment clock', (t) => {
  const f = fixture(t);
  f.busy.push({
    id: randomUUID(),
    date: day,
    time: '12:00',
    duration: 60,
    staffId: 'owner',
    roomId: 'main',
  });
  f.start({ time: '12:00' });
  assert.equal(f.result.action, null);
  f.answer({ text: 'завтра' });
  action(f, 'move', nextDate(day), '12:00');
});
test('a destination in the past is explained before closed-day consent and never previewed', (t) => {
  const { startsAt } = require('../src/server/modules/notifications/appointments.cjs');
  t.mock.method(Date, 'now', () => startsAt({ date: day, time: '15:00' }, 'Europe/Moscow'));
  const f = fixture(t, { closed: true });
  f.clock.hour = 15;
  f.clock.minute = 0;
  f.patients[0].appointments[0].time = '16:00';
  f.start({ time: '12:00' });
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /^Это время уже прошло\./u);
  assert.notEqual(f.result.dialogue.phase, 'closedDay');
});
test('the exclusion capability rejects a fabricated source stamp and cannot switch performer or duration', (t) => {
  const {
    verifyAppointmentMoveAvailability,
  } = require('../src/server/modules/assistant/actions/availability.cjs');
  const {
    sourceIdentity,
  } = require('../src/server/modules/assistant/actions/appointments/appointment-management-references.cjs');
  const f = fixture(t),
    identity = sourceIdentity(f.patients[0].id, f.patients[0].appointments[0]);
  assert.throws(
    () =>
      verifyAppointmentMoveAvailability(
        f.c,
        { date: day, time: '10:15', staffId: 'owner', duration: 30 },
        { ...identity, sourceStamp: 'fabricated' },
      ),
    { status: 409 },
  );
  assert.throws(
    () =>
      verifyAppointmentMoveAvailability(
        f.c,
        { date: day, time: '10:15', staffId: 'colleague', duration: 30 },
        identity,
      ),
    { status: 400 },
  );
  assert.throws(
    () =>
      verifyAppointmentMoveAvailability(
        f.c,
        { date: day, time: '10:15', staffId: 'owner', duration: 60 },
        identity,
      ),
    { status: 400 },
  );
});
test('the date-bound closed-day permission cannot authorize a different destination date', (t) => {
  const f = fixture(t, { closed: true });
  f.busy.push({
    id: randomUUID(),
    date: nextDate(day),
    time: '12:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
  });
  f.start({ date: nextDate(day), time: '12:00' });
  assert.equal(f.result.dialogue.phase, 'closedDay');
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  assert.notEqual(f.result.dialogue.phase, 'closedDay');
  f.answer({ text: 'послезавтра' });
  assert.equal(f.result.dialogue.phase, 'closedDay');
  f.answer({ text: 'да' });
  action(f, 'move', nextDate(nextDate(day)), '12:00');
});
test('a completed preview replay revalidates the exact source and other appointment bookings remain occupancy', (t) => {
  const f = fixture(t, { appointments: 2, values: { date: nextDate(day), time: '12:30' } });
  f.start();
  const selected = f.answer({ choice: f.result.dialogue.options[0].id });
  const replay = f.flow.continueDialogue(f.c, selected.body, f.state, f.member, f.clock);
  assert.deepEqual(replay, selected.result);
  f.patients[0].appointments[0].serviceItems[0].price = 800;
  assert.throws(() => f.flow.continueDialogue(f.c, selected.body, f.state, f.member, f.clock), {
    status: 409,
  });
});
test('explicit temporal ambiguity survives client clarification without leaking proof into the model intent', (t) => {
  const f = fixture(t);
  f.start({ query: 'Неизвестный Клиент' }, { date: null, time: null });
  assert.equal(f.result.dialogue.step, 'client');
  f.answer({ text: 'Анна Семёнова' });
  assert.equal(f.result.dialogue.step, 'date');
  f.answer({ text: 'завтра' });
  assert.equal(f.result.dialogue.step, 'time');
  f.answer({ text: 'в 12:30' });
  action(f, 'move', nextDate(day), '12:30');
});

test('pending source receipt retries preserve the original opaque choices and version when nothing changed', (t) => {
  const f = fixture(t, { appointments: 2, values: { date: nextDate(day), time: '12:30' } });
  f.start();
  const accepted = f.answer({ text: 'да' });
  const first = structuredClone(accepted.result);
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.deepEqual(replay, first);
  const chosen = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: first.dialogue.id,
      dialogueVersion: first.dialogue.version,
      choice: first.dialogue.options[1].id,
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(chosen.action?.appointmentId, f.patients[0].appointments[1].id);
});
test('changed pending source receipt bumps its version and asks about the remaining appointment instead of executing it', (t) => {
  const f = fixture(t, { appointments: 2, values: { date: nextDate(day), time: '12:30' } });
  f.start();
  const accepted = f.answer({ text: 'да' });
  const first = structuredClone(accepted.result);
  f.patients[0].appointments[0].status = 'cancelled';
  f.changed();
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(replay.action, null);
  assert.equal(replay.dialogue.step, 'appointment');
  assert.equal(replay.dialogue.version, first.dialogue.version + 1);
  assert.equal(replay.dialogue.options.length, 1);
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        {
          dialogueId: first.dialogue.id,
          dialogueVersion: first.dialogue.version,
          choice: first.dialogue.options[1].id,
        },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  const chosen = f.flow.continueDialogue(
    f.c,
    {
      dialogueId: replay.dialogue.id,
      dialogueVersion: replay.dialogue.version,
      choice: replay.dialogue.options[0].id,
    },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(chosen.action?.appointmentId, f.patients[0].appointments[1].id);
});
test('pending availability receipt keeps stable proposals and refreshes changed occupancy with a new version', (t) => {
  const f = fixture(t);
  f.busy.push({
    id: randomUUID(),
    date: day,
    time: '12:00',
    duration: 60,
    staffId: 'owner',
    roomId: 'main',
  });
  f.start({ time: '12:00' });
  const accepted = f.answer({ text: 'повтори' });
  const first = structuredClone(accepted.result);
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.deepEqual(replay, first);
  f.busy.push({
    id: randomUUID(),
    date: day,
    time: '11:30',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
  });
  const changed = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(changed.action, null);
  assert.equal(changed.dialogue.phase, 'period');
  assert.equal(changed.dialogue.version, first.dialogue.version + 1);
  assert.notEqual(changed.dialogue.options[0].label, first.dialogue.options[0].label);
});
test('completed move receipt rechecks occupancy and reopens a usable pending dialogue when the old target became busy', (t) => {
  const f = fixture(t);
  f.start();
  const accepted = f.answer({ text: 'завтра в 10:00' });
  assert.equal(accepted.result.action?.type, 'appointmentPreview');
  f.busy.push({
    id: randomUUID(),
    date: nextDate(day),
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
  });
  const replay = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(replay.action, null);
  assert.equal(replay.dialogue.phase, 'period');
  const chosen = f.flow.continueDialogue(
    f.c,
    { dialogueId: replay.dialogue.id, dialogueVersion: replay.dialogue.version, text: 'в 14:00' },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(chosen.action?.type, 'appointmentPreview');
  assert.notEqual(chosen.action.time, '10:00');
});

test('a terminal receipt without an action cannot execute a newly added appointment on a later identical retry', (t) => {
  const f = fixture(t, { appointments: 2, values: { date: nextDate(day), time: '12:30' } });
  f.start();
  const original = structuredClone(f.patients[0].appointments[0]);
  const accepted = f.answer({ text: 'да' });
  f.patients[0].appointments.splice(0);
  f.changed();
  const empty = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(empty.action, null);
  assert.equal(empty.dialogue, null);
  f.patients[0].appointments.push({ ...original, id: randomUUID() });
  f.changed();
  const changed = f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock);
  assert.equal(changed.action, null);
  assert.equal(changed.dialogue.step, 'appointment');
  assert.equal(changed.dialogue.options.length, 1);
});

test('zero-minute spoken clocks preserve the bound source while preparing an ordinary move', (t) => {
  for (const raw of ['16 ноль ноль', 'шестнадцать нуль нуль', '16 0 0', 'шестнадцатьноль-ноль']) {
    const f = fixture(t),
      before = JSON.stringify(f.patients);
    f.start();
    f.answer({ text: 'На завтра в ' + raw });
    action(f, 'move', nextDate(day), '16:00');
    noWrite(f, before);
  }
});
