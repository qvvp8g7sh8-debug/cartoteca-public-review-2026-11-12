const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managementCycleFixture: setup,
} = require('./helpers/assistant-management-cycle-fixture.cjs');
const m = (f) => f.entry().data.management;
const source = (f) =>
  f.storage
    .read()
    .patients.flatMap((p) => p.appointments)
    .find((a) => a.id === m(f).source?.appointmentId);
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
function boundChoiceFixture() {
  const f = dialogueFixture({ ambiguous: true });
  f.services.push({ id: 'massage', name: 'Массаж', duration: 60, staffId: 'owner' });
  f.c.platform.workSchedules.view = () => ({
    days: {
      [day]: { status: 'working', intervals: [['09:00', '18:00']] },
      '2099-01-06': { status: 'working', intervals: [['09:00', '18:00']] },
    },
    closures: {},
  });
  const first = f.start(
    { query: 'Семёнова', serviceQuery: 'Чистка', date: day, time: '15:00' },
    { openWhenComplete: true },
  );
  const id = first.dialogue.id;
  return {
    ...f,
    first,
    entry: () => f.flow.get(f.c, f.member, f.state, id),
    model(text, fields) {
      const body = {
        dialogueId: id,
        dialogueVersion: f.flow.get(f.c, f.member, f.state, id).version,
        text,
      };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      assert.ok(snapshot, 'service extraction must remain a guarded model turn');
      const proposal = {
        operation: 'patch',
        fields: {
          client: null,
          staff: null,
          service: null,
          date: null,
          time: null,
          duration: null,
          ...fields,
        },
        choice: null,
        field: null,
      };
      return {
        result: f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, proposal, snapshot),
        body,
        snapshot,
      };
    },
  };
}
for (const raw of [
  'Вторую на массаж завтра в 16:00',
  'На массаж завтра в 16:00 вторую',
  'Второго клиента на массаж завтра в 16:00',
])
  test(
    'independent bound choice and explicit service/date/time preserve the remaining draft: ' + raw,
    () => {
      const f = boundChoiceFixture(),
        before = JSON.stringify(f.patients);
      const { result, body, snapshot } = f.model(raw, {
        service: 'массаж',
        date: '2099-01-06',
        time: '16:00',
      });
      assert.equal(result.action?.type, 'prepareAppointment');
      assert.equal(result.action.patientId, f.patients[1].id);
      assert.equal(result.action.staffId, 'owner');
      assert.deepEqual(result.action.serviceIds, ['massage']);
      assert.equal(result.action.duration, 60);
      assert.equal(result.action.date, '2099-01-06');
      assert.equal(result.action.time, '16:00');
      assert.deepEqual(snapshot.context.selectionApplied, { field: 'client' });
      const wire = JSON.stringify(snapshot.context);
      for (const patient of f.patients) {
        assert.equal(wire.includes(patient.id), false);
        assert.equal(wire.includes(patient.phone), false);
      }
      assert.equal(JSON.stringify(f.patients), before);
      const replay = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
      assert.deepEqual(replay.action, result.action);
    },
  );
for (const raw of [
  'Вторую на массаж завтра в 16:00',
  'На массаж завтра в 16:00 вторую',
  'Второго клиента на массаж завтра в 16:00',
])
  test(
    'a missing unlabelled service in the bound-choice model reply cannot reuse the old service: ' +
      raw,
    () => {
      const f = boundChoiceFixture(),
        before = JSON.stringify(f.patients);
      const { result } = f.model(raw, { date: '2099-01-06', time: '16:00' });
      assert.equal(result.action, null);
      assert.equal(result.dialogue.step, 'service');
      assert.equal(f.entry().data.patient.id, f.patients[1].id);
      assert.equal(f.entry().data.staff.id, 'owner');
      assert.equal(f.entry().data.service, null);
      assert.equal(f.entry().data.date, '2099-01-06');
      assert.equal(f.entry().data.time, '16:00');
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        text: 'Массаж',
      };
      const completed = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
      assert.equal(completed.action?.type, 'prepareAppointment');
      assert.equal(completed.action.patientId, f.patients[1].id);
      assert.deepEqual(completed.action.serviceIds, ['massage']);
      assert.equal(completed.action.date, '2099-01-06');
      assert.equal(completed.action.time, '16:00');
      assert.equal(completed.action.duration, 60);
      assert.equal(JSON.stringify(f.patients), before);
    },
  );
