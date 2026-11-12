const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validAppointmentTime } = require('../src/shared/appointment-time.cjs');
const {
  createAssistantDialogue,
} = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
const {
  findAvailability,
  verifyAvailability,
} = require('../src/server/modules/assistant/actions/availability.cjs');
const { parseTimeText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const NOW = Date.parse(day + 'T05:00:00Z');
function fixture({ closed = false, move = false, intervals = [['00:00', '24:00']] } = {}) {
  const f = dialogueFixture();
  f.state.providers = { llm: { provider: 'codex', model: 'synthetic-no-provider' } };
  const source = {
    id: randomUUID(),
    date: day,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
    status: 'scheduled',
    service: 'Историческая услуга',
    serviceItems: [{ id: 'historical', name: 'Историческая услуга', duration: 30, price: 700 }],
    notes: 'Synthetic original',
  };
  if (move) f.patients[0].appointments.push(source);
  const storage = f.c.tenantStore('org');
  storage.readSelected = (ids) => ({
    patients: f.patients.filter((row) => ids.includes(row.id)),
    services: f.services,
    revision: 1,
  });
  storage.indexes.appointments = () => f.patients.flatMap((row) => row.appointments).concat(f.busy);
  const schedule = {
    days: { [day]: { status: closed ? 'closed' : 'working', intervals: closed ? [] : intervals } },
    closures: {},
  };
  f.c.platform.workSchedules.view = () => schedule;
  const memory = createAssistantDialogue({ appointmentSavingEnabled: true });
  const flow = move
    ? createAppointmentManagementFlow({ memory, appointmentSavingEnabled: true })
    : memory;
  let result;
  const start = (time) =>
    (result = flow.start(
      f.c,
      {
        intent: move ? 'moveAppointment' : 'prepareAppointment',
        query: 'Анна Семёнова',
        ...(move ? {} : { serviceQuery: 'Чистка' }),
        date: day,
        ...(time ? { time } : {}),
      },
      f.state,
      f.member,
      f.clock,
      memory.beginCommand(f.c, f.member, f.state),
      { openWhenComplete: true, createRequested: true },
    ));
  const entry = () =>
    memory.get(f.c, f.member, f.state, result.dialogue?.id || result.action.executionId);
  const answer = (text) => {
    const current = entry();
    result = flow.continueDialogue(
      f.c,
      { dialogueId: current.id, dialogueVersion: current.version, text },
      f.state,
      f.member,
      f.clock,
    );
    return result;
  };
  return {
    ...f,
    source,
    schedule,
    start,
    answer,
    entry,
    get result() {
      return result;
    },
  };
}
function selected(data) {
  return {
    patient: data.patient,
    staff: data.staff,
    service: data.service,
    date: data.date,
    duration: data.duration,
  };
}
function noMutation(f, before) {
  assert.equal(JSON.stringify(f.patients), before);
}

test('appointment start validation accepts the full five-minute cabinet grid and never rounds an explicit clock', () => {
  for (const clock of ['00:00', '00:05', '08:10', '12:15', '20:00', '23:55'])
    assert.equal(validAppointmentTime(clock), true, clock);
  for (const clock of ['20:01', '08:07', '23:59', '24:00', '7:05', '', null, 2000])
    assert.equal(validAppointmentTime(clock), false, String(clock));
});

for (const move of [false, true])
  test(
    'off-grid initial ' +
      (move ? 'move' : 'create') +
      ' asks only for time and the next valid clock continues with the same identity',
    () => {
      const f = fixture({ move }),
        before = JSON.stringify(f.patients);
      const result = f.start('20:01');
      assert.equal(result.action, null);
      assert.equal(result.dialogue.step, 'time');
      assert.match(result.text, /5 минут/u);
      const data = f.entry().data;
      assert.equal(data.patient.id, f.patients[0].id);
      if (move) {
        assert.equal(data.management.source.appointmentId, f.source.id);
        assert.equal(data.management.targetDate, day);
        assert.equal(data.management.targetTime, null);
      } else {
        assert.equal(data.staff.id, 'owner');
        assert.equal(data.service.id, 'clean');
        assert.equal(data.date, day);
        assert.equal(data.duration, 30);
        assert.equal(data.time, null);
      }
      const known = move
        ? structuredClone(data.management.source)
        : structuredClone(selected(data));
      f.answer('20:00');
      assert.equal(f.result.dialogue, null);
      assert.equal(f.result.action.type, move ? 'moveAppointment' : 'createAppointment');
      if (move) {
        assert.deepEqual(f.entry().data.management.source, known);
        assert.equal(f.entry().data.management.targetTime, '20:00');
        assert.equal(f.entry().data.management.targetDate, day);
      } else {
        assert.deepEqual(selected(f.entry().data), known);
        assert.equal(f.result.action.time, '20:00');
      }
      noMutation(f, before);
    },
  );

test('an off-grid time-step answer preserves all other create fields and cannot emit an execution action', () => {
  const f = fixture(),
    before = JSON.stringify(f.patients);
  f.start();
  const known = structuredClone(selected(f.entry().data));
  f.answer('20:01');
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  assert.match(f.result.text, /5 минут/u);
  assert.equal(f.entry().data.time, null);
  assert.deepEqual(selected(f.entry().data), known);
  f.answer('20:00');
  assert.equal(f.result.action.type, 'createAppointment');
  assert.equal(f.result.action.time, '20:00');
  assert.deepEqual(selected(f.entry().data), known);
  noMutation(f, before);
});

test('a whole dotted clock is accepted in a time answer without changing decimal and date parsing', () => {
  assert.equal(parseTimeText('11.34'), null);
  assert.equal(parseTimeText('11.34.', { timeContext: true }), '11:34');
  assert.equal(parseTimeText('на 11.34', { timeContext: true }), '11:34');
  assert.equal(parseTimeText('11.34 или 11.35', { timeContext: true }), null);
  assert.equal(parseTimeText('11.03.2099', { timeContext: true }), null);
  assert.equal(parseTimeText('11.64', { timeContext: true }), null);
});

for (const move of [false, true])
  test(`a dotted off-grid ${move ? 'move' : 'booking'} offers a verified start for explicit choice`, () => {
    const f = fixture({ move });
    const before = JSON.stringify(f.patients);
    f.start();
    f.answer('11.34');
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue.step, 'time');
    assert.match(f.result.text, /Вы назвали 11:34.*5 минут.*11:35\. Подойдёт\?/u);
    assert.equal(f.result.dialogue.options.length, 1);
    assert.match(f.result.dialogue.options[0].label, /11:35–12:05/u);
    assert.equal(move ? f.entry().data.management.targetTime : f.entry().data.time, null);
    f.answer('да');
    assert.equal(f.result.dialogue, null);
    assert.equal(move ? f.entry().data.management.targetTime : f.result.action.time, '11:35');
    noMutation(f, before);
  });

