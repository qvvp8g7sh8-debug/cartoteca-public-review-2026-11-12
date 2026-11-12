const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  wholeManagementTemporalProof,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-temporal.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const { parseDateText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
function setup(t, options = {}, values = { date: '2099-01-07', time: '16:00' }) {
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
    },
  });
  f.start(values);
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
const state = (f) => f.entry().data.management;
function unchanged(f, original) {
  assert.equal(JSON.stringify(f.storage.read()), original);
  assert.equal(f.calls(), 0, '/turn never commits synthetic appointments');
}
for (const raw of ['на завтра в 25:00', 'в 25:00 на завтра'])
  test('partial new target preserves tomorrow and requires only its invalid clock: ' + raw, (t) => {
    const f = setup(t),
      original = JSON.stringify(f.storage.read());
    f.choose(1);
    const source = state(f).source.appointmentId;
    assert.equal(f.result.dialogue.phase, 'closedDay');
    f.turn(raw);
    assert.equal(state(f).source.appointmentId, source);
    assert.equal(state(f).targetDate, '2099-01-06');
    assert.equal(state(f).targetTime, null);
    assert.equal(state(f).timeRequired, true);
    assert.equal(state(f).requestedTime, undefined);
    assert.equal(state(f).closedConfirmation, undefined);
    assert.equal(state(f).movePreparation, undefined);
    assert.equal(f.result.dialogue.step, 'time');
    assert.match(f.result.text, /На какое время/u);
    f.turn('в 17:00');
    assert.equal(f.result.action.type, 'appointmentPreview');
    assert.equal(f.result.action.date, '2099-01-06');
    assert.equal(f.result.action.time, '17:00');
    unchanged(f, original);
  });
for (const raw of ['на 31 февраля в 17:00', 'в 17:00 на 31 февраля'])
  test(
    'invalid new date clears the old date and preserves the independently stated clock: ' + raw,
    (t) => {
      const f = setup(t),
        original = JSON.stringify(f.storage.read());
      f.choose(1);
      f.turn(raw);
      assert.equal(state(f).targetDate, null);
      assert.equal(state(f).dateRequired, true);
      assert.equal(state(f).targetTime, '17:00');
      assert.equal(f.result.dialogue.step, 'date');
      assert.equal(f.result.action, null);
      f.turn('на завтра');
      assert.equal(f.result.action.type, 'appointmentPreview');
      assert.equal(f.result.action.date, '2099-01-06');
      assert.equal(f.result.action.time, '17:00');
      unchanged(f, original);
    },
  );
test('two invalid target fields cannot fall back to either previous value', (t) => {
  const f = setup(t),
    original = JSON.stringify(f.storage.read());
  f.choose(1);
  f.turn('на 31 февраля в 25:00');
  assert.equal(state(f).targetDate, null);
  assert.equal(state(f).targetTime, null);
  assert.equal(f.result.dialogue.step, 'date');
  f.turn('на завтра');
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.action, null);
  f.turn('в 17:00');
  assert.equal(f.result.action.date, '2099-01-06');
  assert.equal(f.result.action.time, '17:00');
  unchanged(f, original);
});
for (const raw of ['на двадцатое в 25:00', 'в 25:00 на двадцатое'])
  test(
    'a known target month resolves the day while the invalid clock still requires clarification: ' +
      raw,
    (t) => {
      const f = setup(t),
        original = JSON.stringify(f.storage.read());
      f.choose(1);
      f.turn(raw);
      assert.equal(state(f).targetDate, '2099-01-20');
      assert.equal(state(f).dateProposal, undefined);
      assert.equal(state(f).targetTime, null);
      assert.equal(f.result.dialogue.step, 'time');
      assert.equal(f.result.action, null);
      unchanged(f, original);
    },
  );
for (const [raw, date, time, step] of [
  ['вторую на завтра в 25:00', '2099-01-06', null, 'time'],
  ['вторую в 25:00 на завтра', '2099-01-06', null, 'time'],
  ['вторую на 31 февраля в 17:00', null, '17:00', 'date'],
  ['вторую в 17:00 на 31 февраля', null, '17:00', 'date'],
  ['вторую на 31 февраля в 25:00', null, null, 'date'],
])
  test('partial target does not discard the proven ordinal source: ' + raw, (t) => {
    const f = setup(t),
      original = JSON.stringify(f.storage.read());
    const expected = f.entry().options.get(f.result.dialogue.options[1].id).value.appointmentId;
    f.turn(raw);
    assert.equal(state(f).source.appointmentId, expected);
    assert.equal(state(f).targetDate, date);
    assert.equal(state(f).targetTime, time);
    assert.equal(f.result.dialogue.step, step);
    assert.equal(f.result.action, null);
    if (!date) f.turn('на завтра');
    if (!time) f.turn('в 17:00');
    assert.equal(f.result.action.type, 'appointmentPreview');
    assert.equal(f.result.action.date, '2099-01-06');
    assert.equal(f.result.action.time, '17:00');
    unchanged(f, original);
  });
