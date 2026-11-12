const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const {
  prepareManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const {
  managementCommandReply,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-command.cjs');
const afterTomorrow = nextDate(tomorrow);
function multi(t, options = {}) {
  return moveExecutionFixture(t, {
    targetTime: null,
    beforeStart(f) {
      f.addBooking({ date: day, time: '15:00' });
      f.days[afterTomorrow] = { status: 'working', intervals: [['07:00', '20:00']] };
    },
    ...options,
  });
}
function identity(f) {
  return f.entry().data.patient.id;
}
function ready(f, date, time) {
  assert.equal(f.result.action?.type, 'moveAppointment');
  assert.equal(f.entry().data.management.targetDate, date);
  assert.equal(f.entry().data.management.targetTime, time);
  assert.equal(f.calls(), 0);
}
for (const raw of ['в 17:00', afterTomorrow, afterTomorrow + ' в 17:00'])
  test('failed exact source filter remains correctable with target and client: ' + raw, (t) => {
    const f = multi(t),
      before = f.result.dialogue,
      patient = identity(f);
    f.answer({ text: raw });
    assert.equal(f.result.dialogue.id, before.id);
    assert.equal(f.result.dialogue.options.length, 2);
    assert.equal(identity(f), patient);
    assert.equal(f.entry().data.management.initialDate, tomorrow);
    assert.notEqual(f.entry().complete, true);
    f.answer({ text: 'в 15:00' });
    assert.equal(f.result.dialogue.step, 'time');
    f.answer({ text: 'в 16:00' });
    ready(f, tomorrow, '16:00');
  });
for (const raw of ['Перенеси запись на завтра в 16:00', 'Перенеси запись на завтра'])
  test('destination before source cannot select an old appointment: ' + raw, (t) => {
    const f = multi(t, { targetDate: null }),
      id = f.result.dialogue.id;
    const old = f.result.dialogue.options[1].id;
    f.answer({ text: raw });
    assert.equal(f.result.dialogue.id, id);
    assert.equal(f.result.dialogue.phase, 'appointmentChoice');
    assert.equal(f.result.dialogue.options.length, 2);
    assert.equal(f.entry().data.management.source, null);
    assert.equal(f.entry().data.management.initialDate, tomorrow);
    assert.throws(
      () =>
        f.management.continueDialogue(
          f.c,
          {
            dialogueId: id,
            dialogueVersion: 1,
            choice: old,
          },
          f.state,
          f.member,
          f.clock,
        ),
      { status: 409 },
    );
    f.answer({ choice: f.result.dialogue.options[1].id });
    if (!raw.includes('16:00')) f.answer({ text: 'в 16:00' });
    ready(f, tomorrow, '16:00');
    assert.equal(f.entry().data.management.source.appointmentId, f.rows()[1].id);
  });
test('a real old source at the newly requested destination is not silently selected', (t) => {
  const f = multi(t);
  f.addBooking({ date: tomorrow, time: '16:00' });
  f.answer({ text: 'Перенеси запись на завтра в 16:00' });
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  assert.equal(f.result.dialogue.options.length, 3);
  assert.equal(f.entry().data.management.source, null);
  assert.equal(f.result.action, null);
});
for (const named of [false, true])
  test('date plus slot search clears the previous exact hour and consent, named=' + named, (t) => {
    const f = moveExecutionFixture(t, { closed: true });
    assert.equal(f.result.dialogue.phase, 'closedDay');
    f.days[afterTomorrow] = { status: 'working', intervals: [['07:00', '20:00']] };
    const source = structuredClone(f.entry().data.management.source);
    f.answer({
      text:
        (named ? 'Перенеси запись Анны Семёновой на ' : '') +
        afterTomorrow +
        ' подбери свободное время',
    });
    assert.equal(f.result.action, null);
    assert.equal(f.entry().data.management.targetTime, null);
    assert.equal(f.entry().data.management.targetDate, afterTomorrow);
    assert.deepEqual(f.entry().data.management.source, source);
    assert.ok([...f.entry().options.values()].some((row) => row.kind === 'managementRange'));
    assert.equal(f.entry().data.management.closedConfirmation, undefined);
    assert.equal(f.entry().data.management.movePreparation, undefined);
    assert.equal(f.calls(), 0);
  });
test('date plus search before source keeps both independent questions', (t) => {
  const f = multi(t, { targetDate: null });
  f.answer({ text: 'завтра подбери свободное время' });
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  f.answer({ choice: f.result.dialogue.options[0].id });
  assert.equal(f.result.action, null);
  assert.equal(f.entry().data.management.targetDate, tomorrow);
  assert.ok([...f.entry().options.values()].some((row) => row.kind === 'managementRange'));
});
for (const period of ['утром', 'с 7 до 9', 'после обеда'])
  test('initial spoken period constrains a later nearest search: ' + period, (t) => {
    const f = moveExecutionFixture(t, { targetTime: null, intervals: [['07:00', '20:00']] });
    const { intent, constraints } = prepareManagementIntent(
      { intent: 'moveAppointment', query: 'Анна Семёнова' },
      'Перенеси запись Анны Семёновой на завтра ' + period,
      f.clock,
    );
    f.start(intent, constraints);
    assert.ok(f.entry().data.management.targetWindow);
    f.answer({ text: 'подбери ближайшее время' });
    assert.equal(f.result.action, null);
    const slot = [...f.entry().options.values()].find((row) => row.kind === 'managementTarget');
    assert.ok(slot);
    const window = f.entry().data.management.targetWindow;
    assert.ok(slot.value.time >= window.from);
    const [h, m] = slot.value.time.split(':').map(Number);
    const [toH, toM] = window.to.split(':').map(Number);
    assert.ok(h * 60 + m + 30 <= toH * 60 + toM);
  });
test('a period with no fitting duration never widens to the afternoon', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    sourceDuration: 60,
    intervals: [['13:00', '20:00']],
  });
  const { intent, constraints } = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Анна Семёнова' },
    'Перенеси запись Анны Семёновой на завтра утром',
    f.clock,
  );
  f.start(intent, constraints);
  f.answer({ text: 'подбери ближайшее время' });
  assert.equal(f.result.action, null);
  assert.ok(![...f.entry().options.values()].some((row) => row.kind === 'managementTarget'));
});
test('spoken period correction preserves source and new date; exact clock may explicitly replace it', (t) => {
  const f = moveExecutionFixture(t, { targetTime: null, intervals: [['07:00', '20:00']] });
  const source = structuredClone(f.entry().data.management.source);
  f.answer({ text: 'утром' });
  assert.deepEqual(f.entry().data.management.source, source);
  assert.equal(f.entry().data.management.targetDate, tomorrow);
  f.answer({ text: 'в 16:00' });
  ready(f, tomorrow, '16:00');
  assert.equal(f.entry().data.management.targetWindow, undefined);
});
function cancelList(t) {
  const f = cancellationFixture(t),
    next = f.storage.read();
  next.patients[0].appointments = [
    { ...f.source },
    { ...f.source, id: randomUUID(), date: tomorrow, time: '18:00', service: 'Консультация' },
  ];
  f.storage.write(next);
  let result = f.management.start(
    f.c,
    { intent: 'cancelAppointment', query: 'Анна Семёнова' },
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
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        ...operation,
      };
      result = f.management.continueDialogue(f.c, body, f.state, f.member, f.clock);
      return body;
    },
    entry() {
      return f.flow.get(f.c, f.member, f.state, result.action?.executionId || result.dialogue.id);
    },
  };
}
for (const reply of ['Нет, запись в 18:00', 'Нет, на завтра', 'Нет, на 6-е', 'Нет, консультация'])
  test(
    'cancel content correction selects an actual appointment and asks new consent: ' + reply,
    async (t) => {
      const f = cancelList(t),
        id = f.result.dialogue.id;
      f.answer({ choice: f.result.dialogue.options[0].id });
      const old = {
        dialogueId: id,
        dialogueVersion: f.result.dialogue.version,
        choice: f.result.dialogue.options[0].id,
      };
      f.answer({ text: reply });
      assert.equal(f.result.dialogue.id, id);
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.match(f.result.text, /18:00/u);
      assert.equal(f.entry().data.management.cancelConfirmed, undefined);
      assert.equal(f.result.action, null);
      assert.throws(() => f.management.continueDialogue(f.c, old, f.state, f.member, f.clock), {
        status: 409,
      });
      f.answer({ text: 'да' });
      const saved = await f.api.execute(f.c, { executionId: id, policyVersion: f.state.revision });
      assert.equal(saved.cancelled, true);
      const rows = f.storage.readSelected([f.patients[0].id]).patients[0].appointments;
      assert.equal(rows[0].status, 'scheduled');
      assert.equal(rows[1].status, 'cancelled');
    },
  );
