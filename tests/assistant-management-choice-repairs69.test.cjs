const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');

function fixture(
  t,
  { rows = [{}], intent = 'moveAppointment', role = 'owner', values = {}, proof = {} } = {},
) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  f.patients[0].appointments = rows.map((row) => ({
    id: randomUUID(),
    date: day,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
    service: 'Историческая услуга',
    status: 'scheduled',
    ...row,
  }));
  const store = f.c.tenantStore('org');
  store.readSelected = (ids) => ({
    patients: f.patients.filter((p) => ids.includes(p.id)),
    services: [],
    revision: 1,
  });
  store.read = () => {
    throw Error('No full cabinet scan');
  };
  store.indexes.appointments = () => f.patients.flatMap((p) => p.appointments).concat(f.busy);
  let writes = 0;
  for (const key of ['save', 'write', 'saveAppointment'])
    store[key] = () => {
      writes++;
      throw Error('No writes');
    };
  f.c.platform.workSchedules.view = () => ({
    days: Object.fromEntries(
      [...new Set([day, nextDate(day), ...f.patients[0].appointments.map((row) => row.date)])].map(
        (date) => [date, { status: 'working', intervals: [['09:00', '18:00']] }],
      ),
    ),
    closures: {},
  });
  f.state.policy.commands.clients = false;
  const flow = createAppointmentManagementFlow({ memory: f.flow });
  let result, id;
  const start = () => {
    result = flow.start(
      f.c,
      { intent, query: 'Анна Семёнова', ...values },
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
      proof,
    );
    id = result.dialogue?.id;
    return result;
  };
  const answer = (operation) => {
    const body = {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      ...operation,
    };
    result = flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    return { result, body };
  };
  const snapshot = JSON.stringify(f.patients);
  t.after(() => {
    assert.equal(writes, 0);
    assert.equal(JSON.stringify(f.patients), snapshot);
  });
  return {
    ...f,
    start,
    answer,
    flow,
    entry: () => f.flow.get(f.c, f.member, f.state, id),
    get result() {
      return result;
    },
  };
}

for (const raw of ['другое время', 'время не подходит', 'предложи другое время']) {
  test('move rejects an exact offer without losing its source or date: ' + raw, (t) => {
    const f = fixture(t, {
      values: { date: nextDate(day), time: '12:00' },
      proof: { nearestRequested: 'nearest' },
    });
    f.busy.push({
      id: randomUUID(),
      date: nextDate(day),
      time: '12:00',
      duration: 60,
      staffId: 'owner',
      roomId: 'main',
    });
    f.start();
    assert.equal(f.result.dialogue.phase, 'slots');
    const before = structuredClone(f.entry().data.management);
    const rejected = [...f.entry().options.values()][0].value.time;
    const { body } = f.answer({ text: raw });
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue.phase, 'period');
    const m = f.entry().data.management;
    assert.deepEqual(m.source, before.source);
    assert.equal(m.targetDate, nextDate(day));
    assert.equal(m.targetTime, null);
    assert.equal(m.timeRequired, true);
    assert.equal(m.nearestRequested, null);
    assert.ok(m.rejectedTargetTimes.includes(rejected));
    const version = f.result.dialogue.version;
    const replay = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    assert.equal(replay.dialogue.version, version);
    f.answer({ text: 'ближайшее свободное время' });
    assert.equal(f.result.dialogue.phase, 'slots');
    assert.notEqual([...f.entry().options.values()][0].value.time, rejected);
  });
}

