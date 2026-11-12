const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  parseBookingTimeWindow,
} = require('../src/server/modules/assistant/language/time/booking-time-window.cjs');
const {
  managementClientCorrection,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-client.cjs');
function setup(t, values = {}, constraints = {}, options = {}) {
  const f = moveExecutionFixture(t, {
    enabled: false,
    targetDate: null,
    targetTime: null,
    ...options,
    beforeStart(f) {
      f.addBooking({
        date: '2099-01-06',
        time: '12:00',
        service: 'Пилинг PRX-T133',
        serviceItems: [],
      });
      f.addBooking({ date: '2099-01-06', time: '15:00', service: 'Чистка', serviceItems: [] });
      f.members.push({
        accountId: 'staff-maria',
        firstName: 'Мария',
        lastName: 'Иванова',
        displayName: 'Мария Иванова',
        role: 'cosmetologist',
        status: 'active',
      });
      f.addBooking({
        date: '2099-01-06',
        time: '14:00',
        service: 'Чистка',
        staffId: 'staff-maria',
        serviceItems: [],
      });
      f.mutate((next) => {
        const p = structuredClone(next.patients[0]);
        p.id = randomUUID();
        p.firstName = 'Ольга';
        p.lastName = 'Семёнова';
        p.name = 'Ольга Семёнова';
        p.phone = '+79990005566';
        p.appointments = p.appointments
          .slice(0, 1)
          .map((row) => ({ ...row, id: randomUUID(), time: '17:00' }));
        next.patients.push(p);
      });
    },
  });
  f.start(values, constraints);
  const id = f.result.dialogue.id;
  return {
    ...f,
    get result() {
      return f.result;
    },
    entry: () => f.flow.get(f.c, f.member, f.state, id),
    turn: (text) => f.answer({ text }),
    choose: (index) => f.answer({ choice: f.result.dialogue.options[index - 1].id }),
  };
}
const m = (f) => f.entry().data.management;
const source = (f) => f.rows().find((row) => row.id === m(f).source?.appointmentId);
for (const [tail, field, expected] of [
  ['на двадцатое', 'date', /январ/u],
  ['в 25:00', 'time', /время|Во сколько/u],
  ['на 31 февраля', 'date', /дату/u],
])
  test('repeated source request cannot retain an explicitly unresolved ' + tail, (t) => {
    const f = setup(t, { date: '2099-01-07', time: '16:00' });
    f.choose(1);
    f.turn('Перенеси запись Анны Семёновой ' + tail + ' на пилинг PRX');
    assert.equal(source(f).service, 'Пилинг PRX-T133');
    assert.equal(m(f)[field === 'date' ? 'targetDate' : 'targetTime'], null);
    assert.equal(f.result.action, null);
    // A closed-day question may precede the time question, but must never execute the old clock.
    if (f.result.dialogue.phase === 'closedDay') f.turn('да');
    assert.equal(f.result.action, null);
    assert.match(f.result.text, expected);
    assert.equal(m(f).movePreparation, undefined);
    assert.equal(f.calls(), 0);
  });
test('month confirmation preserves the independent clock and updates only the proposed date', (t) => {
  const f = setup(t, { date: '2099-01-07', time: '16:00' });
  f.choose(1);
  f.turn('Перенеси запись Анны Семёновой на двадцатое на пилинг PRX');
  assert.equal(m(f).targetTime, '16:00');
  assert.equal(m(f).dateProposal.day, 20);
  f.turn('да');
  assert.equal(m(f).targetDate, '2099-01-20');
  if (f.result.dialogue?.phase === 'closedDay') f.turn('да');
  assert.equal(f.result.action.date, '2099-01-20');
  assert.equal(f.result.action.time, '16:00');
});
test('a repeated source request retains the reason for a rejected past date', (t) => {
  const f = setup(t, { date: '2099-01-07', time: '16:00' });
  f.choose(1);
  f.turn('Перенеси запись Анны Семёновой на 31 декабря 2098 на пилинг PRX');
  assert.equal(m(f).targetDate, null);
  assert.equal(m(f).targetTime, '16:00');
  assert.match(f.result.text, /дата уже прошла/u);
  assert.equal(f.result.action, null);
  f.turn('на завтра');
  assert.equal(m(f).targetDate, '2099-01-06');
  assert.equal(m(f).dateRejection, undefined);
});
for (const tail of ['на пилинг PRX', 'у Марии'])
  test('initial known goal survives a repeated source filter ' + tail, (t) => {
    const f = setup(t, { date: '2099-01-06', time: '16:30' });
    f.turn('Перенеси запись Анны Семёновой ' + tail);
    assert.equal(m(f).targetDate, '2099-01-06');
    assert.equal(m(f).initialTime, '16:30');
    if (m(f).targetTime) assert.equal(f.result.action.type, 'appointmentPreview');
    else {
      assert.equal(m(f).requestedTime, '16:30');
      assert.match(f.result.text, /занято/u);
    }
    assert.equal(f.calls(), 0);
  });
test('reselection cannot resurrect a rejected requestedTime', (t) => {
  const f = setup(t, { date: '2099-01-06' });
  Object.assign(m(f), { requestedTime: '16:00', timeRequired: true, initialTime: null });
  f.turn('Перенеси запись Анны Семёновой на пилинг PRX');
  assert.equal(m(f).targetTime, null);
  assert.equal(f.result.dialogue.step, 'time');
});
for (const raw of [
  'Нет, завтра у Марии',
  'Нет, у Марии завтра',
  'Нет, завтра в 14:00 у Марии',
  'Нет, у Марии завтра в 14:00',
])
  test('cancellation composes source staff and temporal evidence: ' + raw, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    const old = f.result.dialogue.options[0].id,
      oldSource = m(f).source.appointmentId;
    f.turn(raw);
    assert.equal(source(f).staffId, 'staff-maria');
    assert.equal(source(f).time, '14:00');
    assert.notEqual(m(f).source.appointmentId, oldSource);
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.notEqual(f.result.dialogue.options[0].id, old);
    assert.equal(m(f).cancelConfirmed, undefined);
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
  });
