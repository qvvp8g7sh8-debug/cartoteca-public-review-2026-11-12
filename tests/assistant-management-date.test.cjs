const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managementDateView,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-date.cjs');
const {
  repairOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const clock = { date: '2026-10-17', hour: 8, minute: 0 };
// Appointment eligibility and the dialogue clock share this test's fixed instant.
test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-17T05:00:00Z') });
});
test('management month confirmation stays scoped and never creates an appointment source or action', () => {
  assert.equal(managementDateView({ data: { management: {} } }, clock), null);
  const management = { operation: 'move', dateProposal: { day: 20, date: '2026-10-20' } };
  const before = structuredClone(management);
  const view = managementDateView({ data: { management } }, clock);
  assert.equal(view.step, 'date');
  assert.equal(view.choices.length, 1);
  assert.equal(view.choices[0].kind, 'managementDateMonth');
  assert.equal(view.choices[0].value, '2026-10-20');
  assert.equal(view.choices[0].day, 20);
  assert.deepEqual(management, before);
  assert.equal(view.action, undefined);
});
test('a past proposal cannot offer a move confirmation', () => {
  const view = managementDateView(
    { data: { management: { operation: 'move', dateProposal: { day: 16, date: '2026-10-16' } } } },
    clock,
  );
  assert.equal(view.choices.length, 0);
  assert.match(view.prompt, /уже прошло/u);
});
test('a complete date-prefixed booking command cannot be consumed as a single-field repair', () => {
  const entry = { step: 'client', data: {}, options: new Map() };
  assert.equal(
    repairOperation(entry, 'Завтра на консультацию на 12-30 запиши Анну Семёнову.', clock),
    null,
  );
});

