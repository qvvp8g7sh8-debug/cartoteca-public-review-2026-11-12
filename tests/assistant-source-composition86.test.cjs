const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  managementTemporalReplacement,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-replacement.cjs');
const {
  sourceFilterComposition,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-entities.cjs');
const clock = { date: '2099-01-05', time: '08:00' };
function setup(t, values = {}, options = {}) {
  const f = moveExecutionFixture(t, {
    enabled: false,
    targetDate: null,
    targetTime: null,
    ...options,
    beforeStart(f) {
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
        time: '12:00',
        service: 'Пилинг PRX-T133',
        serviceItems: [],
      });
      f.addBooking({ date: '2099-01-06', time: '15:00', service: 'Чистка', serviceItems: [] });
      f.addBooking({
        date: '2099-01-06',
        time: '14:00',
        service: 'Чистка',
        serviceItems: [],
        staffId: 'staff-maria',
      });
      options.beforeStart?.(f);
    },
  });
  f.start(values);
  const id = f.result.dialogue.id;
  const original = JSON.stringify(f.storage.read());
  return {
    ...f,
    get result() {
      return f.result;
    },
    entry: () => f.flow.get(f.c, f.member, f.state, id),
    turn(text) {
      const result = f.answer({ text });
      assert.equal(JSON.stringify(f.storage.read()), original);
      assert.equal(f.calls(), 0);
      return result;
    },
    choose(index) {
      return f.answer({ choice: f.result.dialogue.options[index - 1].id });
    },
  };
}
const management = (f) => f.entry().data.management;
const source = (f) => f.rows().find((row) => row.id === management(f).source?.appointmentId);
const permutations = [
  'завтра в 14:00 у Марии на чистку',
  'завтра в 14:00 на чистку у Марии',
  'у Марии завтра в 14:00 на чистку',
  'у Марии на чистку завтра в 14:00',
  'на чистку завтра в 14:00 у Марии',
  'на чистку у Марии завтра в 14:00',
];
for (const intent of ['cancelAppointment', 'moveAppointment', 'editAppointment'])
  for (const text of permutations)
    test(intent + ' first source choice composes all roles: ' + text, (t) => {
      const f = setup(t, { intent });
      f.turn(text);
      assert.equal(source(f)?.staffId, 'staff-maria');
      assert.equal(source(f)?.date, '2099-01-06');
      assert.equal(source(f)?.time, '14:00');
      assert.equal(source(f)?.service, 'Чистка');
      if (intent === 'cancelAppointment') {
        assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
        assert.equal(management(f).cancelConfirmed, undefined);
        assert.equal(f.result.action, null);
      }
    });
for (const text of [
  'завтра у Марии',
  'у Марии завтра',
  'завтра в 14:00 у Марии',
  'Нет, завтра у Марии',
  'Нет, на чистку завтра в 14:00 у Марии',
])
  test(
    'staff/date shorthand uses the same first-choice and cancellation correction: ' + text,
    (t) => {
      const first = setup(t, { intent: 'cancelAppointment' });
      first.turn(text);
      const second = setup(t, { intent: 'cancelAppointment' });
      second.choose(1);
      const oldChoice = second.result.dialogue.options[0].id;
      second.turn(text.startsWith('Нет,') ? text : 'Нет, ' + text);
      for (const f of [first, second]) {
        assert.equal(source(f)?.staffId, 'staff-maria');
        assert.equal(source(f)?.time, '14:00');
        assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
        assert.equal(f.result.action, null);
      }
      assert.notEqual(second.result.dialogue.options[0].id, oldChoice);
    },
  );