for (const raw of ['Нет, завтра на чистку у Марии', 'Нет, завтра у Марии на чистку'])
  test('source service/staff/date are an atomic tuple: ' + raw, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    f.turn(raw);
    assert.equal(source(f).staffId, 'staff-maria');
    assert.equal(source(f).date, '2099-01-06');
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.equal(f.calls(), 0);
  });
for (const [raw, time] of [
  ['вторую на час позже', '13:00'],
  ['вторую на час раньше', '11:00'],
])
  test('relative source selection replaces the old period: ' + raw, (t) => {
    const f = setup(
      t,
      { date: '2099-01-06' },
      { timeWindow: parseBookingTimeWindow('утром').window },
    );
    f.turn(raw);
    assert.equal(m(f).targetTime, time);
    assert.equal(m(f).targetWindow, undefined);
    assert.equal(m(f).initialWindow, undefined);
    assert.equal(f.result.action.time, time);
  });
for (const raw of [
  'Клиента поменяй на Ольгу Семёнову',
  'Нет, клиент Ольга Семёнова',
  'Поменяй клиента на Ольгу Семёнову',
])
  test('cancellation client correction resolves a new available patient: ' + raw, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    const patient = f.entry().data.patient.id,
      consent = f.result.dialogue.options[0].id;
    f.turn(raw);
    assert.notEqual(f.entry().data.patient.id, patient);
    assert.match(f.entry().data.patient.label, /Ольга/u);
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.equal(m(f).cancelConfirmed, undefined);
    assert.notEqual(f.result.dialogue.options[0].id, consent);
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
  });