const {
  managementDateOperation,
  normalizeDateAnswer,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-date.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const target = '2026-10-29';
function fixture(t, extra = {}) {
  return moveExecutionFixture(t, {
    targetDate: null,
    targetTime: null,
    clockDate: '2026-10-17',
    beforeStart(f) {
      for (const date of [target, '2026-11-29'])
        f.days[date] = { status: 'working', intervals: [['09:00', '18:00']] };
      extra.beforeStart?.(f);
    },
    ...Object.fromEntries(Object.entries(extra).filter(([name]) => name !== 'beforeStart')),
  });
}
function selected(f) {
  const m = f.entry().data.management;
  return structuredClone({
    source: m.source,
    time: m.targetTime,
    requestedTime: m.requestedTime,
    appointment: f.row(),
  });
}
function ready(f, date = target) {
  if (f.result.dialogue?.step === 'time') {
    assert.equal(f.result.action, null, 'a date alone cannot execute an unheard source clock');
    assert.equal(f.entry().data.management.targetTime, null);
    f.answer({ text: 'в 10:00' });
  }
  assert.equal(f.result.action?.type, 'moveAppointment');
  assert.equal(
    f.result.dialogue,
    null,
    'a complete valid move does not end at another prompt/preview',
  );
  assert.equal(f.entry().data.management.targetDate, date);
  assert.equal(f.entry().data.management.targetTime, '10:00');
  assert.equal(f.calls(), 0, '/turn never mutates clinical data');
}

for (const raw of [
  '29-е',
  '29‑е',
  '29–е',
  '29—е.',
  'на 29 - е.',
  'двадцать девятое',
  'на двадцать девятое число',
  'двадцать девятого числа',
])
  test(
    'a day-only move answer asks its month once, then requires an explicit clock: ' + raw,
    (t) => {
      const f = fixture(t),
        before = selected(f);
      assert.equal(f.result.dialogue.step, 'date');
      f.answer({ text: raw });
      assert.equal(f.result.text, 'Двадцать девятого октября, верно?');
      assert.equal(f.result.dialogue.prompt, f.result.text);
      assert.equal(f.result.dialogue.step, 'date');
      assert.equal(f.result.dialogue.options.length, 1);
      assert.equal(f.result.action, null);
      const m = f.entry().data.management;
      assert.deepEqual(m.source, before.source);
      assert.equal(m.targetTime, before.time);
      assert.deepEqual(f.row(), before.appointment);
      f.answer({ text: 'ага' });
      ready(f);
      assert.deepEqual(f.row(), before.appointment);
    },
  );

for (const raw of [
  '29 октября',
  'на 29 октября.',
  '29октября',
  '29.октября.',
  '29-го октября',
  '29‑го октября',
  '29-е. октября.',
  'двадцать девятого октября',
  'на двадцать девятое октября',
])
  test(
    'a complete move date is accepted without another month yes and asks for its clock: ' + raw,
    (t) => {
      const f = fixture(t),
        before = selected(f);
      f.answer({ text: raw });
      ready(f);
      assert.deepEqual(f.entry().data.management.source, before.source);
      assert.deepEqual(f.row(), before.appointment);
      assert.equal(f.row().duration, before.appointment.duration);
      assert.deepEqual(f.row().serviceItems, before.appointment.serviceItems);
    },
  );

test('the full date followup runs through the actual common mutation using the original appointment id', async (t) => {
  const f = fixture(t),
    before = structuredClone(f.row());
  f.answer({ text: '29 октября' });
  ready(f);
  const result = await f.api.execute(f.c, f.body());
  assert.equal(result.saved, true);
  assert.equal(result.moved, true);
  assert.equal(result.appointmentId, before.id);
  assert.deepEqual(f.row(), { ...before, date: target, time: '10:00' });
  assert.equal(f.rows().length, 1);
  assert.equal(f.calls(), 1);
});

test('a fully stated date can replace a pending month question without a second yes', (t) => {
  const f = fixture(t);
  f.answer({ text: '29-е' });
  assert.equal(f.result.dialogue.prompt, 'Двадцать девятого октября, верно?');
  f.answer({ text: '29 октября' });
  ready(f);
  assert.equal(f.entry().data.management.dateProposal, undefined);
});

test('no retains the day and asks only its month; explicit month resolves into the same move', (t) => {
  const f = fixture(t),
    before = selected(f);
  f.answer({ text: '29-е' });
  f.answer({ text: 'нет' });
  assert.equal(f.result.dialogue.prompt, 'Какого месяца?');
  f.answer({ text: 'в ноябре' });
  ready(f, '2026-11-29');
  assert.deepEqual(f.entry().data.management.source, before.source);
  assert.deepEqual(f.row(), before.appointment);
});

test('invalid, past and alternative dates retain the source and cannot execute an old or guessed target', async (t) => {
  for (const raw of ['31 ноября', '1 октября', '29-е или 30-е']) {
    const f = fixture(t),
      before = structuredClone(f.row());
    f.answer({ text: raw });
    assert.equal(f.result.action, null, raw);
    assert.equal(f.result.dialogue.step, 'date', raw);
    assert.deepEqual(f.row(), before);
    assert.equal(f.calls(), 0);
    await assert.rejects(
      f.api.execute(f.c, { executionId: f.result.dialogue.id, policyVersion: f.state.revision }),
      { status: 409 },
    );
  }
});

test('a pending date reply never supplies an explicitly missing target time', (t) => {
  const f = fixture(t);
  f.start({}, { date: null, time: null });
  f.answer({ text: '29 октября' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.entry().data.management.targetDate, target);
  f.answer({ text: 'в 10:00' });
  ready(f);
});

test('a day answer on source appointment choice selects only a matching existing source, not the target date', (t) => {
  const f = fixture(t, {
    beforeStart(value) {
      value.mutate((next) => {
        next.patients[0].appointments[0].date = target;
      });
      value.addBooking({ date: '2026-11-29', time: '15:00' });
    },
  });
  assert.equal(f.result.dialogue.step, 'appointment');
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  const sourceId = f.row().id;
  f.answer({ text: '29‑е' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  assert.equal(f.result.dialogue.prompt, 'В каком месяце запись?');
  assert.equal(f.entry().data.management.source, null);
  f.answer({ text: 'октября' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'date', 'the new target still has to be named');
  const m = f.entry().data.management;
  assert.equal(m.source.appointmentId, sourceId);
  assert.equal(m.targetDate, null);
  assert.equal(m.dateProposal, undefined);
});

test('a source date filter preserves independent uncertainty about the new target date and time', (t) => {
  const f = fixture(t, {
    beforeStart(value) {
      value.mutate((next) => {
        next.patients[0].appointments[0].date = target;
      });
      value.addBooking({ date: '2026-11-29', time: '15:00' });
    },
  });
  f.start({}, { date: null, time: null });
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  const sourceId = f.row().id;
  f.answer({ text: '29 октября' });
  const m = f.entry().data.management;
  assert.equal(m.source.appointmentId, sourceId);
  assert.equal(m.sourceDate, target);
  assert.equal(m.dateRequired, true);
  assert.equal(m.timeRequired, true);
  assert.equal(m.targetDate, null);
  assert.equal(m.targetTime, null);
  assert.equal(f.result.dialogue.step, 'date');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});

test('a nonmatching source day cannot become a target or fabricate a selected source', (t) => {
  const f = fixture(t, {
    beforeStart(value) {
      value.mutate((next) => {
        next.patients[0].appointments[0].date = '2026-10-25';
      });
      value.addBooking({ date: '2026-10-26', time: '15:00' });
    },
  });
  const before = structuredClone(f.rows());
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  f.answer({ text: '29-е' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.entry().data.management.targetDate, undefined);
  assert.deepEqual(f.rows(), before);
});

test('date normalization consumes the whole answer and leaves ambiguous time or month alternatives unaccepted', () => {
  assert.equal(normalizeDateAnswer('29‑го.октября.'), '29 октября');
  const entry = { step: 'date', data: { management: { operation: 'move' } }, options: new Map() };
  const source = { appointment: { time: '10:00' }, duration: 30 };
  for (const raw of ['29 октября или 30 октября', '29октября в 12:30', 'если 29 октября'])
    assert.equal(managementDateOperation(entry, raw, { date: '2026-10-17' }, source), null, raw);
});