test('off-grid alternatives respect duration and require an actual nearby opening', () => {
  const f = fixture();
  f.busy.push({ date: day, time: '12:00', duration: 5, staffId: 'owner' });
  const earlier = f.start('11:34');
  assert.equal(earlier.action, null);
  assert.match(earlier.text, /Ближайшее свободное время — 11:30/u);
  assert.equal(earlier.dialogue.options.length, 1);

  const blocked = fixture({ intervals: [['12:00', '18:00']] });
  const reply = blocked.start('11:34');
  assert.equal(reply.action, null);
  assert.match(reply.text, /11:34.*Назовите другое время или дату/u);
  assert.equal(reply.dialogue.options.length, 0);
  assert.equal(blocked.entry().data.time, null);
});

for (const move of [false, true])
  test(
    'a closed-day ' +
      (move ? 'move' : 'create') +
      ' first corrects the grid, then asks one bound consent without opening the day',
    () => {
      const f = fixture({ move, closed: true }),
        before = JSON.stringify(f.patients);
      f.start('20:01');
      assert.match(f.result.text, /5 минут/u);
      assert.equal(f.result.action, null);
      f.answer('20:00');
      assert.equal(f.result.action, null);
      assert.match(f.result.text, /День не открыт/u);
      f.answer('Да, ' + (move ? 'переноси' : 'записывай'));
      assert.equal(f.result.dialogue, null);
      assert.equal(f.result.action.type, move ? 'moveAppointment' : 'createAppointment');
      assert.equal(f.schedule.days[day].status, 'closed');
      noMutation(f, before);
    },
  );

test('exact availability refuses 20:01 while a real 20:00 appointment still fits and no saved schedule changes', () => {
  const f = fixture(),
    before = JSON.stringify(f.schedule);
  const values = { date: day, staffId: 'owner', duration: 30, serviceIds: ['clean'] };
  assert.equal(verifyAvailability(f.c, { ...values, time: '20:01' }, NOW), null);
  const slot = verifyAvailability(f.c, { ...values, time: '20:00' }, NOW);
  assert.equal(slot.time, '20:00');
  assert.equal(slot.duration, 30);
  assert.equal(JSON.stringify(f.schedule), before);
});

test('generated candidates start on 08:10 after saved 08:07 hours without rewriting or rounding exact user input', () => {
  const f = fixture({ intervals: [['08:07', '09:02']] }),
    before = JSON.stringify(f.schedule);
  const values = { from: day, to: day, staffIds: ['owner'], duration: 30, serviceIds: ['clean'] };
  const result = findAvailability(f.c, values, NOW);
  assert.equal(result.slots[0].time, '08:10');
  assert.ok(result.slots.every((slot) => validAppointmentTime(slot.time)));
  assert.equal(
    verifyAvailability(
      f.c,
      { date: day, staffId: 'owner', duration: 30, serviceIds: ['clean'], time: '08:07' },
      NOW,
    ),
    null,
  );
  assert.equal(
    verifyAvailability(
      f.c,
      { date: day, staffId: 'owner', duration: 30, serviceIds: ['clean'], time: '08:10' },
      NOW,
    )?.time,
    '08:10',
  );
  const dayInfo = findAvailability(f.c, { ...values, strategy: 'day' }, NOW).availability.dayInfo;
  assert.deepEqual(dayInfo.workingIntervals, [['08:07', '09:02']]);
  assert.equal(JSON.stringify(f.schedule), before);
});