for (const reply of ['Нет, запись в 17:00', 'Нет, на ' + afterTomorrow])
  test('unmatched cancellation correction keeps a selectable client draft: ' + reply, (t) => {
    const f = cancelList(t),
      patient = f.entry().data.patient.id;
    f.answer({ choice: f.result.dialogue.options[0].id });
    f.answer({ text: reply });
    assert.equal(f.result.dialogue.phase, 'appointmentChoice');
    assert.equal(f.entry().data.patient.id, patient);
    assert.equal(f.entry().data.management.cancelConfirmation, undefined);
    assert.equal(f.result.action, null);
  });
test('same named move preserves the selected source and date, executes once', async (t) => {
  const f = multi(t),
    id = f.result.dialogue.id;
  f.answer({ choice: f.result.dialogue.options[1].id });
  const source = structuredClone(f.entry().data.management.source);
  f.answer({ text: 'Перенеси запись Анны Семёновой на 16:00' });
  ready(f, tomorrow, '16:00');
  assert.equal(f.result.action.executionId, id);
  assert.deepEqual(f.entry().data.management.source, source);
  const body = f.body();
  const first = await f.api.execute(f.c, body),
    second = await f.api.execute(f.c, body);
  assert.equal(first.moved, true);
  assert.equal(second.moved, true);
  assert.equal(second.alreadySaved, true);
  assert.equal(f.calls(), 1);
});
test('a different or ambiguous named client cannot be merged into the owned draft', (t) => {
  const f = multi(t),
    entry = f.entry();
  assert.equal(
    managementCommandReply(f.c, entry, 'Перенеси запись Ирины Ивановой на 16:00', f.clock),
    null,
  );
  const next = f.storage.read();
  const other = { ...structuredClone(next.patients[0]), id: randomUUID() };
  other.appointments.forEach((row) => {
    row.id = randomUUID();
  });
  next.patients.push(other);
  f.storage.write(next);
  assert.equal(
    managementCommandReply(f.c, entry, 'Перенеси запись Анны Семёновой на 16:00', f.clock),
    null,
  );
});
for (const reply of ['Нет, в 18:00 или 19:00', 'Нет, отмени другую запись', 'Нет, если завтра'])
  test(
    'mixed cancellation correction cannot change source or authorize cancellation: ' + reply,
    (t) => {
      const f = cancelList(t);
      f.answer({ choice: f.result.dialogue.options[0].id });
      const before = structuredClone(f.entry().data.management.source);
      f.answer({ text: reply });
      assert.deepEqual(f.entry().data.management.source, before);
      assert.equal(f.result.action, null);
    },
  );
