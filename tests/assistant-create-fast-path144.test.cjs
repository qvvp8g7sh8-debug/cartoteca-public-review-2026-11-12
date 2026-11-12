const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appointmentCreateIntent,
} = require('../src/server/modules/assistant/actions/appointment-create-request.cjs');
const clock = { date: '2026-10-26', hour: 10, minute: 0 };
const names = new Set(['Иванову', 'Анны Ивановой', 'Анну-Марию О’Нил', 'Анну Иванову']);
const parse = (text) => appointmentCreateIntent(text, clock, (query) => names.has(query));

test('whole weekday booking clauses reuse the existing temporal proof without a model', () => {
  const bookingClock = { date: '2026-11-10', hour: 12, minute: 0 };
  for (const [dateClause, date] of [
    ['на пятницу', '2026-11-13'],
    ['на следующий понедельник', '2026-11-16'],
    ['на 13.11.2026', '2026-11-13'],
  ])
    assert.deepEqual(
      appointmentCreateIntent(`Запиши клиента Анну Семёнову ${dateClause} в 11:00`, bookingClock),
      { intent: 'prepareAppointment', query: 'Анну Семёнову', date, time: '11:00' },
      dateClause,
    );
});

test('weekday fast path retains the full-tail and implicit identity boundaries', () => {
  const bookingClock = { date: '2026-11-10', hour: 12, minute: 0 };
  for (const tail of [
    'на пятницу или субботу в 11:00',
    'не на пятницу, а на субботу в 11:00',
    'на пятницу в 11:00 если она согласна',
    'на пятницу в 11:00 с уведомлением',
    'на пятницу в 11:00 на следующей неделе',
    'на пятницу на субботу в 11:00',
    'на следующую неделю в 11:00',
    'на прошлую пятницу в 11:00',
  ])
    assert.equal(
      appointmentCreateIntent(`Запиши клиента Анну Семёнову ${tail}`, bookingClock),
      null,
      tail,
    );
  const text = 'Запиши Анну Семёнову на пятницу в 11:00';
  assert.equal(appointmentCreateIntent(text, bookingClock), null);
  assert.equal(
    appointmentCreateIntent(text, bookingClock, () => false),
    null,
  );
  let proof;
  assert.equal(
    appointmentCreateIntent(text, bookingClock, (query) => {
      proof = query;
      return true;
    })?.query,
    'Анну Семёнову',
  );
  assert.equal(proof, 'Анну Семёнову');
});