for (const text of [
  'завтра в 25:00 у Марии',
  'у Марии завтра в 25:00',
  'на чистку у Марии завтра в 25:00',
])
  test('source tuple keeps the proven day while requesting an invalid clock: ' + text, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.turn(text);
    assert.equal(management(f).source, null);
    assert.equal(management(f).sourceDate, '2099-01-06');
    assert.equal(management(f).staffQuery.toLowerCase(), 'марии');
    assert.equal(management(f).sourceTimeRequired, true);
    assert.equal(f.result.action, null);
    f.turn('в 14:00');
    assert.equal(source(f)?.staffId, 'staff-maria');
    assert.equal(source(f)?.time, '14:00');
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  });
for (const text of [
  'если завтра у Марии',
  'завтра или сегодня у Марии',
  'завтра у Марии отмени другую запись',
  'завтра у Марии и на чистку',
  'завтра на чистку или пилинг у Марии',
  'завтра на чистку у Марии сохрани',
])
  test('source composition cannot discard an unsafe remainder: ' + text, () => {
    assert.equal(sourceFilterComposition(text, clock), null);
  });
for (const [text, positive] of [
  ['Не в 16:00, а в 17:00', 'в 17:00'],
  ['Нет, не в 16:00, а в 17:00', 'в 17:00'],
  ['не на седьмое, а на восьмое января', 'на восьмое января'],
  ['не завтра, а послезавтра', 'послезавтра'],
  ['не завтра в 16:00, а послезавтра в 17:00', 'послезавтра в 17:00'],
])
  test('whole temporal replacement proves its final positive clause: ' + text, () => {
    assert.equal(managementTemporalReplacement(text, clock), positive);
  });
for (const text of [
  'не в 16:00, а завтра',
  'не Анну, а в 17:00',
  'не в 16:00, а в 17:00 или 18:00',
  'не в 16:00, а в 17:00 если получится',
  'не в 16:00, а в 17:00 отмени запись',
  'не в 16:00, а не в 17:00',
  'не в 16:00, а в 17:00, а в 18:00',
  'не завтра, а у Марии',
])
  test('temporal replacement does not weaken field provenance: ' + text, () => {
    assert.equal(managementTemporalReplacement(text, clock), null);
  });
for (const text of ['не в 16:00, а в 17:00', 'Нет, не в 16:00, а в 17:00'])
  test('moving applies a positive time replacement while retaining its date: ' + text, (t) => {
    const f = setup(t, { date: '2099-01-07', time: '16:00' });
    f.choose(1);
    f.turn(text);
    assert.equal(management(f).targetDate, '2099-01-07');
    assert.equal(management(f).targetTime, '17:00');
    assert.equal(management(f).movePreparation, undefined);
    assert.equal(f.result.dialogue.phase, 'closedDay');
  });
test('moving applies a positive date replacement while retaining its clock', (t) => {
  const f = setup(t, { date: '2099-01-07', time: '16:00' });
  f.choose(1);
  f.turn('не на седьмое, а на восьмое января');
  assert.equal(management(f).targetDate, '2099-01-08');
  assert.equal(management(f).targetTime, '16:00');
  assert.equal(f.result.dialogue.phase, 'closedDay');
});
test('cancellation temporal replacement renews consent against a real appointment', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const old = f.result.dialogue.options[0].id;
  f.turn('Не в 10:00, а в 14:00');
  assert.equal(source(f)?.staffId, 'staff-maria');
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.notEqual(f.result.dialogue.options[0].id, old);
  assert.equal(management(f).cancelConfirmed, undefined);
  assert.throws(() => f.answer({ choice: old }), { status: 409 });
});
test('revoked access blocks a compound source selection before changing state', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  const before = structuredClone(management(f));
  f.revoke();
  assert.throws(() => f.turn(permutations[0]), { status: 403 });
  assert.deepEqual(management(f), before);
  assert.equal(f.calls(), 0);
});
for (const text of ['не чистку, а пилинг PRX', 'Нет, не на чистку, а на пилинг PRX'])
  test(
    'cancellation service replacement is anchored to the selected real service: ' + text,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.choose(1);
      const old = f.result.dialogue.options[0].id;
      f.turn(text);
      assert.equal(source(f)?.service, 'Пилинг PRX-T133');
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.notEqual(f.result.dialogue.options[0].id, old);
      assert.equal(management(f).cancelConfirmed, undefined);
      assert.equal(f.result.action, null);
    },
  );