test('revoked permission rejects a source correction and preserves actual records', (t) => {
  const f = multi(t);
  f.revoke();
  assert.throws(() => f.answer({ text: 'в 17:00' }), { status: 403 });
  assert.equal(f.calls(), 0);
});
test('an invalid exact source filter preserves independent staff/service filters', (t) => {
  const f = multi(t),
    m = f.entry().data.management;
  m.staffQuery = 'Тестовый Специалист';
  m.sourceServiceQuery = 'Чистка';
  f.answer({ text: 'в 17:00' });
  assert.equal(f.entry().data.management.staffQuery, 'Тестовый Специалист');
  assert.equal(f.entry().data.management.sourceServiceQuery, 'Чистка');
  assert.equal(f.result.dialogue.options.length, 2);
  f.answer({ text: 'в 15:00' });
  assert.equal(f.result.dialogue.step, 'time');
});
test('an actually empty future source list is distinct from an unmatched filter', (t) => {
  const f = multi(t);
  f.mutate((next) => {
    next.patients[0].appointments = [];
  });
  f.answer({ text: 'в 17:00' });
  assert.equal(f.result.dialogue, null);
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
test('a changed source stamp cannot be bypassed by correcting its cancellation time', (t) => {
  const f = cancelList(t);
  f.answer({ choice: f.result.dialogue.options[0].id });
  const next = f.storage.read();
  next.patients[0].appointments[0].time = '11:00';
  f.storage.write(next);
  assert.throws(() => f.answer({ text: 'Нет, запись в 18:00' }), { status: 409 });
  assert.equal(f.calls(), 0);
});
test('initial day/month confirmation retains its morning period', (t) => {
  const f = moveExecutionFixture(t, { targetTime: null, targetDate: null });
  const { intent, constraints } = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Анна Семёнова' },
    'Перенеси запись Анны Семёновой на шестое утром',
    f.clock,
  );
  f.start(intent, constraints);
  assert.equal(f.result.dialogue.phase, 'date');
  f.answer({ text: 'да' });
  assert.equal(f.entry().data.management.targetDate, tomorrow);
  assert.equal(f.entry().data.management.targetWindow.kind, 'morning');
  f.answer({ text: 'ближайшее время' });
  const slot = [...f.entry().options.values()].find((row) => row.kind === 'managementTarget');
  assert.ok(slot.value.time < '12:00');
  assert.equal(f.result.action, null);
});
test('a whole duration must fit inside the initial spoken period even with an exact clock', (t) => {
  const f = moveExecutionFixture(t, {
    targetTime: null,
    intervals: [['07:00', '20:00']],
    sourceDuration: 60,
  });
  const { intent, constraints } = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Анна Семёнова' },
    'Перенеси запись Анны Семёновой на завтра с 7 до 9 в 8:30',
    f.clock,
  );
  f.start(intent, constraints);
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /не помещается/u);
  assert.equal(f.entry().data.management.targetTime, null);
});
for (const raw of ['утром или вечером', 'с 9 до 7', 'утром и отмени запись'])
  test('uncertain or mixed period cannot partially change the selected target: ' + raw, (t) => {
    const f = moveExecutionFixture(t, { closed: true });
    const before = structuredClone(f.entry().data.management.source),
      date = f.entry().data.management.targetDate;
    f.answer({ text: raw });
    assert.equal(f.result.action, null);
    assert.deepEqual(f.entry().data.management.source, before);
    assert.equal(f.entry().data.management.targetDate, date);
  });
test('repeating a named cancel date keeps the client and requests consent for the new source', (t) => {
  const f = cancelList(t),
    id = f.result.dialogue.id;
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'Отмени запись Анны Семёновой на завтра' });
  assert.equal(f.result.dialogue.id, id);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.match(f.result.text, /18:00/u);
  assert.equal(f.result.action, null);
});