for (const raw of ['вторую на двадцатое в 17:00', 'вторую в 17:00 на двадцатое'])
  test('source selection and month proposal preserve the stated clock: ' + raw, (t) => {
    const f = setup(t, {}, { time: '16:00' });
    const expected = f.entry().options.get(f.result.dialogue.options[1].id).value.appointmentId;
    f.turn(raw);
    assert.equal(state(f).source.appointmentId, expected);
    assert.equal(state(f).dateProposal.day, 20);
    assert.equal(state(f).targetTime, '17:00');
    f.turn('да');
    assert.equal(state(f).targetDate, '2099-01-20');
    assert.equal(f.result.dialogue.phase, 'closedDay');
    f.turn('да');
    assert.equal(f.result.action.date, '2099-01-20');
    assert.equal(f.result.action.time, '17:00');
  });
for (const raw of [
  'вторую на завтра в 25:00 если получится',
  'вторую на завтра в 25:00 или в 17:00',
  'вторую на завтра в 25:00 и отмени третью',
  'вторую на завтра в 25:00 клиента Ольгу Семёнову',
])
  test('an unproven compound clause cannot consume the source choice: ' + raw, (t) => {
    const f = setup(t),
      original = JSON.stringify(f.storage.read());
    f.turn(raw);
    assert.equal(state(f).source, null);
    assert.equal(f.result.action, null);
    assert.ok(['appointment', 'client'].includes(f.result.dialogue.step));
    unchanged(f, original);
  });
test('a stale ordinal source is checked before applying any partial target', (t) => {
  const f = setup(t);
  const source = f.entry().options.get(f.result.dialogue.options[1].id).value.appointmentId;
  f.mutate((next) => {
    next.patients[0].appointments.find((row) => row.id === source).time = '12:30';
  });
  const before = JSON.stringify(state(f));
  assert.throws(() => f.turn('вторую на завтра в 25:00'), { status: 409 });
  assert.equal(JSON.stringify(state(f)), before);
  assert.equal(f.calls(), 0);
});
test('a revoked actor cannot apply an ordinal or its partial target', (t) => {
  const f = setup(t);
  f.revoke();
  assert.throws(() => f.turn('вторую на завтра в 25:00'), { status: 403 });
  assert.equal(f.calls(), 0);
});
test('an explicit target before source choice retains a clear date and rejects its invalid clock', (t) => {
  const f = setup(t),
    original = JSON.stringify(f.storage.read());
  f.turn('Перенеси запись на завтра в 25:00');
  assert.equal(state(f).source, null);
  assert.equal(state(f).initialDate, '2099-01-06');
  assert.equal(state(f).initialTime, null);
  assert.equal(state(f).timeRequired, true);
  f.choose(2);
  assert.equal(state(f).targetDate, '2099-01-06');
  assert.equal(f.result.dialogue.step, 'time');
  f.turn('в 17:00');
  assert.equal(f.result.action.date, '2099-01-06');
  assert.equal(f.result.action.time, '17:00');
  unchanged(f, original);
});
test('an invalid standalone clock clears a previously known target without losing its day', (t) => {
  const f = setup(t);
  f.choose(1);
  f.turn('в 25:00');
  assert.equal(state(f).targetDate, '2099-01-07');
  assert.equal(state(f).targetTime, null);
  assert.equal(state(f).timeRequired, true);
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.action, null);
});
test('clarifying an invalid date preserves the independently stated evening period', (t) => {
  const f = setup(t);
  f.turn('вторую на 31 февраля вечером');
  assert.equal(state(f).targetDate, null);
  assert.equal(state(f).targetWindow.kind, 'evening');
  f.turn('на завтра');
  assert.equal(state(f).targetDate, '2099-01-06');
  assert.equal(state(f).targetWindow.kind, 'evening');
  assert.equal(state(f).targetWindowDate, '2099-01-06');
  assert.equal(f.result.dialogue.phase, 'period');
  assert.ok(f.result.dialogue.options.length > 0);
  assert.match(f.result.text, /Свободно/u);
  assert.equal(f.result.action, null);
});
test('partial ordinal correction executes only its selected source after the missing clock is supplied', async (t) => {
  const f = setup(t, { enabled: true });
  const old = structuredClone(f.rows());
  const chosen = f.entry().options.get(f.result.dialogue.options[1].id).value.appointmentId;
  f.turn('вторую на завтра в 25:00');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
  f.turn('в 17:00');
  assert.equal(f.result.action.type, 'moveAppointment');
  const body = f.body();
  const result = await f.api.execute(f.c, body);
  await f.api.execute(f.c, body);
  assert.equal(result.moved, true);
  assert.equal(result.appointmentId, chosen);
  assert.equal(f.calls(), 1);
  for (const row of old)
    assert.deepEqual(
      f.rows().find((next) => next.id === row.id),
      row.id === chosen ? { ...row, date: '2099-01-06', time: '17:00' } : row,
    );
});
test('the shared whole-clause proof rejects entity corrections and extra actions', () => {
  const clock = { date: '2099-01-05', hour: 8, minute: 0 };
  for (const raw of [
    'Клиента поменяй на Ольгу Семёнову на завтра в 18:00',
    'пилинг PRX на завтра в 25:00',
    'на завтра в 25:00 и отмени запись',
    'на завтра в 25:00 если получится',
    'на завтра в 25:00 или в 17:00',
  ])
    assert.equal(wholeManagementTemporalProof(raw, clock), null, raw);
});
for (const clockText of ['на 12 часов', 'на двенадцать часов'])
  test(
    'a clock with the genitive hours unit never becomes the appointment duration: ' + clockText,
    (t) => {
      const f = setup(t),
        original = JSON.stringify(f.storage.read());
      f.choose(1);
      f.turn('на завтра ' + clockText);
      assert.equal(state(f).targetDate, '2099-01-06');
      assert.equal(state(f).targetTime || state(f).requestedTime, '12:00');
      assert.match(f.result.text, /занято/u);
      assert.equal(f.result.action, null);
      unchanged(f, original);
    },
  );
