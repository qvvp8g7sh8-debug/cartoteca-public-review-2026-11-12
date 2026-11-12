const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-16', hour: 10, minute: 0 };
const select = (text) =>
  initialTemporalConstraints(
    { intent: 'prepareAppointment', date: '2026-10-25', time: '17:00' },
    text,
    clock,
  );

test('a leading preference does not disable trusted literal date and invalid-clock guards', () => {
  assert.deepEqual(select('Лучше запиши Анну завтра в 14:70.'), { date: '2026-10-17', time: null });
  assert.deepEqual(select('Лучше запиши Анну 18 октября в 14:30.'), {
    date: '2026-10-18',
    time: '14:30',
  });
});

test('a correction of service or staff preserves the original explicit temporal constraints', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее услуга первичная консультация.'), {
    date: '2026-10-17',
    time: '14:30',
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:70, лучше к Ирине Орловой.'), {
    date: '2026-10-17',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну 31 ноября в 14:30, точнее услуга чистка.'), {
    date: null,
    time: '14:30',
  });
});

test('a final exact clock correction replaces only the earlier clock and retains its date', () => {
  assert.deepEqual(select('Запиши Анну 17 октября 2026 в 14:30, нет, лучше в 15:00.'), {
    date: '2026-10-17',
    time: '15:00',
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее в шесть часов вечера.'), {
    date: '2026-10-17',
    time: '18:00',
  });
});

test('a final exact date correction replaces only the earlier date and retains its clock', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30, нет, на 18 октября.'), {
    date: '2026-10-18',
    time: '14:30',
  });
  assert.deepEqual(select('Запиши Анну 18 октября в 14:30, точнее 19 октября.'), {
    date: '2026-10-19',
    time: '14:30',
  });
});

test('a duration correction cannot retract an unrelated exact clock or date', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30 на 30 минут, точнее на 45 минут.'), {
    date: '2026-10-17',
    time: '14:30',
  });
});

test('an uncertain or negative final clock correction cannot preserve the retracted exact clock', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее примерно в 15:00.'), {
    date: '2026-10-17',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее не в 15:00.'), {
    date: '2026-10-17',
    time: null,
  });
});

test('unsupported relative field corrections require clarification rather than restoring the old field', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее на полчаса позже.'), {
    date: '2026-10-17',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее на следующий день.'), {
    date: null,
    time: '14:30',
  });
});

test('the real exact correction control reaches the corrected review and never saves', () => {
  const f = dialogueFixture();
  const text = 'Запиши Анну 5 января 2099 в 14:30, нет, лучше в 15:00.';
  const constraints = initialTemporalConstraints({ intent: 'prepareAppointment' }, text, f.clock);
  const ticket = f.flow.beginCommand(f.c, f.member, f.state);
  const result = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      serviceQuery: 'Чистка',
      date: day,
      time: '15:00',
    },
    f.state,
    f.member,
    f.clock,
    ticket,
    constraints,
  );
  assert.equal(result.dialogue.step, 'review');
  assert.equal(result.dialogue.fields.find((row) => row.key === 'time').value, '15:00');
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('unsupported spoken relative date corrections retract the old date without inventing one', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее через два дня.'), {
    date: null,
    time: '14:30',
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее через две недели.'), {
    date: null,
    time: '14:30',
  });
});

test('a short final numeric date remains ambiguous instead of preserving the retracted date', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее 18.10.'), { date: null, time: null });
});

test('a bare final clock correction preserves one exact hour but never restores a retracted invalid clock', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее 15.'), {
    date: '2026-10-17',
    time: '15:00',
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30, точнее 30.'), {
    date: '2026-10-17',
    time: null,
  });
});

test('a final exact correction retracts only its earlier temporal bound', () => {
  assert.deepEqual(select('Запиши Анну завтра после 14:30, нет, в 15:00.'), {
    date: '2026-10-17',
    time: '15:00',
  });
  assert.deepEqual(select('Запиши Анну после 18 октября, точнее 19 октября в 14:30.'), {
    date: '2026-10-19',
    time: '14:30',
  });
});

test('a correction of another field never retracts an unresolved temporal bound', () => {
  assert.throws(() => select('Запиши Анну завтра после 14:30, точнее услуга чистка.'), {
    status: 400,
  });
  assert.throws(() => select('Запиши Анну завтра в 14:30, точнее после 15:00.'), { status: 400 });
});

test('a dotted date bound is never mistaken for a second clock bound during a date correction', () => {
  assert.deepEqual(select('Запиши Анну после 18.10.2026, точнее 19.10.2026 в 14:30.'), {
    date: '2026-10-19',
    time: '14:30',
  });
  assert.deepEqual(select('Запиши Анну после 18.10.2026, точнее 19.10.2026.'), {
    date: '2026-10-19',
  });
});

test('comparative relative clock corrections retract the old clock and preserve date and duration context', () => {
  for (const shift of ['позднее', 'ранее'])
    assert.deepEqual(
      select('Запиши Анну завтра в 14:30 на 60 минут, точнее на 15 минут ' + shift + '.'),
      { date: '2026-10-17', time: null },
      shift,
    );
});