test('weekday proposals use each supplied organization date across midnight and year boundaries', () => {
  const text = 'Запиши клиента Анну Семёнову на пятницу в 11:00';
  assert.equal(
    appointmentCreateIntent(text, { date: '2026-11-13', hour: 23, minute: 59 })?.date,
    '2026-11-13',
  );
  assert.equal(
    appointmentCreateIntent(text, { date: '2026-11-14', hour: 0, minute: 0 })?.date,
    '2026-11-20',
  );
  assert.equal(
    appointmentCreateIntent('Запиши клиента Анну Семёнову на следующий четверг в 11:00', {
      date: '2026-12-31',
    })?.date,
    '2027-01-07',
  );
});
test('only complete literal initial booking clauses become local proposals, preserving declined names', () => {
  for (const [text, fields] of [
    ['Запиши Иванову завтра в 14:00', { query: 'Иванову', date: '2026-10-27', time: '14:00' }],
    [
      'Пожалуйста, создай новую запись для Анны Ивановой, завтра в 14:00.',
      { query: 'Анны Ивановой', date: '2026-10-27', time: '14:00' },
    ],
    [
      'Запишите Анну-Марию О’Нил на 2099-01-05 в 09:15',
      { query: 'Анну-Марию О’Нил', date: '2099-01-05', time: '09:15' },
    ],
    [
      'Запиши +7 (999) 111-22-33 на 05.01.2099 в 9 утра',
      { query: '+7 (999) 111-22-33', date: '2099-01-05', time: '09:00' },
    ],
    [
      'Запиши Иванову на 5 января 2099 в полдень',
      { query: 'Иванову', date: '2099-01-05', time: '12:00' },
    ],
    [
      'Запиши Иванову на 30 минут завтра в 14:00',
      { query: 'Иванову', duration: 30, date: '2026-10-27', time: '14:00' },
    ],
    [
      'Запиши Иванову завтра в 14:00 длительностью один час и тридцать минут',
      { query: 'Иванову', date: '2026-10-27', time: '14:00', duration: 90 },
    ],
    ['Запиши клиента послезавтра на полчаса', { date: '2026-10-28', duration: 30 }],
    ['Запиши Иванову', { query: 'Иванову' }],
    ['Создай новую запись', {}],
    ['Запиши клиента', {}],
    ['Новая запись', {}],
  ])
    assert.deepEqual(parse(text), { intent: 'prepareAppointment', ...fields }, text);
});
test('the entire unsupported tail remains on the model path; no conditions or second task are discarded', () => {
  for (const text of [
    'Не записывай Иванову',
    'Запиши Иванову, если завтра свободно',
    'Запиши Иванову или Петрову',
    'Запиши Иванову и Петрову',
    'Запиши Иванову и сохрани',
    'Запиши Иванову и открой карточку',
    'Запиши Иванову завтра у Петровой',
    'Запиши Иванову на чистку',
    'Запиши Иванову для услуги Пилинг',
    'Запиши Иванову на завтра после обеда',
    'Запиши Иванову завтра в любое время',
    'Запиши Иванову завтра или послезавтра',
    'Запиши Иванову завтра послезавтра',
    'Запиши Иванову завтра в 14:00 в 15:00',
    'Запиши Иванову на 30 минут на час',
    'Запиши клиента Иванову на час',
    'Запиши клиента Иванову завтра на час',
    'Запиши Иванову на один час',
    'Запиши Иванову на два часа',
    'Запиши Иванову на один час и тридцать минут',
    'Запиши Иванову 31.02.2099',
    'Запиши Иванову 5 января',
    'Запиши Иванову двадцать пятого',
    'Запиши Иванову в девять',
    'Запиши Иванову завтра в 24:00',
    'Запиши Иванову на 3 минуты',
    'Запиши Иванову на 30 секунд',
    'Запиши Иванову по возможности',
    'Запиши Иванову срочно',
    'Запиши Иванову ботокс завтра',
    'Запиши ботокс',
    'Запиши Анну чистку завтра',
    'Прошу, запиши Иванову завтра в 14:00',
    'Запиши Иванову\nи сохрани',
    null,
    42,
  ])
    assert.equal(parse(text), null, String(text));
});
test('a new clock is read for every proposal and only explicit calendar/time evidence is used', () => {
  assert.equal(
    appointmentCreateIntent('Запиши клиента Иванову завтра', { date: '2026-12-31' }).date,
    '2027-01-01',
  );
  assert.equal(
    appointmentCreateIntent('Запиши клиента Иванову завтра', { date: '2027-01-01' }).date,
    '2027-01-02',
  );
  assert.equal(parse('Запиши в 14:00').time, '14:00');
  assert.equal(Object.hasOwn(parse('Запиши Иванову'), 'date'), false);
  assert.equal(parse('Запиши на 2099-01-05').query, undefined);
});

test('implicit names need a fresh whole-identity proof; explicit client slots and phones need no guessed-name rule', () => {
  assert.equal(appointmentCreateIntent('Запиши Иванову завтра', clock), null);
  assert.equal(
    appointmentCreateIntent('Запиши Иванову ботокс завтра', clock, () => false),
    null,
  );
  let proven;
  assert.equal(
    appointmentCreateIntent('Запиши Анны Ивановой завтра', clock, (query) => {
      proven = query;
      return true;
    }).query,
    'Анны Ивановой',
  );
  assert.equal(proven, 'Анны Ивановой');
  const denied = Object.assign(Error('Synthetic revoked scope'), { status: 403 });
  assert.throws(
    () =>
      appointmentCreateIntent('Запиши Иванову', clock, () => {
        throw denied;
      }),
    (error) => error === denied,
  );
  const unused = () => assert.fail('Explicit client noun/phone has an unambiguous literal role');
  assert.equal(
    appointmentCreateIntent('Запиши клиента неизвестную Фамилию', clock, unused).query,
    'неизвестную Фамилию',
  );
  assert.equal(
    appointmentCreateIntent('Запиши +79991112233 завтра', clock, unused).query,
    '+79991112233',
  );
});