for (const [raw, extra] of [
  ['Вторую на массаж завтра в 16:00 и отмени запись', {}],
  ['Вторую на массаж завтра в 16:00 если будет свободно', {}],
  ['Вторую на массаж завтра в 16:00', { client: 'Анна' }],
])
  test(
    'independent guarded composition retains no partial choice after an unsafe or invented field: ' +
      raw +
      JSON.stringify(extra),
    () => {
      const f = boundChoiceFixture(),
        before = structuredClone(f.entry().data),
        patients = JSON.stringify(f.patients);
      const { result } = f.model(raw, {
        service: 'массаж',
        date: '2099-01-06',
        time: '16:00',
        ...extra,
      });
      assert.equal(result.action, null);
      for (const field of ['patient', 'staff', 'service', 'date', 'time', 'duration'])
        assert.deepEqual(f.entry().data[field], before[field], field);
      assert.equal(JSON.stringify(f.patients), patients);
    },
  );
test('a negated ordinal never binds the person even if the model proposes other valid fields', () => {
  const f = boundChoiceFixture(),
    before = JSON.stringify(f.patients);
  const { result } = f.model('Не вторую на массаж завтра в 16:00', {
    service: 'массаж',
    date: '2099-01-06',
    time: '16:00',
  });
  assert.equal(result.action, null);
  assert.equal(f.entry().data.patient, null);
  assert.equal(JSON.stringify(f.patients), before);
});
for (const [text, expected] of [
  ['Нет, у Марии', { staffId: 'staff-maria', time: '14:00' }],
  ['Нет, завтра у Марии', { staffId: 'staff-maria', time: '14:00' }],
  ['Не у Тестовый Специалист, а у Марии', { staffId: 'staff-maria', time: '14:00' }],
  ['Нет, на пилинг PRX', { service: 'Пилинг PRX-T133', time: '12:00' }],
  ['Не чистку, а пилинг PRX', { service: 'Пилинг PRX-T133', time: '12:00' }],
])
  test(
    'selected move can correct its actual source while preserving its independent goal: ' + text,
    (t) => {
      const f = setup(t, { date: '2099-01-07', time: '16:00' });
      f.choose(1);
      const oldSource = m(f).source.appointmentId,
        rows = JSON.stringify(f.storage.read());
      f.turn(text);
      assert.notEqual(m(f).source?.appointmentId, oldSource);
      assert.ok(source(f));
      for (const [key, value] of Object.entries(expected)) assert.equal(source(f)[key], value);
      assert.equal(m(f).targetDate, '2099-01-07');
      assert.equal(m(f).targetTime, '16:00');
      assert.equal(f.result.action, null);
      assert.equal(m(f).movePreparation, undefined);
      assert.equal(JSON.stringify(f.storage.read()), rows);
      assert.equal(f.calls(), 0);
    },
  );
for (const text of [
  'Нет, эту запись не отменяй',
  'Не отменяй эту запись',
  'Не надо отменять эту запись',
  'Эту запись оставь',
])
  test(
    'explicit denial stops cancellation instead of retaining its affirmative question: ' + text,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.choose(1);
      const rows = JSON.stringify(f.storage.read());
      f.turn(text);
      assert.equal(f.result.action, null);
      assert.equal(f.result.dialogue, null);
      assert.equal(f.entry().cancelled, true);
      assert.equal(JSON.stringify(f.storage.read()), rows);
      assert.equal(f.calls(), 0);
    },
  );
