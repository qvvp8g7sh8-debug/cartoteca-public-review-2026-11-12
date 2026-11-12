const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-18', hour: 10, minute: 0 };
test('literal entity alternatives retain separately exact date/time without choosing an entity', () => {
  for (const [field, source] of [
    ['serviceQuery', 'RF лифтинг лицо плюс шея или молочный пилинг'],
    ['serviceQuery', 'чистку либо массаж'],
    ['query', 'Анну Семёнову или Ольгу Семёнову'],
    ['staffQuery', 'Ирину Орлову или Виктора Лабораторного'],
  ]) {
    const intent = { intent: 'prepareAppointment', [field]: source };
    const raw = 'Запиши на завтра в 12:00 на ' + source + '.';
    assert.deepEqual(
      bookingTemporalConstraints(intent, raw, clock),
      { date: '2026-10-19', time: '12:00' },
      source,
    );
  }
});
test('service ambiguity retains proven date/clock even when the model correctly leaves service null', () => {
  for (const raw of [
    'Запиши Анну на завтра в 12:00 на RF лифтинг лицо плюс шея или молочный пилинг.',
    'Запиши Анну на чистку либо массаж на завтра в 12:00.',
    'Запиши Анну на завтра в 12:00, услуга чистка или массаж.',
  ]) {
    assert.deepEqual(
      bookingTemporalConstraints({ intent: 'prepareAppointment', serviceQuery: null }, raw, clock),
      { date: '2026-10-19', time: '12:00' },
      raw,
    );
  }
});
test('a model cannot hide a real date/clock/duration alternative inside an entity proposal', () => {
  for (const source of [
    'завтра или послезавтра',
    'в 12:00 или в 14:00',
    'на два или на три',
    '20 октября или 21 октября',
    'тридцать или сорок минут',
    'примерно в полдень или вечером',
  ]) {
    const raw = 'Запиши Анну завтра в 12:00 на ' + source + '.';
    const plain = bookingTemporalConstraints({ intent: 'prepareAppointment' }, raw, clock);
    assert.deepEqual(
      bookingTemporalConstraints(
        { intent: 'prepareAppointment', serviceQuery: source },
        raw,
        clock,
      ),
      plain,
      source,
    );
  }
  const raw = 'Запиши Анну завтра в 12:00 на чистку или массаж.';
  assert.deepEqual(
    bookingTemporalConstraints(
      { intent: 'prepareAppointment', serviceQuery: 'чистка или массаж' },
      raw,
      clock,
    ),
    bookingTemporalConstraints({ intent: 'prepareAppointment' }, raw, clock),
    'nonliteral model title is not a proof',
  );
});
test('remaining uncertainty and negation outside the literal entity span remain conservative', () => {
  for (const raw of [
    'Запиши Анну примерно завтра в 12:00 на чистку или массаж.',
    'Запиши Анну не завтра в 12:00 на чистку или массаж.',
    'Запиши Анну завтра в 12:00 или 14:00 на чистку или массаж.',
  ]) {
    const result = bookingTemporalConstraints(
      { intent: 'prepareAppointment', serviceQuery: 'чистку или массаж' },
      raw,
      clock,
    );
    if (raw.includes('не завтра')) assert.equal(result.date, null);
    else if (raw.includes('примерно')) assert.equal(result.date, null);
    else assert.equal(result.time, null);
  }
});
test('service clarification keeps the independently proven date/time and completes after exact selection', () => {
  const f = dialogueFixture();
  f.services.push({ id: 'massage', name: 'Массаж', duration: 45, staffId: 'owner' });
  const raw = 'Запиши Анну Семёнову 5 января 2099 года в 12:00 на чистку или массаж.';
  const parsed = {
    intent: 'prepareAppointment',
    query: 'Анну Семёнову',
    serviceQuery: 'чистку или массаж',
  };
  const constraints = bookingTemporalConstraints(parsed, raw, f.clock);
  assert.deepEqual(constraints, { date: day, time: '12:00' });
  const reply = f.start(initialEntities(parsed, raw, constraints), constraints);
  assert.equal(reply.dialogue.step, 'service');
  assert.equal(reply.dialogue.fields.find((x) => x.key === 'date').value, day);
  assert.equal(reply.dialogue.fields.find((x) => x.key === 'time').value, '12:00');
  f.answer({ text: 'Массаж' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.dialogue.fields.find((x) => x.key === 'duration').value, '45 мин');
  assert.equal(f.patients[0].appointments.length, 0);
});
test('an independently heard past date explains the reason while keeping client, service and clock', () => {
  const f = dialogueFixture();
  const raw = 'Запиши Анну Семёнову на вчера в 12:00 на чистку.';
  const intent = { intent: 'prepareAppointment', query: 'Анну Семёнову', serviceQuery: 'чистку' };
  const constraints = bookingTemporalConstraints(intent, raw, f.clock);
  assert.deepEqual(constraints, { date: null, time: '12:00', dateRejection: 'past' });
  const first = f.start(initialEntities(intent, raw, constraints), constraints);
  assert.equal(first.dialogue.step, 'date');
  assert.match(first.text, /дата уже прошла/iu);
  assert.equal(first.action, null);
  assert.equal(first.dialogue.fields.find((x) => x.key === 'time').value, '12:00');
  f.answer({ text: '5 января 2099 года' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.doesNotMatch(f.result.text, /уже прошла/iu);
  assert.equal(f.result.dialogue.fields.find((x) => x.key === 'date').value, day);
  assert.equal(f.patients[0].appointments.length, 0);
});
test('an impossible or uncertain date is not falsely described as a recognized past date', () => {
  for (const source of ['31 ноября 2026 года', 'вчера или завтра', 'не завтра', 'примерно вчера']) {
    const constraints = bookingTemporalConstraints(
      { intent: 'prepareAppointment' },
      'Запиши Анну ' + source + ' в 12:00.',
      clock,
    );
    assert.equal(constraints.dateRejection, undefined, source);
  }
});
test('an explicit past day and month without a year gets a reason, without moving it to a future year', () => {
  for (const date of ['15 октября', 'пятнадцатого октября', '15 октября примерно в 12:00']) {
    const constraints = bookingTemporalConstraints(
      { intent: 'prepareAppointment' },
      'Запиши Анну на ' + date + '.',
      clock,
    );
    assert.equal(constraints.date, null, date);
    assert.equal(constraints.dateRejection, 'past', date);
  }
});