test('rejecting the displayed final ranges asks a precise clock rather than repeating them', (t) => {
  const f = fixture(t, { values: { date: nextDate(day), time: '12:00' } });
  f.busy.push({
    id: randomUUID(),
    date: nextDate(day),
    time: '12:00',
    duration: 60,
    staffId: 'owner',
    roomId: 'main',
  });
  f.start();
  assert.equal(f.result.dialogue.phase, 'period');
  f.answer({ text: 'другое время' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.dialogue.options.length, 0);
  assert.match(f.result.dialogue.prompt, /На какое время.*другую дату/u);
  assert.equal(f.entry().data.management.targetDate, nextDate(day));
});

test('rejecting a range page shows the remaining existing ranges only once', (t) => {
  const f = fixture(t, { values: { date: nextDate(day), time: '10:00' } });
  for (const time of ['10:00', '11:00', '12:00', '13:00'])
    f.busy.push({
      id: randomUUID(),
      date: nextDate(day),
      time,
      duration: 30,
      staffId: 'owner',
      roomId: 'main',
    });
  f.start();
  const first = f.result.dialogue.options.map((row) => row.label);
  assert.ok([...f.entry().controls.values()].some((row) => row.kind === 'managementMoreRanges'));
  f.answer({ text: 'время не подходит' });
  assert.equal(f.result.dialogue.phase, 'period');
  assert.ok(f.result.dialogue.options.every((row) => !first.includes(row.label)));
  f.answer({ text: 'другое время' });
  assert.equal(f.result.dialogue.options.length, 0);
  assert.equal(f.result.action, null);
});

test('a rejected suggestion is a preference, not an artificial occupied clock', (t) => {
  const f = fixture(t, {
    values: { date: nextDate(day), time: '12:00' },
    proof: { nearestRequested: 'nearest' },
  });
  f.busy.push({
    id: randomUUID(),
    date: nextDate(day),
    time: '12:00',
    duration: 60,
    staffId: 'owner',
    roomId: 'main',
  });
  f.start();
  const time = [...f.entry().options.values()][0].value.time;
  f.answer({ text: 'другое время' });
  f.answer({ text: 'в ' + time });
  assert.equal(f.result.action?.type, 'appointmentPreview');
  assert.equal(f.result.action.time, time);
});

for (const raw of ['на чистку', 'ту, что на чистку', 'чистку']) {
  test('source selection uses the real historical service with no live catalog: ' + raw, (t) => {
    const f = fixture(t, { rows: [{ service: 'Чистка' }, { time: '15:00', service: 'Пилинг' }] });
    f.services.splice(0);
    f.start();
    assert.equal(f.result.dialogue.phase, 'appointmentChoice');
    f.answer({ text: raw });
    assert.equal(f.entry().data.management.source?.appointmentId, f.patients[0].appointments[0].id);
    assert.equal(f.result.dialogue.step, 'date');
    assert.equal(f.result.action, null);
    assert.equal(f.entry().data.management.targetTime, null);
  });
}

test('a historical service item selects its actual composite appointment and still requires cancellation consent', (t) => {
  const f = fixture(t, {
    intent: 'cancelAppointment',
    rows: [
      { service: 'Архивный комплекс', serviceItems: [{ id: 'old', name: 'Чистка', duration: 30 }] },
      { service: 'Пилинг', time: '15:00' },
    ],
  });
  f.start();
  f.answer({ text: 'на чистку' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.action?.operation, 'cancel');
  assert.equal(f.result.action.appointmentId, f.patients[0].appointments[0].id);
});

test('matching several actual services asks the source time and preserves destination uncertainty', (t) => {
  const f = fixture(t, {
    rows: [{ service: 'Чистка' }, { service: 'Чистка', time: '15:00' }],
    proof: { date: null, time: null },
  });
  f.start();
  f.answer({ text: 'на чистку' });
  assert.equal(f.result.dialogue.prompt, 'Во сколько запись?');
  assert.equal(f.result.dialogue.options.length, 2);
  assert.equal(f.entry().data.management.source, null);
  f.answer({ text: 'в 15:00' });
  assert.equal(f.result.dialogue.step, 'date');
  const m = f.entry().data.management;
  assert.equal(m.source.appointmentId, f.patients[0].appointments[1].id);
  assert.equal(m.dateRequired, true);
  assert.equal(m.timeRequired, true);
  assert.equal(m.targetTime, null);
});

test('a nonmatching service preserves the source choices and cannot substitute a catalog-only service', (t) => {
  const f = fixture(t, {
    rows: [{ service: 'Пилинг PRX-T133' }, { service: 'Чистка', time: '15:00' }],
  });
  f.services.push({ id: 'invented', name: 'Массаж', duration: 30, staffId: 'owner' });
  f.start();
  f.answer({ text: 'на массаж' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.options.length, 2);
  assert.match(f.result.text, /Подходящей записи не нашёл/u);
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.entry().data.management.sourceServiceQuery, undefined);
  f.answer({ text: 'пилинг PRX-T134' });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.source, null);
});

test('services from cancelled, past or colleague appointments never become an employee source', (t) => {
  const f = fixture(t, {
    role: 'cosmetologist',
    rows: [
      { service: 'Чистка' },
      { service: 'Массаж', time: '15:00' },
      { service: 'Пилинг', time: '16:00', status: 'cancelled' },
      { service: 'Пилинг', date: '2020-01-05' },
      { service: 'Пилинг', time: '17:00', staffId: 'colleague' },
    ],
  });
  f.members.push({
    accountId: 'colleague',
    displayName: 'Коллега',
    role: 'cosmetologist',
    status: 'active',
  });
  f.start();
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: 'на пилинг' });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.result.dialogue.options.length, 2);
});