for (const text of ['не первую, а вторую', 'Нет, не первую запись, а вторую запись'])
  test(
    'cancellation ordinal replacement binds the old ordinal to its selected appointment: ' + text,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.choose(1);
      const old = f.result.dialogue.options[0].id;
      f.turn(text);
      assert.equal(source(f)?.service, 'Пилинг PRX-T133');
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.notEqual(f.result.dialogue.options[0].id, old);
      assert.equal(management(f).cancelConfirmed, undefined);
    },
  );
for (const text of [
  'не третью, а вторую',
  'не первую, а вторую или третью',
  'не первую, а вторую если свободно',
  'не чистку, а пилинг PRX отмени запись',
  'не консультацию, а пилинг PRX',
])
  test(
    'negative source correction cannot discard an unproven anchor or unsafe tail: ' + text,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.choose(1);
      const before = management(f).source.appointmentId;
      f.turn(text);
      assert.equal(management(f).source.appointmentId, before);
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.equal(f.result.action, null);
    },
  );
test('cancellation staff replacement searches fresh appointments and drops the old consent', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(3);
  assert.equal(source(f).staffId, 'staff-maria');
  const old = f.result.dialogue.options[0].id;
  f.turn('Нет, не у Марии, а у Тестовый Специалист');
  assert.equal(management(f).source, null);
  assert.equal(management(f).cancelConfirmation, undefined);
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  assert.equal(f.result.dialogue.options.length, 3);
  assert.throws(() => f.answer({ choice: old }), { status: 409 });
  f.choose(2);
  assert.notEqual(source(f).staffId, 'staff-maria');
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
});
function periodSetup(t) {
  return setup(
    t,
    { intent: 'cancelAppointment' },
    {
      beforeStart(f) {
        for (const [time, duration] of [
          ['08:30', 30],
          ['14:45', 30],
          ['18:30', 30],
        ])
          f.addBooking({
            date: '2099-01-06',
            time,
            duration,
            staffId: 'staff-maria',
            service: 'Чистка',
            serviceItems: [],
          });
      },
    },
  );
}
for (const [text, expected] of [
  ['завтра утром у Марии', '08:30'],
  ['у Марии завтра вечером', '18:30'],
  ['на чистку у Марии завтра с 13 до 14:30', '14:00'],
])
  test('actual source selection honors an entire spoken period: ' + text, (t) => {
    const f = periodSetup(t);
    f.turn(text);
    assert.equal(source(f)?.staffId, 'staff-maria');
    assert.equal(source(f)?.time, expected);
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.equal(management(f).sourceTimeRequired, undefined);
    assert.equal(management(f).cancelConfirmed, undefined);
    assert.equal(f.result.action, null);
  });
test('an exact correction replaces the previous source period and renews consent', (t) => {
  const f = periodSetup(t);
  f.turn('завтра утром у Марии');
  const old = f.result.dialogue.options[0].id;
  f.turn('Нет, в 14:00');
  assert.equal(source(f)?.time, '14:00');
  assert.equal(management(f).sourceWindow, undefined);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.notEqual(f.result.dialogue.options[0].id, old);
  assert.equal(f.result.action, null);
});
test('a source period cannot include an appointment extending beyond its end', (t) => {
  const f = periodSetup(t);
  f.turn('завтра с 14:30 до 15:00 у Марии');
  assert.equal(management(f).source, null);
  assert.equal(management(f).cancelConfirmation, undefined);
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /не наш[её]л|нет/u);
});
for (const intent of ['cancelAppointment', 'editAppointment'])
  test(intent + ' uses a bare period to filter its actual source appointments', (t) => {
    const f = setup(
      t,
      { intent },
      {
        beforeStart(f) {
          f.addBooking({
            date: '2099-01-06',
            time: '18:30',
            staffId: 'staff-maria',
            service: 'Чистка',
            serviceItems: [],
          });
        },
      },
    );
    f.turn('завтра вечером');
    assert.equal(source(f)?.time, '18:30');
    assert.equal(source(f)?.staffId, 'staff-maria');
    assert.equal(management(f).sourceTimeRequired, undefined);
    if (intent === 'cancelAppointment') {
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.equal(f.result.action, null);
    } else {
      assert.equal(f.result.action.type, 'appointmentPreview');
      assert.equal(f.result.action.operation, 'edit');
    }
  });