for (const [text, field] of [
  ['Клиента поменяй на Ольгу Семёнову на сегодня в 16:00', 'client'],
  ['На сегодня в 16:00 клиента поменяй на Ольгу Семёнову', 'client'],
  ['Клиент Ольга Семёнова, сегодня в 16:00', 'client'],
  ['Сегодня в 16:00 услуга массаж', 'service'],
])
  test('model omission of a spoken entity cannot complete the previous draft: ' + text, () => {
    const f = dialogueFixture({ ambiguous: true });
    f.services.push({ id: 'massage', name: 'Массаж', duration: 60, staffId: 'owner' });
    const first = f.start(
      { query: 'Анна Семёнова', serviceQuery: 'Чистка' },
      { openWhenComplete: true },
    );
    const body = { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text };
    const before = JSON.stringify(f.patients);
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    const proposal = {
      operation: 'patch',
      fields: {
        client: null,
        staff: null,
        service: null,
        date: day,
        time: '16:00',
        duration: null,
      },
      choice: null,
      field: null,
    };
    const result = snapshot
      ? f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, proposal, snapshot)
      : f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    if (result.action) {
      if (field === 'client') assert.equal(result.action.patientId, f.patients[1].id);
      else assert.deepEqual(result.action.serviceIds, ['massage']);
    } else {
      assert.ok(result.dialogue);
      assert.equal(result.dialogue.step, field);
    }
    assert.equal(JSON.stringify(f.patients), before);
  });
for (const intent of ['moveAppointment', 'cancelAppointment'])
  test(intent + ' accepts explicit reselection rather than retaining its old source', (t) => {
    const f = setup(t, {
      intent,
      ...(intent === 'moveAppointment' ? { date: '2099-01-07', time: '16:00' } : {}),
    });
    f.choose(1);
    const old = f.result.dialogue.options[0]?.id,
      rows = JSON.stringify(f.storage.read());
    f.turn('Выбери другую запись');
    assert.equal(m(f).source, null);
    assert.equal(m(f).cancelConfirmation, undefined);
    assert.equal(m(f).movePreparation, undefined);
    assert.equal(f.result.dialogue.phase, 'appointmentChoice');
    assert.ok(f.result.dialogue.options.length > 1);
    if (intent === 'moveAppointment') {
      assert.equal(m(f).initialDate, '2099-01-07');
      assert.equal(m(f).initialTime, '16:00');
    }
    if (old) assert.throws(() => f.answer({ choice: old }), { status: 409 });
    assert.equal(JSON.stringify(f.storage.read()), rows);
    assert.equal(f.calls(), 0);
  });
for (const intent of ['editAppointment', 'cancelAppointment'])
  for (const text of [
    'завтра, на чистку, у Марии',
    'у Марии, завтра, на чистку',
    'на чистку, у Марии, завтра',
  ])
    test(intent + ' does not let ASR commas hide atomic source fields: ' + text, (t) => {
      const f = setup(t, { intent });
      const rows = JSON.stringify(f.storage.read());
      f.turn(text);
      assert.equal(source(f)?.staffId, 'staff-maria');
      assert.equal(source(f)?.time, '14:00');
      assert.equal(source(f)?.service, 'Чистка');
      assert.equal(source(f)?.date, '2099-01-06');
      if (intent === 'cancelAppointment') {
        assert.equal(f.result.action, null);
        assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
        assert.equal(m(f).cancelConfirmed, undefined);
      } else {
        assert.equal(f.result.action?.type, 'appointmentPreview');
        assert.equal(f.result.action.operation, 'edit');
      }
      assert.equal(JSON.stringify(f.storage.read()), rows);
      assert.equal(f.calls(), 0);
    });

for (const edits of [
  ['В 17:00', 'В 25:00', 'В шестнадцать тридцать'],
  ['Перенеси запись на 8 января в 17:00', 'В 25:00', 'В шестнадцать тридцать'],
  ['Не в 16:00, а в 17:00', 'Нет, в 25:00', 'В шестнадцать тридцать'],
])
  test(
    'three successive corrections retain the last whole clock and its independent date: ' +
      edits.join(' → '),
    (t) => {
      const f = setup(t, { date: '2099-01-07', time: '16:00' });
      f.choose(1);
      const rows = JSON.stringify(f.storage.read());
      for (const raw of edits) f.turn(raw);
      assert.equal(m(f).targetTime, '16:30');
      assert.equal(m(f).targetDate, edits[0].includes('8 января') ? '2099-01-08' : '2099-01-07');
      if (f.result.dialogue?.phase === 'closedDay') f.turn('да');
      assert.equal(f.result.action?.type, 'appointmentPreview');
      assert.equal(f.result.action.time, '16:30');
      assert.equal(JSON.stringify(f.storage.read()), rows);
      assert.equal(f.calls(), 0);
    },
  );