test('a unique short source day cancels only the existing appointment after separate confirmation', (t) => {
  const f = fixture(t, {
    intent: 'cancelAppointment',
    rows: [{ date: '2099-01-21' }, { date: '2099-01-22', time: '15:00' }],
  });
  f.start();
  f.answer({ text: 'на двадцать первое' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.source.appointmentId, f.patients[0].appointments[0].id);
  f.answer({ text: 'да' });
  assert.equal(f.result.action.operation, 'cancel');
});

test('a short cancellation day shared by different months asks the month instead of guessing', (t) => {
  const f = fixture(t, {
    intent: 'cancelAppointment',
    rows: [{ date: '2099-01-21' }, { date: '2099-02-21', time: '15:00' }],
  });
  f.start();
  f.answer({ text: '21-е' });
  assert.equal(f.result.dialogue.prompt, 'В каком месяце запись?');
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.result.action, null);
  f.answer({ text: 'февраля' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.entry().data.management.source.appointmentId, f.patients[0].appointments[1].id);
  assert.equal(f.result.action, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.action.appointmentId, f.patients[0].appointments[1].id);
});

test('a source day in different years asks the missing year, also accepts its full date, and never fills the move target', (t) => {
  const f = fixture(t, { rows: [{ date: '2099-01-21' }, { date: '2100-01-21', time: '15:00' }] });
  f.start();
  f.answer({ text: '21-е' });
  assert.equal(f.result.dialogue.prompt, 'В каком году запись?');
  f.answer({ text: '21 января 2100' });
  assert.equal(f.entry().data.management.source.appointmentId, f.patients[0].appointments[1].id);
  assert.equal(f.result.dialogue.step, 'date');
  assert.equal(f.entry().data.management.targetDate, null);
  assert.equal(f.entry().data.management.targetTime, null);
  assert.equal(f.result.action, null);
});

test('source ordinals remain choices, while unmatched days cannot fabricate a source', (t) => {
  const f = fixture(t, { rows: [{ date: '2099-01-21' }, { date: '2099-01-22', time: '15:00' }] });
  f.start();
  f.answer({ text: '23-е' });
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: '2' });
  assert.equal(f.entry().data.management.source.appointmentId, f.patients[0].appointments[1].id);
  assert.equal(f.result.action, null);
});

test('source service conditions, alternatives and compound commands are never partly accepted', (t) => {
  for (const raw of [
    'не на чистку',
    'на чистку или пилинг',
    'если на чистку',
    'на чистку; перенеси завтра',
  ]) {
    const f = fixture(t, { rows: [{ service: 'Чистка' }, { service: 'Пилинг', time: '15:00' }] });
    f.start();
    f.answer({ text: raw });
    assert.equal(f.result.action, null, raw);
    assert.equal(f.entry().data.management.source, null, raw);
    assert.equal(f.result.dialogue.options.length, 2, raw);
  }
});

test('service-filtered source choices are still checked against the current source stamp', (t) => {
  const f = fixture(t, { rows: [{ service: 'Чистка' }, { service: 'Чистка', time: '15:00' }] });
  f.start();
  f.answer({ text: 'на чистку' });
  const body = {
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    choice: f.result.dialogue.options[0].id,
  };
  f.patients[0].appointments[0].time = '10:15';
  try {
    assert.throws(() => f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock), {
      status: 409,
    });
    assert.equal(f.entry().data.management.source, null);
  } finally {
    f.patients[0].appointments[0].time = '10:00';
  }
});