for (const selectSource of [false, true])
  test(
    'an invalid spoken clock with hours preserves its separately stated date; source choice=' +
      selectSource,
    (t) => {
      const f = setup(t),
        original = JSON.stringify(f.storage.read());
      if (selectSource) f.turn('вторую на завтра в двадцать пять часов');
      else {
        f.choose(1);
        f.turn('на завтра в двадцать пять часов');
      }
      assert.ok(state(f).source);
      assert.equal(state(f).targetDate, '2099-01-06');
      assert.equal(state(f).targetTime, null);
      assert.equal(state(f).timeRequired, true);
      assert.equal(f.result.dialogue.step, 'time');
      f.turn('в шестнадцать тридцать');
      assert.equal(f.result.action.type, 'appointmentPreview');
      assert.equal(f.result.action.date, '2099-01-06');
      assert.equal(f.result.action.time, '16:30');
      unchanged(f, original);
    },
  );
for (const [cue, date] of [
  ['сегодня', '2099-01-05'],
  ['завтра', '2099-01-06'],
  ['2099-01-06', '2099-01-06'],
  ['06.01.2099', '2099-01-06'],
  ['6 января', '2099-01-06'],
])
  test(
    'a semicolon delimits a complete date without hiding the independently stated clock: ' + cue,
    () => {
      const clock = { date: '2099-01-05', hour: 8, minute: 0 };
      for (const raw of [
        'дата ' + cue + '; время 10:00',
        'клиент Анна Семёнова;дата ' + cue + ';время 10:00',
      ]) {
        const proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, raw, clock);
        assert.equal(proof.date, date, raw);
        assert.equal(proof.time, '10:00', raw);
        assert.equal(parseDateText(raw, clock), date, raw);
      }
    },
  );
for (const raw of [
  'сегодня;завтра',
  '2099-01-06;2099-01-07',
  '6 января;7 января',
  'не;сегодня',
  'сегодня;или завтра',
])
  test('punctuation cannot hide a second or rejected date: ' + raw, () => {
    const clock = { date: '2099-01-05', hour: 8, minute: 0 };
    assert.equal(parseDateText(raw, clock), null);
    const proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, raw, clock);
    assert.notEqual(typeof proof.date, 'string');
  });
