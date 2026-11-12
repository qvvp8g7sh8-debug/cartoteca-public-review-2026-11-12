const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const clock = { date: '2026-10-16', hour: 10, minute: 0 };
const select = (text, intent = { intent: 'prepareAppointment' }, at = clock) =>
  require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs').initialTemporalConstraints(
    intent,
    text,
    at,
  );

test('weekday clarification only applies to an unqualified booking day matching the civil date', () => {
  const at = { date: '2026-11-11', hour: 10, minute: 0 };
  const prove = (text) =>
    bookingTemporalConstraints({ intent: 'prepareAppointment' }, text, at, {
      clarifyWeekday: true,
    });
  assert.deepEqual(prove('Запиши на среду в 11:00'), {
    date: null,
    dateWeekday: at.date,
    time: '11:00',
  });
  for (const [text, date] of [
    ['Запиши на сегодня', at.date],
    ['Запиши на эту среду', at.date],
    ['Запиши в среду на этой неделе', at.date],
    ['Запиши в среду 11 ноября', at.date],
    ['Запиши на следующую среду', '2026-11-18'],
    ['Запиши на пятницу', '2026-11-13'],
    ['Запиши на среду, точнее на пятницу', '2026-11-13'],
  ])
    assert.deepEqual(prove(text), { date }, text);
});

test('trusted literal date and clock replace omitted or substituted model values without saving', () => {
  assert.deepEqual(select('Запиши Анну 18 октября 2026 года в 14:30.'), {
    date: '2026-10-18',
    time: '14:30',
  });
  const f = dialogueFixture();
  const constraints = select('Запиши Анну 5 января 2099 года в 14:30.', undefined, f.clock);
  const result = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      serviceQuery: 'Чистка',
      date: '2099-01-06',
      time: '16:00',
    },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    constraints,
  );
  assert.equal(result.dialogue.step, 'review');
  assert.equal(result.dialogue.fields.find((row) => row.key === 'date').value, day);
  assert.equal(result.dialogue.fields.find((row) => row.key === 'time').value, '14:30');
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('spoken ordinal dates and complete meridiem clocks stay faithful to the organization year', () => {
  assert.deepEqual(select('Запиши Анну восемнадцатого октября в три часа дня.'), {
    date: '2026-10-18',
    time: '15:00',
  });
  assert.deepEqual(select('Запиши Анну на семнадцатое октября в девять утра.'), {
    date: '2026-10-17',
    time: '09:00',
  });
});

test('an exact relative date supplies no invented clock and respects year rollover', () => {
  assert.deepEqual(select('Запиши Анну на завтра.'), { date: '2026-10-17' });
  assert.deepEqual(
    select('Запиши Анну завтра.', undefined, { date: '2026-12-31', hour: 10, minute: 0 }),
    { date: '2027-01-01' },
  );
});

test('an explicit duration or service number cannot become an appointment clock', () => {
  assert.deepEqual(select('Запиши Анну 18 октября на тридцать минут.'), { date: '2026-10-18' });
  assert.deepEqual(select('Запиши Анну на услугу Уход 30 на завтра.'), { date: '2026-10-17' });
});

test('ISO and dotted dates keep exact token boundaries and are not parsed as clocks', () => {
  for (const text of ['Запиши Анну на 2026-10-18 в 16:00.', 'Запиши Анну на 18.10.2026 в 16:00.'])
    assert.deepEqual(select(text), { date: '2026-10-18', time: '16:00' });
  assert.deepEqual(select('Запиши Анну на 18.10.2026.'), { date: '2026-10-18' });
});

test('a past yearless or impossible date clears a model replacement instead of rolling forward', () => {
  assert.deepEqual(select('Запиши Анну 15 октября в 14:30.'), { date: null, time: '14:30' });
  assert.deepEqual(select('Запиши Анну 31 ноября 2026 года в 14:30.'), {
    date: null,
    time: '14:30',
  });
});

test('a lower clock bound never becomes an exact clock or an unbounded slot search', () => {
  assert.throws(() => select('Запиши Анну завтра после 14:30.'), { status: 400 });
  assert.throws(() => select('Запиши Анну завтра не раньше 14:30.'), { status: 400 });
  assert.throws(() => select('Запиши Анну не раньше чем 14:30.'), { status: 400 });
});

test('an upper clock bound never becomes an exact appointment start', () => {
  assert.throws(() => select('Запиши Анну завтра до 14:30.'), { status: 400 });
  assert.throws(() => select('Запиши Анну завтра не позже 14:30.'), { status: 400 });
  assert.throws(() => select('Запиши Анну не позже чем 14:30.'), { status: 400 });
});

test('a time range requires clarification without selecting either endpoint', () => {
  assert.throws(() => select('Запиши Анну завтра с 14:00 до 16:00.'), { status: 400 });
  assert.throws(() => select('Запиши Анну завтра между 14:00 и 16:00.'), { status: 400 });
});

test('a date range requires clarification rather than an arbitrary first or last day', () => {
  assert.throws(() => select('Запиши Анну с 18 октября по 20 октября.'), { status: 400 });
  assert.throws(() => select('Запиши Анну после 18 октября.'), { status: 400 });
});

test('date alternatives and conflicting relative context clear an unsupported model date', () => {
  assert.deepEqual(select('Запиши Анну 18 или 19 октября.'), { date: null });
  assert.deepEqual(select('Запиши Анну завтра в воскресенье.'), { date: null });
});