test('three source-role corrections on a move keep the independent target and invalidate every old confirmation', (t) => {
  const f = setup(t, { date: '2099-01-07', time: '16:00' });
  f.choose(1);
  const rows = JSON.stringify(f.storage.read());
  for (const [raw, time] of [
    ['Нет, на пилинг PRX', '12:00'],
    ['Нет, завтра на чистку у Марии', '14:00'],
    ['Нет, сегодня на чистку у Тестовый Специалист', '10:00'],
  ]) {
    const old = f.result.dialogue.options[0].id;
    f.turn(raw);
    assert.equal(source(f)?.time, time, raw);
    assert.equal(m(f).targetDate, '2099-01-07');
    assert.equal(m(f).targetTime, '16:00');
    assert.throws(() => f.answer({ choice: old }), { status: 409 });
  }
  f.turn('да');
  assert.equal(f.result.action?.type, 'appointmentPreview');
  assert.equal(f.result.action.date, '2099-01-07');
  assert.equal(f.result.action.time, '16:00');
  assert.equal(JSON.stringify(f.storage.read()), rows);
  assert.equal(f.calls(), 0);
});
test('three cancellation source corrections bind the only fresh confirmation to their final real source', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const rows = JSON.stringify(f.storage.read());
  for (const [raw, time] of [
    ['Нет, на пилинг PRX', '12:00'],
    ['Нет, завтра на чистку у Марии', '14:00'],
    ['Нет, сегодня на чистку у Тестовый Специалист', '10:00'],
  ]) {
    const old = f.result.dialogue.options[0].id;
    f.turn(raw);
    assert.equal(source(f)?.time, time, raw);
    assert.equal(m(f).cancelConfirmed, undefined);
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.throws(() => f.answer({ choice: old }), { status: 409 });
  }
  f.turn('да');
  assert.equal(f.result.action?.operation, 'cancel');
  assert.equal(JSON.stringify(f.storage.read()), rows);
  assert.equal(f.calls(), 0);
});
test('a missing cancellation source drops old consent and permits a subsequent proven client correction', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const old = f.result.dialogue.options[0].id;
  const rows = JSON.stringify(f.storage.read());
  f.turn('Нет, у Несуществующего');
  assert.equal(m(f).source, null);
  assert.equal(m(f).cancelConfirmation, undefined);
  assert.throws(() => f.answer({ choice: old }), { status: 409 });
  f.turn('Клиента поменяй на Ольгу Семёнову');
  assert.match(f.entry().data.patient.label, /Ольга/u);
  assert.equal(source(f)?.time, '17:00');
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
  assert.equal(JSON.stringify(f.storage.read()), rows);
  assert.equal(f.calls(), 0);
});
for (const dimension of ['revision', 'role', 'choice'])
  test('a pending model turn cannot cross a changed ' + dimension, () => {
    const f = dialogueFixture({ ambiguous: true });
    const first = f.start({ query: 'Семёнова', serviceQuery: 'Чистка' });
    const body = {
      dialogueId: first.dialogue.id,
      dialogueVersion: first.dialogue.version,
      text: 'Клиент Ольга Семёнова, сегодня в 16:00',
    };
    const snap = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    assert.ok(snap);
    if (dimension === 'revision') f.state.revision++;
    if (dimension === 'role') f.c.current.role = 'cosmetologist';
    if (dimension === 'choice')
      f.flow.get(f.c, f.member, f.state, first.dialogue.id).options.clear();
    const proposed = {
      operation: 'patch',
      fields: {
        client: 'Ольга Семёнова',
        staff: null,
        service: null,
        date: day,
        time: '16:00',
        duration: null,
      },
      choice: null,
      field: null,
    };
    assert.throws(
      () => f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, proposed, snap),
      { status: 409 },
    );
    assert.ok(f.patients.every((p) => p.appointments.length === 0));
  });
