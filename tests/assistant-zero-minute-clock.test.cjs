const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTimeText, parseDateText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { clockMinute, zeroClockParts } = require('../src/server/modules/assistant/language/time/clock-minute.cjs');
const { spokenNumber } = require('../src/server/modules/assistant/language/time/spoken-number.cjs');
const { parseDuration } = require('../src/server/modules/assistant/language/time/spoken-duration.cjs');
const {
  parseClientPhoneAnswer,
} = require('../src/server/modules/assistant/language/names/client-phone-answer.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
const forms = [
  '16 ноль ноль',
  'шестнадцать ноль ноль',
  'шестнадцать нуль нуль',
  '16 00',
  '16 0 0',
  '16 ноль-ноль',
  'шестнадцатьноль-ноль',
  'шестнадцатьнульнуль',
  'шестнадцать часов ноль ноль минут',
];
function fixture() {
  const f = dialogueFixture(),
    tomorrow = nextDate(day);
  f.c.platform.workSchedules.view = () => ({
    days: { [tomorrow]: { status: 'working', intervals: [['00:00', '24:00']] } },
    closures: {},
  });
  return f;
}
function noSave(f) {
  assert.ok(f.patients.every((row) => row.appointments.length === 0));
}
for (const phrase of forms)
  test('a whole zero-minute clock reaches the no-save initial form: ' + phrase, () => {
    const f = fixture(),
      raw = 'Запиши Анну Семёнову на завтра на ' + phrase + ' на Чистку.';
    assert.equal(parseTimeText(phrase), '16:00');
    const intent = {
      intent: 'prepareAppointment',
      query: 'Анну Семёнову',
      serviceQuery: 'Чистку',
      duration: 60,
    };
    const proof = bookingTemporalConstraints(intent, raw, f.clock);
    assert.equal(proof.time, '16:00');
    assert.equal(proof.duration, undefined);
    const result = f.start(initialEntities(intent, raw, proof), {
      ...proof,
      openWhenComplete: true,
    });
    assert.equal(result.dialogue, null);
    assert.equal(result.action.type, 'prepareAppointment');
    assert.equal(result.action.date, nextDate(day));
    assert.equal(result.action.time, '16:00');
    assert.equal(result.action.duration, 30);
    noSave(f);
  });

test('standalone time answers and labelled corrections keep every unrelated selected field', () => {
  for (const phrase of forms) {
    const f = fixture();
    f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: nextDate(day) });
    const answer = f.answer({ text: phrase }).result;
    const data = f.flow.get(f.c, f.member, f.state, answer.dialogue.id).data;
    assert.equal(data.time, '16:00', phrase);
    const known = {
      patient: data.patient.id,
      service: data.service.id,
      date: data.date,
      duration: data.duration,
    };
    const repaired = f.answer({ text: 'Поменяй время на двадцать ноль ноль' }).result;
    const after = f.flow.get(f.c, f.member, f.state, repaired.dialogue.id).data;
    assert.equal(after.time, '20:00');
    assert.deepEqual(
      {
        patient: after.patient.id,
        service: after.service.id,
        date: after.date,
        duration: after.duration,
      },
      known,
    );
    noSave(f);
  }
});

test('minute-only zero decoding keeps normal times and the existing day/night hour rules', () => {
  for (const [phrase, time] of [
    ['шестнадцать ноль пять', '16:05'],
    ['шестнадцать тридцать', '16:30'],
    ['ноль ноль ноль', '00:00'],
    ['23 ноль ноль', '23:00'],
    ['один ноль ноль', '13:00'],
    ['один ноль ноль ночи', '01:00'],
    ['двенадцать ноль ноль ночи', '00:00'],
  ])
    assert.equal(parseTimeText(phrase), time, phrase);
  for (const value of ['ноль ноль', 'нульнуль', '0 0', 'ноль-нуль'])
    assert.equal(clockMinute(value), 0, value);
  assert.deepEqual(zeroClockParts('шестнадцатьноль-ноль'), { hour: 16, minute: 0 });
  assert.equal(spokenNumber('ноль ноль'), null);
  assert.equal(parseDuration('ноль ноль минут'), null);
  assert.equal(parseDateText('16 00', { date: day, hour: 8, minute: 0 }), null);
  assert.deepEqual(parseClientPhoneAnswer('16 00'), { kind: 'suffix4', digits: '1600' });
});

test('zero clocks never consume invalid hours minutes extra groups unsupported units alternatives dates or phones', () => {
  const invalid = [
    '24 ноль ноль',
    '16 шестьдесят',
    '16 60',
    '16 ноль ноль ноль',
    '16 00 00',
    '16 ноль ноль секунд',
    'шестнадцать часов ноль ноль секунд',
    '16 ноль ноль или 17 ноль ноль',
    'не 16 ноль ноль',
    '16 ноль ноль если свободно',
    '932 70 06',
    '16 00 2026',
    '16.10.2026',
    'шестнадцатьноль-ноль-пять',
  ];
  for (const phrase of invalid) assert.equal(parseTimeText(phrase), null, phrase);
  for (const phrase of invalid.filter(
    (value) => !['932 70 06', '16 00 2026', '16.10.2026'].includes(value),
  )) {
    const proof = bookingTemporalConstraints(
      { intent: 'prepareAppointment' },
      'Запиши Анну завтра в ' + phrase + '.',
      { date: day, hour: 8, minute: 0 },
    );
    assert.notEqual(proof.time, '16:00', phrase);
  }
});

test('a decoded zero-minute clock still rechecks occupancy and keeps the chosen identity', () => {
  const f = fixture();
  f.busy.push({
    date: nextDate(day),
    time: '16:00',
    duration: 30,
    staffId: 'owner',
    roomId: 'main',
    status: 'scheduled',
  });
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', date: nextDate(day) });
  const reply = f.answer({ text: 'шестнадцать ноль ноль' }).result;
  assert.equal(reply.action, null);
  assert.match(reply.text, /занят/iu);
  const data = f.flow.get(f.c, f.member, f.state, reply.dialogue.id).data;
  assert.equal(data.patient.id, f.patients[0].id);
  assert.equal(data.service.id, 'clean');
  assert.equal(data.date, nextDate(day));
  noSave(f);
});
