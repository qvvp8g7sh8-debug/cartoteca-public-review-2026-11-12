const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  prepareManagementIntent,
  normalizeManagementRequest,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const {
  managementRelativeProof,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-temporal.cjs');
const sourceDate = '2026-10-19';
const clock = { date: '2026-10-18', hour: 8, minute: 0 };
test.beforeEach((t) => {
  t.mock.method(Date, 'now', () => Date.parse(clock.date + 'T05:00:00Z'));
});
function fixture(t, { multiple = false, time = '10:00', ...extra } = {}) {
  return moveExecutionFixture(t, {
    targetDate: null,
    targetTime: null,
    clockDate: clock.date,
    beforeStart(f) {
      f.mutate((next) =>
        Object.assign(next.patients[0].appointments[0], { date: sourceDate, time }),
      );
      for (const date of ['2026-10-18', sourceDate, '2026-10-20', '2026-10-21'])
        f.days[date] = { status: 'working', intervals: [['07:00', '20:00']] };
      if (multiple) f.addBooking({ date: '2026-10-20', time: '15:00' });
      extra.beforeStart?.(f);
    },
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'beforeStart')),
  });
}
function start(f, raw, model = { intent: 'moveAppointment', query: 'Анна Семёнова' }) {
  const parsed = normalizeManagementRequest(model, raw, clock);
  const proof = prepareManagementIntent(parsed, raw, clock);
  return f.start(proof.intent, proof.constraints);
}
function ready(f, date, time) {
  assert.equal(f.result.action?.type, 'moveAppointment');
  assert.equal(f.result.dialogue, null);
  assert.equal(f.entry().data.management.targetDate, date);
  assert.equal(f.entry().data.management.targetTime, time);
  assert.equal(f.calls(), 0, '/turn never commits');
}
for (const [phrase, expected] of [
  ['на час позже', '11:00'],
  ['на час раньше', '09:00'],
  ['на полчаса позднее', '10:30'],
  ['на тридцать минут ранее', '09:30'],
])
  test('initial relative uses the selected source immediately: ' + phrase, (t) => {
    for (const raw of [
      'Перенеси запись Анны Семёновой ' + phrase + '.',
      phrase + ' перенеси запись Анны Семёновой.',
    ]) {
      const f = fixture(t);
      start(f, raw);
      ready(f, sourceDate, expected);
      assert.equal(f.entry().data.initialIntent.query, 'Анны Семёновой');
    }
  });
test('an initial relative target waits for an existing source when several appointments exist', (t) => {
  const f = fixture(t, { multiple: true });
  start(f, 'Перенеси запись Анны Семёновой на час позже.');
  assert.equal(f.result.dialogue.step, 'appointment');
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.result.action, null);
  f.answer({ choice: f.result.dialogue.options[1].id });
  ready(f, '2026-10-20', '16:00');
});
test('an explicit date and relative time combine in either order without a second date question', (t) => {
  for (const tail of ['на 20 октября на час позже', 'на час позже на 20 октября']) {
    const f = fixture(t);
    start(f, 'Перенеси запись Анны Семёновой ' + tail);
    ready(f, '2026-10-20', '11:00');
  }
});
test('initial named dates and clocks survive temporal prefixes and reordered client spans', (t) => {
  for (const raw of [
    'Перенеси запись Анны Семёновой на двадцатое октября на одиннадцать утра.',
    'На двадцатое октября на одиннадцать утра перенеси запись Анны Семёновой.',
    'На одиннадцать утра перенеси запись Анны Семёновой на двадцатое октября.',
    'Перенеси запись на одиннадцать утра Анны Семёновой на двадцатое октября.',
  ]) {
    const f = fixture(t);
    start(f, raw);
    ready(f, '2026-10-20', '11:00');
  }
});
test('relative date and clock continuations use the same shared grammar as initial requests', (t) => {
  for (const raw of ['на 20 октября на час позже', 'на час позже на 20 октября']) {
    const f = fixture(t);
    f.answer({ text: raw });
    ready(f, '2026-10-20', '11:00');
  }
});
for (const raw of ['на девятнадцатое на десять утра', 'на десять утра на девятнадцатое'])
  test(
    'a compound bare-day target retains its clock through one month confirmation: ' + raw,
    (t) => {
      for (const initial of [false, true]) {
        const f = fixture(t, { time: '09:00' });
        if (initial) start(f, 'Перенеси запись Анны Семёновой ' + raw);
        else f.answer({ text: raw });
        assert.equal(f.result.dialogue.step, 'date');
        assert.equal(f.result.dialogue.prompt, 'Девятнадцатого октября, верно?');
        assert.equal(f.entry().data.management.targetTime, '10:00');
        assert.doesNotMatch(f.result.text, /график|не открыт/u);
        f.answer({ text: 'ага' });
        ready(f, sourceDate, '10:00');
      }
    },
  );
