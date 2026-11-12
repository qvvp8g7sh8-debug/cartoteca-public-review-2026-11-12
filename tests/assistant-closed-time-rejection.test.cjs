const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { startsAt } = require('../src/server/modules/notifications/appointments.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const zone = 'Europe/Moscow';
function fixture(t, { role = 'owner', date = day, working = false, auto = false } = {}) {
  t.mock.method(Date, 'now', () => startsAt({ date: day, time: '15:00' }, zone));
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  f.clock.hour = 15;
  f.clock.minute = 0;
  const days = working ? { [date]: { status: 'working', intervals: [['09:00', '18:00']] } } : {};
  f.c.platform.workSchedules.view = () => ({ days, closures: {} });
  const store = f.c.tenantStore('org');
  let writes = 0;
  for (const key of ['save', 'write'])
    store[key] = () => {
      writes++;
      throw Error('Forbidden appointment save');
    };
  let result = f.flow.start(
    f.c,
    { intent: 'prepareAppointment', query: 'Анна Семёнова', serviceQuery: 'Чистка', date },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: auto },
  );
  let activeId = result.dialogue.id;
  const entry = () => f.flow.get(f.c, f.member, f.state, activeId);
  const answer = (text) => {
    result = f.flow.continueDialogue(
      f.c,
      {
        policyVersion: f.state.revision,
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        text,
      },
      f.state,
      f.member,
      f.clock,
    );
    if (result.dialogue) activeId = result.dialogue.id;
    return result;
  };
  t.after(() => {
    assert.equal(writes, 0);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  });
  return {
    f,
    entry,
    answer,
    days,
    get result() {
      return result;
    },
  };
}
const baseFields = (s) => ({
  client: s.entry().data.patient.id,
  staff: s.entry().data.staff.id,
  date: s.entry().data.date,
  service: s.entry().data.service.id,
  duration: s.entry().data.duration,
  confirmation: s.entry().data.closedDayConfirmation,
});

test('short spoken noon proves only time and cannot retract the selected date', () => {
  assert.deepEqual(
    bookingTemporalConstraints(
      { intent: 'prepareAppointment' },
      'В двенадцать.',
      { date: day, hour: 15, minute: 0 },
      { timeContext: true },
    ),
    { time: '12:00' },
  );
});

test('closed day without a clock accepts one confirmation and a future spoken noon for owner and administrator', async (t) => {
  for (const role of ['owner', 'salon_admin'])
    for (const raw of ['12', 'В двенадцать.'])
      await t.test(role + '/' + raw, (t) => {
        const date = nextDate(day),
          s = fixture(t, { role, date, auto: true });
        assert.equal(s.result.dialogue.phase, 'closedDay');
        s.answer('да');
        const before = baseFields(s);
        assert.equal(s.result.dialogue.prompt, 'Во сколько записать?');
        const result = s.answer(raw);
        assert.equal(result.action?.type, 'prepareAppointment');
        assert.equal(result.action.date, date);
        assert.equal(result.action.time, '12:00');
        assert.deepEqual(baseFields(s), before);
      });
});

test('past noon on a confirmed closed day asks only for a new time and retains the chosen date and consent', async (t) => {
  for (const role of ['owner', 'salon_admin'])
    await t.test(role, (t) => {
      const s = fixture(t, { role, auto: true });
      s.answer('да');
      const before = baseFields(s);
      const result = s.answer('В двенадцать.');
      assert.equal(result.text, 'Это время уже прошло. Во сколько записать?');
      assert.equal(result.dialogue.step, 'time');
      assert.equal(result.action, null);
      assert.deepEqual(baseFields(s), before);
      assert.equal(s.entry().data.time, null);
      const corrected = s.answer('в 16:00');
      assert.equal(corrected.action?.type, 'prepareAppointment');
      assert.equal(corrected.action.date, day);
      assert.equal(corrected.action.time, '16:00');
      assert.deepEqual(baseFields(s), before);
    });
});

test('an occupied future clock on a confirmed closed day reports busy and accepts a later free clock without reconfirming', (t) => {
  const s = fixture(t, { auto: true });
  s.f.busy.push({ date: day, time: '16:00', duration: 30, staffId: 'owner' });
  s.answer('да');
  const before = baseFields(s);
  const result = s.answer('в 16:00');
  assert.equal(result.text, 'В 16:00 занято. Во сколько записать?');
  assert.equal(result.action, null);
  assert.deepEqual(baseFields(s), before);
  const corrected = s.answer('в 17:00');
  assert.equal(corrected.action?.time, '17:00');
  assert.deepEqual(baseFields(s), before);
});

test('working hours require consent for a future outside clock and reject past time before consent', (t) => {
  const s = fixture(t, { working: true });
  let result = s.answer('в 12:00');
  assert.match(result.text, /^Это время уже прошло\./u);
  assert.equal(s.entry().data.date, day);
  result = s.answer('в 19:00');
  assert.equal(result.text, 'Вне рабочего графика. Записать?');
  assert.equal(result.dialogue.phase, 'closedDay');
  assert.equal(result.action, null);
  result = s.answer('да');
  assert.equal(result.dialogue.step, 'review');
  assert.equal(s.entry().data.time, '19:00');
});

test('employee cannot confirm a closed day or prepare its future exact clock', (t) => {
  const s = fixture(t, { role: 'cosmetologist', date: nextDate(day), auto: true });
  s.answer('да');
  assert.equal(s.result.dialogue.phase, 'closedDay');
  assert.equal(s.entry().data.closedDayConfirmation, undefined);
  const result = s.answer('в 12:00');
  assert.equal(result.dialogue.phase, 'closedDay');
  assert.equal(result.action, null);
});

test('final form preparation uses the same past reason if the chosen clock elapsed after review', (t) => {
  const s = fixture(t);
  s.answer('да');
  s.answer('в 16:00');
  assert.equal(s.result.dialogue.step, 'review');
  const before = baseFields(s);
  Date.now = () => startsAt({ date: day, time: '16:01' }, zone);
  s.f.clock.hour = 16;
  s.f.clock.minute = 1;
  const result = s.answer('открой форму');
  assert.equal(result.text, 'Это время уже прошло. Во сколько записать?');
  assert.equal(result.action, null);
  assert.deepEqual(baseFields(s), before);
});

test('action-bearing closed-day consent is applied once to the existing exact appointment tuple', (t) => {
  const s = fixture(t, { role: 'salon_admin', date: nextDate(day), auto: true });
  assert.equal(s.result.dialogue.phase, 'closedDay');
  s.answer('Верно, записывай');
  const before = baseFields(s);
  assert.ok(before.confirmation);
  assert.equal(s.result.dialogue.prompt, 'Во сколько записать?');
  const result = s.answer('12:00');
  assert.equal(result.action.type, 'prepareAppointment');
  assert.equal(result.action.time, '12:00');
  assert.deepEqual(baseFields(s), before);
});
