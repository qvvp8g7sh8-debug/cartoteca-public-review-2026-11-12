const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistantDialogue } = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const {
  createAppointmentExecution,
} = require('../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const {
  confirmationMatches,
  dayKey,
  exactScheduleKey,
} = require('../src/server/modules/assistant/actions/appointments/schedule-override.cjs');
const { moveExecutionFixture, day } = require('./helpers/assistant-move-execution-fixture.cjs');

function scenario(t, { operation = 'create', role = 'owner', time = '19:00', ...options } = {}) {
  t.mock.method(Date, 'now', () => Date.parse(day + 'T05:00:00Z'));
  const f = moveExecutionFixture(t, { role, targetDate: day, targetTime: time, ...options });
  const memory =
    operation === 'create' ? createAssistantDialogue({ appointmentSavingEnabled: true }) : f.flow;
  const dialogue = operation === 'create' ? memory : f.management;
  const api =
    operation === 'create'
      ? createAppointmentExecution({ ...f.options, dialogues: memory })
      : f.api;
  let result =
    operation === 'create'
      ? dialogue.start(
          f.c,
          {
            intent: 'prepareAppointment',
            query: 'Анна Семёнова',
            serviceQuery: 'Чистка',
            date: day,
            time,
          },
          f.state,
          f.member,
          f.clock,
          memory.beginCommand(f.c, f.member, f.state),
          { openWhenComplete: true, createRequested: true },
        )
      : f.result;
  let activeId = result.action?.executionId || result.dialogue.id;
  const answer = (text) => {
    result = dialogue.continueDialogue(
      f.c,
      { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
      f.state,
      f.member,
      f.clock,
    );
    activeId = result.action?.executionId || result.dialogue?.id || activeId;
    return result;
  };
  if (result.dialogue?.phase === 'appointmentChoice') {
    const entry = memory.get(f.c, f.member, f.state, activeId);
    const source = [...entry.options].find(
      ([, row]) => row.kind === 'appointmentSource' && row.value.appointmentId === f.row().id,
    );
    assert.ok(source, 'select the actual original appointment before testing its destination');
    result = dialogue.continueDialogue(
      f.c,
      {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        choice: source[0],
      },
      f.state,
      f.member,
      f.clock,
    );
  }
  return {
    ...f,
    operation,
    api,
    answer,
    get result() {
      return result;
    },
    entry: () => memory.get(f.c, f.member, f.state, activeId),
    execute: () =>
      api.execute(f.c, { executionId: result.action.executionId, policyVersion: f.state.revision }),
  };
}
function asksOutside(f) {
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.phase, 'closedDay');
  assert.match(f.result.text, /Вне рабочего графика\./u);
  assert.equal(f.result.dialogue.options.length, 1, 'a single explicit confirmation is sufficient');
  assert.equal(f.calls(), 0);
}
function ready(f) {
  assert.equal(
    f.result.action?.type,
    f.operation === 'create' ? 'createAppointment' : 'moveAppointment',
  );
  assert.equal(f.result.dialogue, null);
  assert.equal(f.calls(), 0, 'turn preparation must not save before the execute boundary');
}
for (const operation of ['create', 'move'])
  for (const role of ['owner', 'salon_admin'])
    for (const value of [
      { label: 'after work', time: '19:00' },
      { label: 'crosses the end of work', time: '17:45' },
      {
        label: 'in a break',
        time: '12:30',
        intervals: [
          ['09:00', '12:00'],
          ['14:00', '18:00'],
        ],
      },
    ])
      test(
        operation + '/' + role + ': today ' + value.label + ' asks once, then commits after yes',
        async (t) => {
          const f = scenario(t, { operation, role, ...value });
          const original = structuredClone(f.row()),
            count = f.rows().length;
          asksOutside(f);
          assert.deepEqual(f.row(), original);
          f.answer('ага');
          ready(f);
          const saved = await f.execute();
          assert.equal(saved.saved, true);
          assert.equal(f.calls(), 1);
          assert.equal(f.rows().length, count + (operation === 'create' ? 1 : 0));
          const appointment = f.rows().find((row) => row.id === saved.appointmentId);
          assert.equal(appointment.date, day);
          assert.equal(appointment.time, value.time);
          assert.equal(appointment.duration, 30);
          if (operation === 'move') assert.equal(appointment.id, original.id);
          assert.ok(
            f.scheduleAssertions.some((row) => row.acknowledgement),
            'the common writer receives signed schedule acknowledgement',
          );
        },
      );