test('named day plus spoken clock is parsed in either order on the first continuation', (t) => {
  for (const raw of [
    'на девятнадцатое октября на десять утра',
    'на десять утра на девятнадцатое октября',
    '20 октября в шестнадцать ноль ноль',
  ]) {
    const f = fixture(t, { time: '09:00' });
    f.answer({ text: raw });
    ready(
      f,
      raw.startsWith('20') ? '2026-10-20' : sourceDate,
      raw.startsWith('20') ? '16:00' : '10:00',
    );
  }
});
test('a date-only move asks for time and neither yes nor the source clock can execute it', (t) => {
  for (const initial of [true, false]) {
    const f = fixture(t);
    if (initial) start(f, 'Перенеси запись Анны Семёновой на 20 октября.');
    else f.answer({ text: '20 октября' });
    assert.equal(f.result.dialogue.step, 'time');
    assert.equal(f.result.action, null);
    assert.equal(f.entry().data.management.targetTime, null);
    assert.doesNotMatch(f.result.text, /график|не открыт/u);
    f.answer({ text: 'да' });
    assert.equal(f.result.dialogue.step, 'time');
    assert.equal(f.result.action, null);
    f.answer({ text: 'на одиннадцать утра' });
    ready(f, '2026-10-20', '11:00');
  }
});
test('only an explicit same-time instruction may retain the source clock after changing date', (t) => {
  for (const initial of [true, false]) {
    const f = fixture(t);
    if (initial) start(f, 'Перенеси запись Анны Семёновой на 20 октября в то же время.');
    else {
      f.answer({ text: '20 октября' });
      f.answer({ text: 'оставь время' });
    }
    ready(f, '2026-10-20', '10:00');
  }
});
test('a date-only relative shift never supplies an unheard target time', (t) => {
  const f = fixture(t);
  start(f, 'Перенеси запись Анны Семёновой на день позже.');
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.entry().data.management.targetDate, '2026-10-20');
  assert.equal(f.entry().data.management.targetTime, null);
});
test('relative midnight crossing and unsupported conditions cannot execute a guessed move', (t) => {
  const f = fixture(t, { time: '23:30' });
  start(f, 'Перенеси запись Анны Семёновой на час позже.');
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  assert.match(f.result.text, /меняет день/u);
  for (const raw of [
    'на час позже или на два часа раньше',
    'если получится на час позже',
    'не на час позже',
  ])
    assert.deepEqual(managementRelativeProof({ query: '' }, raw, clock), {}, raw);
});
test('a corrected complete move executes once and replay does not create another appointment', async (t) => {
  const f = fixture(t);
  start(f, 'Перенеси запись Анны Семёновой на 20 октября.');
  assert.equal(f.result.action, null);
  f.answer({ text: 'в одиннадцать утра' });
  const body = f.body();
  const saved = await f.api.execute(f.c, body);
  assert.equal(saved.saved, true);
  assert.equal(saved.moved, true);
  assert.equal(f.row().date, '2026-10-20');
  assert.equal(f.row().time, '11:00');
  assert.equal((await f.api.execute(f.c, body)).saved, true);
  assert.equal(f.calls(), 1);
  assert.equal(f.rows().length, 1);
});
test('an explicit management request overrides only a mismatched non-management model route', () => {
  for (const intent of ['help', 'prepareAppointment', 'calendar'])
    assert.deepEqual(
      normalizeManagementRequest({ intent, date: '2099-12-31' }, 'Измени запись.', clock),
      { intent: 'moveAppointment' },
    );
  assert.equal(
    normalizeManagementRequest({ intent: 'cancelAppointment' }, 'Измени запись.', clock).intent,
    'moveAppointment',
  );
});
test('busy targets expose complete service-fitting ranges and a sole range is never an exact-time confirmation', (t) => {
  const f = fixture(t, {
    beforeStart(value) {
      value.personal.push({ staffId: 'owner', date: '2026-10-20', time: '09:00', duration: 60 });
      value.personal.push({ staffId: 'owner', date: '2026-10-20', time: '10:00', duration: 60 });
    },
  });
  start(f, 'Перенеси запись Анны Семёновой на 20 октября в 09:00');
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.phase, 'period');
  assert.match(f.result.text, /с 07:00 до 09:00.*с 11:00 до 20:00/u);
  assert.doesNotMatch(f.result.text, /08:15|вариант|Подойдёт/u);
  f.answer({ choice: f.result.dialogue.options[0].id });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.action, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  f.answer({ text: 'в восемь утра' });
  ready(f, '2026-10-20', '08:00');
});
test('fresh range pages and a second date never reuse stale time or consent', (t) => {
  const f = fixture(t, {
    beforeStart(value) {
      for (const time of ['09:00', '11:00', '13:00', '15:00'])
        value.personal.push({ staffId: 'owner', date: '2026-10-20', time, duration: 30 });
    },
  });
  start(f, 'Перенеси запись Анны Семёновой на 20 октября в 09:00');
  assert.equal(f.result.dialogue.options.length, 3);
  const more = f.result.dialogue.controls.find((row) => row.label === 'Ещё промежутки');
  assert.ok(more);
  f.answer({ choice: more.id });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.options.length, 2);
  assert.match(f.result.dialogue.options[0].label, /13:30/u);
  const another = f.result.dialogue.controls.find((row) => row.label === 'Другая дата');
  f.answer({ choice: another.id });
  assert.equal(f.result.dialogue.step, 'date');
  f.answer({ text: 'на двадцать первое октября' });
  // The previously spoken requested clock is retained, never a range boundary.
  ready(f, '2026-10-21', '09:00');
});
test('only an explicit nearest-time request offers one exact proposal and still waits for yes', (t) => {
  for (const mode of ['ближайшее свободное время', 'первое свободное время']) {
    const f = fixture(t, {
      beforeStart(value) {
        value.personal.push({ staffId: 'owner', date: '2026-10-20', time: '09:00', duration: 60 });
      },
    });
    start(f, 'Перенеси запись Анны Семёновой на 20 октября в 09:00, предложи ' + mode);
    assert.equal(f.result.dialogue.phase, 'slots');
    assert.equal(f.result.dialogue.options.length, 1);
    assert.equal(f.result.action, null);
    f.answer({ text: 'да' });
    ready(f, '2026-10-20', mode.startsWith('первое') ? '07:00' : '08:30');
  }
});