test('a bare period in a move remains a target constraint before source choice', (t) => {
  const f = setup(t);
  f.turn('завтра вечером');
  assert.equal(management(f).source, null);
  assert.equal(management(f).sourceWindow, undefined);
  assert.equal(management(f).initialWindow.kind, 'evening');
  assert.equal(f.result.dialogue.options.length, 4);
});
test('a cancellation bare-period correction selects a real source and renews consent', (t) => {
  const f = periodSetup(t);
  f.choose(1);
  const old = f.result.dialogue.options[0].id;
  f.turn('Нет, завтра утром');
  assert.equal(source(f)?.time, '08:30');
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.notEqual(f.result.dialogue.options[0].id, old);
  assert.equal(management(f).cancelConfirmed, undefined);
  assert.equal(f.result.action, null);
});
test('an invalid cancellation clock clears old consent and asks only for its clock', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  f.turn('Нет, завтра в 25:00');
  assert.equal(management(f).source, null);
  assert.equal(management(f).sourceDate, '2099-01-06');
  assert.equal(management(f).sourceTimeRequired, true);
  assert.equal(management(f).cancelConfirmation, undefined);
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /Во сколько/u);
});
function orders(values) {
  return values.length === 1
    ? [values]
    : values.flatMap((value, index) =>
        orders(values.filter((_, at) => at !== index)).map((tail) => [value, ...tail]),
      );
}
for (const parts of orders(['завтра', 'в 14:00', 'у Марии', 'на чистку']))
  for (const separator of [' ', ', '])
    test(
      'separate source date/clock/staff/service fields compose in any order: ' +
        parts.join(separator),
      (t) => {
        const f = setup(t, { intent: 'cancelAppointment' });
        f.turn(parts.join(separator));
        assert.equal(source(f)?.time, '14:00');
        assert.equal(source(f)?.date, '2099-01-06');
        assert.equal(source(f)?.staffId, 'staff-maria');
        assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
        assert.equal(f.result.action, null);
      },
    );
for (const label of ['сотрудник', 'специалист', 'врач', 'мастер'])
  test(
    'the existing staff-role alias remains composable with source date and time: ' + label,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.turn('завтра ' + label + ' Мария в 14:00 на чистку');
      assert.equal(source(f)?.staffId, 'staff-maria');
      assert.equal(source(f)?.time, '14:00');
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    },
  );
for (const text of [
  'не чистку, а на завтра в 12:00 на пилинг PRX',
  'Нет, не на чистку, а на пилинг PRX завтра в 12:00',
  'Нет, не чистку, а завтра на пилинг PRX в 12:00 у Тестовый Специалист',
])
  test('service replacement composes its independent new source date/time/staff: ' + text, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    f.turn(text);
    assert.equal(source(f)?.service, 'Пилинг PRX-T133');
    assert.equal(source(f)?.date, '2099-01-06');
    assert.equal(source(f)?.time, '12:00');
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.equal(management(f).cancelConfirmed, undefined);
    assert.equal(f.result.action, null);
  });
test('staff replacement composes its independent new source service and temporal filters', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(3);
  f.turn('Нет, не у Марии, а завтра в 12:00 у Тестовый Специалист на пилинг PRX');
  assert.equal(source(f)?.service, 'Пилинг PRX-T133');
  assert.equal(source(f)?.time, '12:00');
  assert.notEqual(source(f)?.staffId, 'staff-maria');
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(management(f).cancelConfirmed, undefined);
  assert.equal(f.result.action, null);
});
for (const text of ['Выбери другую запись', 'Покажи другую запись'])
  test('a complete other-source command returns fresh real choices: ' + text, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    f.turn(text);
    assert.equal(management(f).source, null);
    assert.equal(management(f).cancelConfirmation, undefined);
    assert.equal(f.result.dialogue.phase, 'appointmentChoice');
    assert.equal(f.result.dialogue.options.length, 4);
    assert.equal(f.result.action, null);
  });