for (const operation of ['create', 'move']) {
  test(
    operation + ': consent cannot bypass a personal busy interval outside working hours',
    (t) => {
      const f = scenario(t, {
        operation,
        beforeStart(value) {
          value.personal.push({ staffId: 'owner', date: day, time: '19:00', duration: 30 });
        },
      });
      const before = structuredClone(f.rows());
      asksOutside(f);
      f.answer('верно');
      assert.equal(f.result.action, null);
      assert.match(f.result.text, /занято/u);
      assert.deepEqual(f.rows(), before);
      assert.equal(f.calls(), 0);
    },
  );

  test(operation + ': employee cannot approve an outside-hours appointment', (t) => {
    const f = scenario(t, { operation, role: 'cosmetologist' });
    const before = structuredClone(f.rows());
    assert.equal(f.result.action, null);
    assert.equal(
      f.result.dialogue.options.some((row) => /продолжить|подтверд|^да/iu.test(row.label)),
      false,
    );
    f.answer('да');
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.rows(), before);
  });

  test(
    operation + ': a past time today asks for a new clock without offering schedule confirmation',
    (t) => {
      const f = scenario(t, { operation, time: '07:00' });
      assert.equal(f.result.action, null);
      assert.match(f.result.text, /время уже прошло/iu);
      assert.notEqual(f.result.dialogue.phase, 'closedDay');
      assert.equal(f.calls(), 0);
    },
  );

  test(
    operation + ': a new conflict between confirmation and commit still blocks the write',
    async (t) => {
      const f = scenario(t, { operation });
      asksOutside(f);
      f.answer('да');
      ready(f);
      f.personal.push({ staffId: 'owner', date: day, time: '19:00', duration: 30 });
      const before = structuredClone(f.rows());
      await assert.rejects(f.execute(), { status: 409 });
      assert.deepEqual(f.rows(), before);
      assert.equal(f.calls(), 0);
    },
  );

  test(
    operation + ': a whole closed-day confirmation still accepts the selected future clock once',
    async (t) => {
      const f = scenario(t, { operation, closed: true });
      assert.equal(f.result.dialogue.phase, 'closedDay');
      assert.match(f.result.text, /День не открыт/u);
      f.answer('да-да');
      ready(f);
      const saved = await f.execute();
      assert.equal(saved.saved, true);
      assert.equal(f.calls(), 1);
    },
  );
}

test('exact outside-hours consent expires when date, staff, start or duration changes; closed-day consent retains its existing scope', () => {
  const c = { current: { role: 'owner' } };
  const tuple = { date: day, staffId: 'owner', time: '19:00', duration: 30 };
  const exact = exactScheduleKey(tuple),
    wholeDay = dayKey(tuple);
  assert.equal(confirmationMatches(c, exact, tuple), true);
  for (const changed of [
    { ...tuple, date: '2099-01-06' },
    { ...tuple, staffId: 'colleague' },
    { ...tuple, time: '19:30' },
    { ...tuple, duration: 60 },
  ])
    assert.equal(confirmationMatches(c, exact, changed), false);
  assert.equal(confirmationMatches(c, wholeDay, { ...tuple, time: '20:00', duration: 60 }), true);
  assert.equal(confirmationMatches(c, wholeDay, { ...tuple, date: '2099-01-06' }), false);
  assert.equal(confirmationMatches(c, wholeDay, { ...tuple, staffId: 'colleague' }), false);
  c.current.role = 'cosmetologist';
  assert.equal(confirmationMatches(c, exact, tuple), false);
  assert.equal(confirmationMatches(c, wholeDay, tuple), false);
});
