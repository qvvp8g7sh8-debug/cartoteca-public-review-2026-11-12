const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const emptyFields = {
  client: null,
  staff: null,
  service: null,
  date: null,
  time: null,
  duration: null,
};
const proposal = (fields) => ({
  operation: 'patch',
  fields: { ...emptyFields, ...fields },
  choice: null,
  field: null,
});
function modelOrLocal(f, first, text, fields) {
  const body = { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  return snapshot
    ? f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, proposal(fields), snapshot)
    : f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
}
const forms = {
  client: [
    'Клиент тот же',
    'Клиента того же',
    'Клиента оставь того же',
    'Клиентку ту же',
    'Оставь клиента прежним',
    'Не меняй клиента',
  ],
  staff: [
    'Сотрудник тот же',
    'Сотрудника того же',
    'Специалиста оставь того же',
    'Оставь сотрудника того же',
    'Не меняй сотрудника',
  ],
  service: [
    'Услуга та же',
    'Услугу ту же',
    'Процедуру оставь ту же',
    'Оставь услугу прежней',
    'Не меняй услугу',
  ],
  date: [
    'Дата та же',
    'Дату ту же',
    'День тот же',
    'Дату оставь ту же',
    'Не меняй дату',
    'Дату менять не надо',
  ],
  time: ['Время то же', 'Время оставь то же', 'Время не меняй', 'Не меняй время'],
  duration: [
    'Длительность та же',
    'Продолжительность ту же',
    'Длительность оставь той же',
    'Длительность оставь прежней',
    'Продолжительность менять не надо',
  ],
};
for (const [field, clauses] of Object.entries(forms))
  for (const clause of clauses)
    test('known ' + field + ' is preserved through its explicit role form: ' + clause, () => {
      const f = dialogueFixture();
      const initial = {
        query: 'Анна Семёнова',
        serviceQuery: 'Чистка',
        duration: 45,
        ...(field === 'date' ? { date: day } : field === 'time' ? { time: '16:00' } : {}),
      };
      const first = f.start(initial, { openWhenComplete: true });
      const raw =
        clause +
        (field === 'date' ? ', в 16:00' : field === 'time' ? ', сегодня' : ', сегодня в 16:00');
      const fields =
        field === 'date'
          ? { time: '16:00' }
          : field === 'time'
            ? { date: day }
            : { date: day, time: '16:00' };
      const before = JSON.stringify(f.patients),
        result = modelOrLocal(f, first, raw, fields);
      assert.equal(result.action?.type, 'prepareAppointment', JSON.stringify(result));
      assert.equal(result.action.patientId, f.patients[0].id);
      assert.equal(result.action.staffId, 'owner');
      assert.deepEqual(result.action.serviceIds, ['clean']);
      assert.equal(result.action.date, day);
      assert.equal(result.action.time, '16:00');
      assert.equal(result.action.duration, 45);
      assert.equal(JSON.stringify(f.patients), before);
    });
for (const [field, clause] of Object.entries({
  client: 'Клиент тот же',
  staff: 'Сотрудник тот же',
  service: 'Услуга та же',
  date: 'Дата та же',
  time: 'Время то же',
  duration: 'Длительность та же',
}))
  test('preserving a missing ' + field + ' never invents a value', () => {
    const f = dialogueFixture();
    if (field === 'staff') {
      f.members.push({
        accountId: 'maria',
        displayName: 'Мария Иванова',
        role: 'cosmetologist',
        status: 'active',
      });
      f.services.push({ id: 'maria-clean', name: 'Чистка', duration: 30, staffId: 'maria' });
    }
    const intent = { query: 'Анна Семёнова', serviceQuery: 'Чистка', date: day, time: '16:00' };
    if (field === 'client') delete intent.query;
    if (field === 'staff') intent.staffQuery = 'Несуществующий';
    if (field === 'service') delete intent.serviceQuery;
    if (field === 'date') delete intent.date;
    if (field === 'time') delete intent.time;
    const constraints = {
      openWhenComplete: true,
      ...(field === 'duration' ? { requireDuration: true } : {}),
    };
    const first = f.start(intent, constraints);
    const raw =
      clause +
      (field === 'date' ? ', в 16:00' : field === 'time' ? ', сегодня' : ', сегодня в 16:00');
    const fields =
      field === 'date'
        ? { time: '16:00' }
        : field === 'time'
          ? { date: day }
          : { date: day, time: '16:00' };
    const result = modelOrLocal(f, first, raw, fields),
      data = f.flow.get(f.c, f.member, f.state, first.dialogue.id).data;
    assert.equal(result.action, null);
    assert.equal(result.dialogue.step, field);
    if (field === 'client') assert.equal(data.patient, null);
    if (field === 'staff') assert.equal(data.staff, null);
    if (field === 'service') assert.equal(data.service, null);
    if (field === 'date') assert.equal(data.date, null);
    if (field === 'time') assert.equal(data.time, null);
    if (field === 'duration') assert.equal(data.durationSource, 'required');
  });
for (const old of [false, true])
  for (const omitted of ['date', 'time', 'duration'])
    test(
      'server temporal proof supplies the spoken ' +
        omitted +
        ' even when its model patch omits it; old=' +
        old,
      () => {
        const f = dialogueFixture();
        const initial = {
          query: 'Анна Семёнова',
          serviceQuery: 'Чистка',
          ...(old ? { date: '2099-01-07', time: '15:00', duration: 30 } : {}),
        };
        const first = f.start(initial, old ? {} : { openWhenComplete: true });
        const raw = 'Я бы хотел на сегодня в 16:00 длительностью 45 минут';
        const values = { date: day, time: '16:00', duration: 45 };
        values[omitted] = null;
        const result = modelOrLocal(f, first, raw, values),
          data = f.flow.get(f.c, f.member, f.state, first.dialogue.id).data;
        assert.equal(data.date, day);
        assert.equal(data.time, '16:00');
        assert.equal(data.duration, 45);
        if (result.action) {
          assert.equal(result.action.date, day);
          assert.equal(result.action.time, '16:00');
          assert.equal(result.action.duration, 45);
        }
      },
    );
for (const [raw, fields, missing] of [
  ['Я бы хотел на сегодня в 25:00', { date: day }, 'time'],
  ['Я бы хотел на 31 февраля в 16:00', { time: '16:00' }, 'date'],
  ['Я бы хотел на сегодня в 16:00 длительностью 7 минут', { date: day, time: '16:00' }, 'duration'],
])
  test(
    'a partial model patch never reuses the previous ' +
      missing +
      ' after an explicit invalid replacement',
    () => {
      const f = dialogueFixture();
      const first = f.start({
        query: 'Анна Семёнова',
        serviceQuery: 'Чистка',
        date: '2099-01-07',
        time: '15:00',
        duration: 30,
      });
      const result = modelOrLocal(f, first, raw, fields),
        data = f.flow.get(f.c, f.member, f.state, first.dialogue.id).data;
      assert.equal(result.action, null);
      assert.equal(result.dialogue.step, missing);
      if (missing === 'date') assert.equal(data.date, null);
      if (missing === 'time') assert.equal(data.time, null);
      if (missing === 'duration') assert.equal(data.durationSource, 'required');
    },
  );
