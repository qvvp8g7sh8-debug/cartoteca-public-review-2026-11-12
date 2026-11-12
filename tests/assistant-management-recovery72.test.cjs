const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  createAppointmentExecution,
} = require('../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const {
  isAffirmativeAnswer,
  isConfirmationAnswer,
} = require('../src/server/modules/assistant/dialogue/affirmative-answer.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
function bump(f) {
  f.storage.write(f.storage.read());
}
function cancelList(t, rows, values = {}) {
  const f = cancellationFixture(t);
  const next = f.storage.read();
  next.patients[0].appointments = rows.map((row) => ({ ...f.source, id: randomUUID(), ...row }));
  f.storage.write(next);
  let result = f.management.start(
    f.c,
    { intent: 'cancelAppointment', query: 'Анна Семёнова', ...values },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
  );
  return {
    ...f,
    get result() {
      return result;
    },
    answer(operation) {
      result = f.management.continueDialogue(
        f.c,
        { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, ...operation },
        f.state,
        f.member,
        f.clock,
      );
      return result;
    },
    entry() {
      return f.flow.get(f.c, f.member, f.state, result.dialogue.id);
    },
  };
}
test('unrelated revision renews cancellation in the same dialogue and consumes no old yes', (t) => {
  const f = cancellationFixture(t),
    before = f.result.dialogue,
    old = before.options[0].id;
  bump(f);
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.id, before.id);
  assert.ok(f.result.dialogue.version > before.version);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.row().status, 'scheduled');
  assert.throws(
    () =>
      f.management.continueDialogue(
        f.c,
        { dialogueId: before.id, dialogueVersion: before.version, choice: old },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  f.answer({ text: 'да' });
  assert.equal(f.result.action.type, 'cancelAppointment');
  assert.equal(f.calls(), 0);
});
test('repeating the prior accepted turn after a revision renews instead of trapping its receipt', (t) => {
  const f = cancelList(t, [{ time: '10:00' }, { time: '15:00' }]);
  const body = {
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    choice: f.result.dialogue.options[0].id,
  };
  f.answer({ choice: body.choice });
  bump(f);
  const reply = f.management.continueDialogue(f.c, body, f.state, f.member, f.clock);
  assert.equal(reply.dialogue.phase, 'cancelConfirmation');
  assert.equal(reply.action, null);
});
test('a changed client name renews its actual identity question instead of reusing the old label', (t) => {
  const f = cancellationFixture(t),
    next = f.storage.read();
  next.patients[0].firstName = 'Ольга';
  next.patients[0].name = 'Ольга Семёнова';
  f.storage.write(next);
  f.answer({ text: 'отменяй' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
  assert.match(f.result.dialogue.fields.find((row) => row.key === 'client').value, /Ольга/u);
  assert.equal(f.row().status, 'scheduled');
});
for (const changed of ['source', 'permission'])
  test('consent renewal never replaces a changed ' + changed, (t) => {
    const f = cancellationFixture(t);
    if (changed === 'permission') f.revoke();
    else {
      const next = f.storage.read();
      next.patients[0].appointments[0].time = '11:00';
      f.storage.write(next);
    }
    assert.throws(() => f.answer({ text: 'да' }), { status: changed === 'permission' ? 403 : 409 });
    assert.equal(f.row().status, 'scheduled');
  });
for (const duringCommit of [false, true])
  test(
    'stale cancellation execution returns bound recovery then executes only after a new yes, race=' +
      duringCommit,
    async (t) => {
      const f = cancellationFixture(t);
      const api = createAppointmentExecution({
        ...f.options,
        recoverExecutionTime(c, entry, fresh, error) {
          return f.management.recoverExecutionTime(
            c,
            entry,
            fresh.state,
            fresh.member,
            f.clock,
            error,
          );
        },
      });
      f.answer({ text: 'да' });
      const body = f.body();
      if (duringCommit)
        f.hooks.beforeCommit = () => {
          delete f.hooks.beforeCommit;
          bump(f);
        };
      else bump(f);
      const reply = await api.execute(f.c, body);
      assert.equal(reply.saved, false);
      assert.equal(reply.definitive, true);
      assert.equal(reply.recovery.dialogue.phase, 'cancelConfirmation');
      assert.equal(reply.recovery.action, null);
      assert.equal(f.row().status, 'scheduled');
      const repeated = await api.execute(f.c, body);
      assert.deepEqual(repeated, reply);
      const dialogue = reply.recovery.dialogue;
      const ready = f.management.continueDialogue(
        f.c,
        { dialogueId: dialogue.id, dialogueVersion: dialogue.version, text: 'отменяй' },
        f.state,
        f.member,
        f.clock,
      );
      assert.equal(ready.action.type, 'cancelAppointment');
      assert.equal((await api.execute(f.c, body)).saved, true);
      assert.equal(f.row().status, 'cancelled');
      assert.equal((await api.execute(f.c, body)).alreadySaved, true);
    },
  );
for (const raw of ['Нет, другую', 'Нет, другую запись', 'Не эту запись'])
  test(
    'a negative source correction returns actual appointments without cancelling: ' + raw,
    (t) => {
      const f = cancelList(t, [{ time: '10:00' }, { time: '15:00' }]);
      const ids = f.result.dialogue.options.map((row) => row.id);
      f.answer({ choice: ids[0] });
      f.answer({ text: raw });
      assert.equal(f.result.dialogue.phase, 'appointmentChoice');
      assert.equal(f.result.dialogue.options.length, 2);
      assert.equal(f.entry().data.management.source, null);
      assert.equal(f.entry().data.management.cancelConfirmed, undefined);
      assert.equal(f.calls(), 0);
    },
  );
test('a remembered second source is rechecked and requires its own cancellation consent', (t) => {
  const f = cancelList(t, [{ time: '10:00' }, { time: '15:00' }]);
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'Нет, вторую' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.match(f.result.dialogue.prompt, /15:00/u);
  assert.equal(f.result.action, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.action.type, 'cancelAppointment');
  assert.equal(f.calls(), 0);
});
test('a stale remembered second source refreshes the list without substituting another appointment', (t) => {
  const f = cancelList(t, [{ time: '10:00' }, { time: '15:00' }]);
  f.answer({ choice: f.result.dialogue.options[0].id });
  const next = f.storage.read();
  next.patients[0].appointments[1].time = '16:00';
  f.storage.write(next);
  f.answer({ text: 'Нет, вторую' });
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  assert.equal(f.result.action, null);
});
test('a short changed day replaces the full source date while retaining established month and service', (t) => {
  const f = cancelList(
    t,
    [
      { date: '2099-01-21' },
      { date: '2099-01-21', time: '15:00' },
      { date: '2099-01-22' },
      { date: '2099-02-22' },
    ],
    { date: '2099-01-21' },
  );
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: '22-е' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.entry().data.management.cancelConfirmation.appointment.date, '2099-01-22');
  assert.equal(f.entry().data.management.sourceDate, undefined);
  assert.equal(f.result.action, null);
});
test('an unmatched short correction preserves the previous valid source filter', (t) => {
  const f = cancelList(t, [{ date: '2099-01-21' }, { date: '2099-01-21', time: '15:00' }], {
    date: '2099-01-21',
  });
  f.answer({ text: '22-е' });
  assert.equal(f.result.dialogue.options.length, 2);
  assert.equal(f.entry().data.management.sourceDate, '2099-01-21');
  assert.equal(f.entry().data.management.source, null);
});
test('nearest move search remains inside the chosen range and fits its entire duration', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    intervals: [
      ['07:00', '09:00'],
      ['11:00', '18:00'],
    ],
  });
  f.answer({ text: 'покажи свободные окна' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'подбери ближайшее время' });
  assert.equal(f.result.dialogue.phase, 'slots');
  const m = f.entry().data.management;
  const slot = [...f.entry().options.values()][0].value;
  assert.equal(slot.date, tomorrow);
  assert.ok(slot.time >= '07:00' && slot.time <= '08:30');
  assert.equal(m.targetWindow.from, '07:00');
  assert.equal(m.targetWindow.to, '09:00');
  assert.equal(f.result.action, null);
});
test('explicit clock correction can replace a chosen move period', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    intervals: [
      ['07:00', '09:00'],
      ['11:00', '18:00'],
    ],
  });
  f.answer({ text: 'покажи свободные окна' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'в 14:00' });
  assert.equal(f.result.action.type, 'moveAppointment');
  assert.equal(f.entry().data.management.targetWindow, undefined);
});
test('changing the target date clears the old range without supplying an unspoken clock', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    intervals: [
      ['07:00', '09:00'],
      ['11:00', '18:00'],
    ],
  });
  f.answer({ text: 'покажи свободные окна' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: nextDate(tomorrow) });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.targetWindow, undefined);
  assert.equal(f.entry().data.management.targetDate, nextDate(tomorrow));
  assert.equal(f.entry().data.management.targetTime, null);
});
test('a selected range that becomes busy never broadens a nearest search to the rest of the day', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    intervals: [
      ['07:00', '09:00'],
      ['11:00', '18:00'],
    ],
  });
  f.answer({ text: 'покажи свободные окна' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.addBooking({ date: tomorrow, time: '07:00', duration: 120 });
  f.answer({ text: 'ближайшее свободное время' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.options.length, 0);
  assert.match(f.result.dialogue.prompt, /нет свободного промежутка/u);
});
for (const [raw, direction] of [
  ['попозже', 1],
  ['пораньше', -1],
])
  test(
    'an incomplete relative move asks its amount and applies the answer to the same source: ' + raw,
    (t) => {
      const f = moveExecutionFixture(t, { targetTime: null });
      const source = structuredClone(f.entry().data.management.source);
      f.answer({ text: raw });
      assert.match(f.result.dialogue.prompt, /На сколько перенести/u);
      assert.equal(f.result.action, null);
      assert.equal(f.entry().data.management.targetDate, tomorrow);
      f.answer({ text: 'на час' });
      assert.equal(f.result.action.type, 'moveAppointment');
      assert.equal(f.entry().data.management.targetTime, direction === 1 ? '11:00' : '09:00');
      assert.deepEqual(f.entry().data.management.source, source);
      assert.equal(f.entry().data.management.pendingShift, undefined);
    },
  );
test('an alternative relative amount never applies only a fragment or loses the target date', (t) => {
  const f = moveExecutionFixture(t, { targetTime: null });
  f.answer({ text: 'попозже' });
  f.answer({ text: 'на час или на два' });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.targetDate, tomorrow);
  assert.equal(f.entry().data.management.targetTime, null);
});
for (const [kind, words] of [
  ['cancel', ['отменяй', 'отмени', 'удаляй эту запись']],
  ['move', ['переноси', 'продолжай', 'перенеси эту запись']],
])
  test('bare action confirmations are scoped to their bound operation: ' + kind, () => {
    for (const raw of words) {
      assert.equal(isConfirmationAnswer(raw, kind), true, raw);
      assert.equal(isAffirmativeAnswer(raw), false, raw);
      assert.equal(isConfirmationAnswer(raw, kind === 'move' ? 'cancel' : 'move'), false, raw);
      for (const unsafe of ['не ' + raw, raw + ' если получится', raw + ' и создай новую запись'])
        assert.equal(isConfirmationAnswer(unsafe, kind), false, unsafe);
    }
  });
test('bare move consent is accepted only at the existing closed-day question', (t) => {
  const f = moveExecutionFixture(t, { closed: true });
  assert.equal(f.result.dialogue.phase, 'closedDay');
  f.answer({ text: 'переноси' });
  assert.equal(f.result.action.type, 'moveAppointment');
});
test('a bare operation without a bound question never executes or supplies a missing clock', (t) => {
  const f = moveExecutionFixture(t, { targetDate: null, targetTime: null });
  f.answer({ text: 'переноси' });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.targetTime, null);
  const cancel = cancelList(t, [{ time: '10:00' }, { time: '15:00' }]);
  cancel.answer({ text: 'отменяй' });
  assert.equal(cancel.result.action, null);
  assert.equal(cancel.calls(), 0);
});