test('an exact final date correction and the next future weekday remain trusted while past weekdays ask again', () => {
  assert.deepEqual(select('Запиши Анну 18 октября, точнее 19 октября.'), { date: '2026-10-19' });
  assert.deepEqual(select('Запиши Анну в следующую пятницу.'), { date: '2026-10-23' });
  assert.deepEqual(select('Запиши Анну в прошлую пятницу.'), { date: null });
});

test('a lower hour defaults to daytime while retaining the exact date and explicit meridiem', () => {
  assert.deepEqual(select('Запиши Анну завтра в три.'), { date: '2026-10-17', time: '15:00' });
  assert.deepEqual(select('Запиши Анну завтра в 3 часа дня.'), {
    date: '2026-10-17',
    time: '15:00',
  });
});

test('anchored comma clocks preserve one exact repeat and reject conflicting repeats or meridiem', () => {
  for (const text of ['Запиши Анну завтра в 14, 30.', 'Запиши Анну завтра в 14, 30, 14, 30.'])
    assert.deepEqual(select(text), { date: '2026-10-17', time: '14:30' });
  assert.deepEqual(select('Запиши Анну завтра в 14, 30, 15, 30.'), {
    date: '2026-10-17',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30 утра.'), { date: '2026-10-17', time: null });
});

test('invalid clocks and uncertain clauses fail closed while absent signals and other intents stay unchanged', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:70.'), { date: '2026-10-17', time: null });
  assert.deepEqual(select('Запиши Анну завтра примерно в 14:30.'), {
    date: '2026-10-17',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну.'), {});
  assert.deepEqual(select('Запиши Анну на первичную консультацию.'), {});
  assert.deepEqual(select('Покажи календарь 18 октября в 14:30.', { intent: 'calendar' }), {});
  assert.deepEqual(select('Найди окно завтра после 14:30.', { intent: 'availability' }), {});
});

test('a service title containing after does not turn an unrelated exact appointment into a time bound', () => {
  assert.deepEqual(select('Запиши Анну на услугу Уход после пилинга завтра в 14:30.'), {
    date: '2026-10-17',
    time: '14:30',
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30 на услугу Уход после пилинга.'), {
    date: '2026-10-17',
    time: '14:30',
  });
});

test('after an unrelated activity does not make an explicitly stated clock a lower bound', () => {
  assert.deepEqual(select('После процедуры запиши Анну завтра в 14:30.'), {
    date: '2026-10-17',
    time: '14:30',
  });
  assert.deepEqual(select('Запиши Анну завтра в 14:30, после консультации согласуем детали.'), {
    date: '2026-10-17',
    time: '14:30',
  });
});

test('a known actual correction utterance retains its corrected date and clock', () => {
  const intent = { intent: 'prepareAppointment', date: '2026-10-17', time: '15:00' };
  for (const text of [
    'Запиши Анну 17 октября 2026 в 14:30, нет, лучше в 15:00.',
    'Запиши Анну завтра в 14:30, точнее в 15:00.',
  ])
    assert.deepEqual(select(text, intent), { date: '2026-10-17', time: '15:00' });
});

test('an attached invalid clock qualifier is not silently discarded by a numeric clock prefix', () => {
  assert.deepEqual(select('Запиши Анну завтра в 14:30утра.'), { date: '2026-10-17', time: null });
});

test('a duration before a meridiem clock cannot borrow the later qualifier and become a second time', () => {
  assert.deepEqual(select('Запиши Анну на тридцать минут завтра в шесть часов вечера.'), {
    date: '2026-10-17',
    time: '18:00',
  });
  assert.deepEqual(select('Запиши Анну на 30 минут завтра в 6 часов вечера.'), {
    date: '2026-10-17',
    time: '18:00',
  });
});

test('a following in-clock clause cannot donate its qualifier to an immediately preceding duration', () => {
  assert.deepEqual(select('Запиши Анну завтра на тридцать минут в девять утра.'), {
    date: '2026-10-17',
    time: '09:00',
  });
  assert.deepEqual(select('Запиши Анну завтра на 30 минут в 9 утра.'), {
    date: '2026-10-17',
    time: '09:00',
  });
});

test('maximal spoken-clock parsing cannot truncate invalid hours or unsupported seconds into a valid shorter clock', () => {
  assert.deepEqual(select('Запиши Анну завтра в двадцать четыре часа.'), {
    date: '2026-10-17',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну завтра в четырнадцать часов пятнадцать секунд.'), {
    date: '2026-10-17',
    time: null,
  });
});

test('a short dotted date after on is ambiguous rather than an invented exact clock', () => {
  for (const text of ['Запиши Анну на 17.10.', 'Запиши Анну на17.10.', 'Запиши Анну на 01.05.'])
    assert.deepEqual(select(text), { date: null, time: null });
  assert.deepEqual(select('Запиши Анну на 17.10 в 14:30.'), { date: null, time: '14:30' });
  assert.deepEqual(select('Запиши Анну в 14.30.'), { time: '14:30' });
  assert.deepEqual(select('Запиши Анну на 17.10.2026.'), { date: '2026-10-17' });
  assert.deepEqual(select('Запиши Анну на 14:30.'), { time: '14:30' });
});