test('unknown client clears old consent and continues through the same resolver', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const oldChoice = f.result.dialogue.options[0].id;
  f.turn('Клиента поменяй на Зиновию Абрикосову');
  assert.equal(f.entry().data.patient, null);
  assert.equal(m(f).source, null);
  assert.equal(m(f).cancelConfirmation, undefined);
  assert.equal(f.result.dialogue.step, 'client');
  assert.throws(() => f.answer({ choice: oldChoice }), /клиент|выбор/u);
  f.turn('Ольга Семёнова');
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.match(f.entry().data.patient.label, /Ольга/u);
  assert.equal(f.calls(), 0);
});
test('other client asks without carrying stale filters or consent', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  f.turn('другой клиент');
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.entry().data.patient, null);
  assert.equal(m(f).source, null);
  assert.equal(m(f).cancelConfirmation, undefined);
  f.turn('Ольга Семёнова');
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
});
test('client correction while moving retains the known target', (t) => {
  const f = setup(t, { date: '2099-01-07', time: '16:00' });
  f.choose(1);
  f.turn('Клиента поменяй на Ольгу Семёнову');
  assert.equal(m(f).targetDate, '2099-01-07');
  assert.equal(m(f).targetTime, '16:00');
  assert.match(f.entry().data.patient.label, /Ольга/u);
  assert.equal(f.result.action, null);
});
test('corrected client cancellation commits only the new bound appointment and is idempotent', async (t) => {
  const f = setup(t, { intent: 'cancelAppointment' }, {}, { enabled: true });
  f.choose(1);
  const oldPatient = f.entry().data.patient.id,
    oldSource = m(f).source.appointmentId;
  const oldConsent = f.result.dialogue.options[0].id;
  f.turn('Клиента поменяй на Ольгу Семёнову');
  const patient = f.entry().data.patient.id,
    appointment = m(f).source.appointmentId;
  assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
  f.turn('да, отменить');
  assert.equal(f.result.action.type, 'cancelAppointment');
  const body = f.body();
  await f.api.execute(f.c, body);
  await f.api.execute(f.c, body);
  const patients = f.storage.read().patients;
  assert.equal(
    patients.find((p) => p.id === oldPatient).appointments.find((row) => row.id === oldSource)
      .status,
    'scheduled',
  );
  assert.equal(
    patients.find((p) => p.id === patient).appointments.find((row) => row.id === appointment)
      .status,
    'cancelled',
  );
  assert.equal(f.calls(), 1);
});
test('revoked access blocks client reselection before resolution', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  f.revoke();
  assert.throws(() => f.turn('Клиента поменяй на Ольгу Семёнову'), { status: 403 });
  assert.equal(f.calls(), 0);
});
test('ambiguous corrected client is resolved only from fresh current choices', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const oldConsent = f.result.dialogue.options[0].id;
  f.mutate((next) => {
    const copy = structuredClone(next.patients.find((p) => p.firstName === 'Ольга'));
    copy.id = randomUUID();
    copy.phone = '+79990006677';
    copy.appointments = copy.appointments.map((row) => ({
      ...row,
      id: randomUUID(),
      time: '18:00',
    }));
    next.patients.push(copy);
  });
  f.turn('Клиента поменяй на Ольгу Семёнову');
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.result.dialogue.options.length, 2);
  assert.equal(m(f).source, null);
  assert.equal(m(f).cancelConfirmation, undefined);
  assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
  const selected = f.entry().options.get(f.result.dialogue.options[1].id).value;
  f.choose(2);
  assert.equal(f.entry().data.patient.id, selected);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.calls(), 0);
});
test('client without a future appointment cannot inherit cancellation of the old patient', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  f.mutate((next) => {
    next.patients.find((p) => p.firstName === 'Ольга').appointments = [];
  });
  f.turn('Клиента поменяй на Ольгу Семёнову');
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.entry().data.patient, null);
  assert.equal(m(f).source, null);
  assert.equal(m(f).cancelConfirmation, undefined);
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
test('stale source blocks a compound relative choice before changing its target', (t) => {
  const f = setup(
    t,
    { date: '2099-01-06' },
    { timeWindow: parseBookingTimeWindow('утром').window },
  );
  const old = structuredClone(m(f));
  f.mutate((next) => {
    next.patients[0].appointments.find((row) => row.service.includes('PRX')).time = '12:30';
  });
  assert.throws(() => f.turn('вторую на час позже'), { status: 409 });
  assert.deepEqual(m(f), old);
  assert.equal(f.calls(), 0);
});
for (const tail of ['в 25:00', 'на 31 февраля'])
  test('repeated cancellation never keeps an invalid old source temporal field: ' + tail, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    f.turn('Отмени запись Анны Семёновой ' + tail + ' на пилинг PRX');
    assert.equal(m(f).source, null);
    assert.equal(m(f).cancelConfirmation, undefined);
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue.phase, 'appointmentChoice');
    assert.match(f.result.text, tail.includes('25') ? /Во сколько/u : /дату/u);
  });
for (const raw of [
  'Нет, если завтра у Марии',
  'Нет, завтра или сегодня у Марии',
  'Нет, завтра у Марии отмени другую запись',
])
  test('source correction cannot discard conditions/actions: ' + raw, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    const before = m(f).source.appointmentId;
    f.turn(raw);
    assert.equal(m(f).source.appointmentId, before);
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
  });
for (const raw of [
  'Клиент Ольга или Анна',
  'Клиента поменяй на Ольгу завтра',
  'Клиент Ольга отмени запись',
  'Если клиент Ольга',
  'не меняй клиента',
])
  test('client correction requires a complete explicit role and bounded query: ' + raw, () => {
    assert.equal(managementClientCorrection(raw), null);
  });
