const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  clientChoiceOperation,
} = require('../src/server/modules/assistant/dialogue/client-choice-names.cjs');
const { acceptText } = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const empty = { client: null, staff: null, service: null, date: null, time: null, duration: null };
function prepare(f, text) {
  const body = {
    policyVersion: f.state.revision,
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    text,
  };
  return { body, snapshot: f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock) };
}
const entry = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
function pops() {
  const f = dialogueFixture();
  for (const [id, first, phone] of [
    ['elena', 'Елена', '+79990001020'],
    ['kate', 'Екатерина', '+79990001019'],
  ])
    f.patients.push({
      id,
      firstName: first,
      lastName: 'Попова',
      name: first + ' Попова',
      phone,
      createdBy: 'owner',
      appointments: [],
    });
  f.start(
    { query: 'Лариса Попова', serviceQuery: 'Чистка', date: day, time: '12:30' },
    { openWhenComplete: true },
  );
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.result.dialogue.options.length, 2);
  return f;
}
const noSave = (f) => assert.ok(f.patients.every((p) => p.appointments.length === 0));

test('a natural multi-statement entity answer reaches the model as one whole atomic update', () => {
  for (const text of [
    'Клиент — Анна Семёнова, возьмём миндальный пилинг. Дату поставь на сегодня, а время — двенадцать тридцать.',
    'Клиент Анна Семёнова, дата на сегодня, время — двенадцать тридцать, возьмём миндальный пилинг.',
  ]) {
    const f = dialogueFixture();
    f.services[0] = { id: 'almond', name: 'Миндальный пилинг', duration: 45, staffId: 'owner' };
    f.start({}, { openWhenComplete: true });
    const before = structuredClone(entry(f).data);
    const prepared = prepare(f, text);
    assert.ok(prepared.snapshot, 'Do not swallow every field into the local client value');
    assert.equal(prepared.snapshot.text, text);
    assert.deepEqual(entry(f).data, before, 'Classifying must not partially alter a field');
    const result = f.flow.applyModelTurn(
      f.c,
      prepared.body,
      f.state,
      f.member,
      f.clock,
      {
        operation: 'patch',
        fields: {
          ...empty,
          client: 'Анна Семёнова',
          service: 'миндальный пилинг',
          date: day,
          time: '12:30',
        },
        choice: null,
        field: null,
      },
      prepared.snapshot,
    );
    assert.equal(result.dialogue, null);
    assert.equal(result.action.patientId, f.patients[0].id);
    assert.deepEqual(result.action.serviceIds, ['almond']);
    assert.equal(result.action.date, day);
    assert.equal(result.action.time, '12:30');
    assert.equal(result.action.duration, 45);
    noSave(f);
  }
});

test('explicitly labelled separate name components choose only a matching current candidate and retain the whole draft', () => {
  for (const text of [
    'Имя я перепутал. Нужна Елена, фамилия Попова. Остальное оставь как было.',
    'Имя — Елена; фамилия: Попова.',
    'Фамилия Попова, имя Елена.',
  ]) {
    const f = pops();
    const before = structuredClone(entry(f).data);
    assert.equal(
      prepare(f, text).snapshot,
      null,
      'The current disclosed exact candidate can be chosen locally',
    );
    const result = f.answer({ text }).result;
    assert.equal(result.dialogue, null);
    assert.equal(result.action.patientId, 'elena');
    assert.equal(result.action.staffId, before.staff.id);
    assert.deepEqual(result.action.serviceIds, ['clean']);
    assert.equal(result.action.date, before.date);
    assert.equal(result.action.time, before.time);
    assert.equal(result.action.duration, before.duration);
    noSave(f);
  }
});

test('a labelled component choice cannot discard extra facts negation another identity or invented names', () => {
  for (const text of [
    'Имя Елена или Екатерина, фамилия Попова.',
    'Не нужна Елена, фамилия Попова.',
    'Имя Елена, фамилия Иванова.',
    'Имя Попова, фамилия Елена.',
    'Нужна Елена, фамилия Попова, время 14:00.',
    'ИмяЕлена, фамилияПопова.',
    'Имя Лариса, фамилия Попова.',
  ]) {
    const f = pops(),
      before = structuredClone(entry(f).data);
    assert.equal(clientChoiceOperation(f.c, entry(f), text), null, text);
    assert.deepEqual(entry(f).data, before);
    noSave(f);
  }
});

test('duplicate names and a stale or revoked current candidate never select a record', () => {
  {
    const f = pops();
    f.patients.push({ ...f.patients[1], id: 'elena-2', phone: '+79990001021' });
    f.changed();
    f.start({ query: 'Лариса Попова', serviceQuery: 'Чистка', date: day, time: '12:30' });
    const operation = clientChoiceOperation(f.c, entry(f), 'Имя Елена, фамилия Попова');
    assert.equal(operation.kind, 'localHelp');
    assert.equal(entry(f).data.patient, null);
    noSave(f);
  }
  for (const mutation of ['rename', 'remove', 'acl']) {
    const f = pops(),
      current = entry(f);
    if (mutation === 'rename') f.patients[1].lastName = 'Другая';
    else if (mutation === 'remove') f.patients.splice(1, 1);
    else {
      f.c.current.role = 'cosmetologist';
      f.c.current.accountId = 'restricted';
    }
    f.changed();
    const operation = clientChoiceOperation(f.c, current, 'Имя Елена, фамилия Попова');
    assert.equal(operation.kind, 'localHelp', mutation);
    assert.match(operation.text, /изменился/u);
    assert.equal(current.data.patient, null);
    if (mutation === 'acl')
      assert.throws(
        () => entry(f),
        (error) => error.status === 409,
      );
    noSave(f);
  }
});

test('a successfully supplied date clears the earlier past-date explanation', () => {
  const f = dialogueFixture(),
    data = { date: null, dateProposal: {}, dateRejection: 'past', roomId: 'old' };
  acceptText(data, 'date', 'сегодня', f.clock);
  assert.equal(data.date, day);
  assert.equal(data.dateRejection, undefined);
  assert.equal(data.dateProposal, undefined);
});

test('a procedural verb after the client clause is a boundary while an unfamiliar surname remains intact', () => {
  const { expandClientSource } = require('../src/server/modules/assistant/language/names/client-source-span.cjs');
  for (const verb of ['возьмём', 'возьми', 'выберем', 'поставь']) {
    const raw = 'Клиент Анна Семёнова, ' + verb + ' миндальный пилинг.';
    assert.equal(
      expandClientSource(raw, 'Анна Семёнова', { serviceQuery: 'миндальный пилинг' }),
      'Анна Семёнова',
      verb,
    );
  }
  assert.equal(
    expandClientSource('Запиши Анну Непривычнову на консультацию', 'Анну', {
      serviceQuery: 'консультацию',
    }),
    'Анну Непривычнову',
  );
});
