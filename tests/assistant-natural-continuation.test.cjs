const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const {
  createContinuationRuntime,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-runtime.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const {
  continuationSourceScope,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-source-scope.cjs');
const { parseTimeText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
function base(fields) {
  return {
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
}
async function follow(raw, fields, setup = () => {}) {
  const f = dialogueFixture(),
    defaults = initialState();
  f.state.policy = { ...defaults.policy, ...f.state.policy, limits: defaults.policy.limits };
  f.state.providers = { ...defaults.providers, llm: { provider: 'timeweb', model: 'synthetic' } };
  f.state.rates = defaults.rates;
  setup(f);
  const first = f.start(
    { query: 'Анна Семёнова', date: day, time: '12:30' },
    { date: day, time: '12:30' },
  );
  let calls = 0;
  const runtime = createContinuationRuntime({
    dialogues: f.flow,
    scope: () => ({ state: f.state, member: f.member }),
    timeZone: () => 'Europe/Moscow',
    now: () => Date.parse(day + 'T05:00:00Z'),
    invoke: async (...args) => {
      calls++;
      args[7]();
      return { text: JSON.stringify(base(fields)) };
    },
  });
  const reply = await runtime.run(
    f.c,
    {
      policyVersion: f.state.revision,
      dialogueId: first.dialogue.id,
      dialogueVersion: first.dialogue.version,
      text: raw,
    },
    f.state,
    f.member,
  );
  return { f, reply, calls, data: f.flow.get(f.c, f.member, f.state, first.dialogue.id).data };
}
test('an hour-and-minute clock is not an appointment length; explicit length and separately stated start retain their meanings', () => {
  const clock = { date: '2026-10-18', hour: 10, minute: 0 };
  for (const phrase of [
    'на четырнадцать часов тридцать минут',
    'на два часа тридцать минут',
    'на два часа и тридцать минут',
  ]) {
    const actual = bookingTemporalConstraints(
      { intent: 'prepareAppointment' },
      'Завтра ' + phrase + ' запиши Анну на чистку.',
      clock,
    );
    assert.equal(actual.time, '14:30', phrase);
    assert.equal(actual.duration, undefined, phrase);
  }
  const exact = bookingTemporalConstraints(
    { intent: 'prepareAppointment' },
    'Запиши Анну завтра в 14:00 на два часа тридцать минут.',
    clock,
  );
  assert.equal(exact.duration, 150);
  assert.equal(exact.time, '14:00');
  const length = bookingTemporalConstraints(
    { intent: 'prepareAppointment' },
    'Запиши Анну завтра длительностью четырнадцать часов тридцать минут.',
    clock,
  );
  assert.equal(length.duration, 870);
  assert.equal(length.time, undefined);
});
test('named and conversational clock cues provide independent proof for a real multi-field continuation', async () => {
  for (const raw of [
    'Возьмём Чистку. Дату поставь на 5 января 2099 года, а время — двенадцать тридцать.',
    'Давайте остановимся на Чистке, а дату возьмём 5 января 2099 года. По времени мне подойдёт половина первого дня.',
  ]) {
    const { f, reply, data } = await follow(raw, { service: 'Чистке', date: day, time: '12:30' });
    assert.equal(reply.dialogue.step, 'review', reply.text);
    assert.equal(data.patient.id, f.patients[0].id);
    assert.equal(data.date, day);
    assert.equal(data.time, '12:30');
    assert.equal(data.duration, 30);
    assert.equal(data.service.id, 'clean');
    assert.equal(f.patients[0].appointments.length, 0);
  }
});
test('an omitted one before hour retains all minutes in labelled multi-field clock replies', async () => {
  for (const [phrase, expected] of [
    ['час тридцать дня', '13:30'],
    ['час и тридцать минут дня', '13:30'],
    ['час пять минут ночи', '01:05'],
    ['час ноль пять дня', '13:05'],
  ]) {
    assert.equal(parseTimeText('в ' + phrase), expected, phrase);
    const raw = 'Услуга — Чистка. Дата теперь 5 января 2099 года, время — ' + phrase + '.';
    const proof = bookingTemporalConstraints(
      { intent: 'prepareAppointment', serviceQuery: 'Чистка' },
      raw,
      { date: '2026-10-18', hour: 10, minute: 0 },
      { timeContext: true },
    );
    assert.equal(proof.time, expected, phrase);
    assert.equal(proof.duration, undefined, phrase);
  }
  for (const phrase of ['час шестьдесят дня', 'час тридцать секунд дня', 'час два три дня'])
    assert.equal(parseTimeText('в ' + phrase), null, phrase);
  const { reply, data } = await follow(
    'Услуга — Чистка. Дата теперь 5 января 2099 года, время — час тридцать дня.',
    { service: 'Чистка', date: day, time: '13:30' },
  );
  assert.equal(reply.dialogue.step, 'review', reply.text);
  assert.equal(data.time, '13:30');
  assert.equal(data.duration, 30);
});
test('a positive code correction can retain the unrelated fields without treating preservation as negation of the service', async () => {
  const services = (f) =>
    f.services.push(
      { id: 'prx133', name: 'Пилинг PRX-T133', duration: 60, staffId: 'owner' },
      { id: 'prx33', name: 'Пилинг PRX-T33', duration: 60, staffId: 'owner' },
    );
  for (const [raw, service, id] of [
    [
      'Нет, я ошибся с цифрами. Давайте всё же возьмём пилинг PRX-T133, время и клиента оставим прежними.',
      'пилинг PRX-T133',
      'prx133',
    ],
    [
      'Нужен именно тот пилинг с кодом T33. Клиента, дату и время менять не надо.',
      'пилинг с кодом T33',
      'prx33',
    ],
  ]) {
    const { f, reply, data } = await follow(raw, { service }, services);
    assert.equal(reply.dialogue.step, 'review', reply.text);
    assert.equal(data.service.id, id);
    assert.equal(data.patient.id, f.patients[0].id);
    assert.equal(data.date, day);
    assert.equal(data.time, '12:30');
    assert.equal(data.duration, 60);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});
test('preservation is not permission to mutate a protected field or silently accept a negated code', async () => {
  const scoped = continuationSourceScope('Нужен пилинг. Клиента, дату и время менять не надо.');
  assert.deepEqual([...scoped.protectedFields].sort(), ['client', 'date', 'time']);
  assert.doesNotMatch(scoped.text, /не надо/u);
  for (const raw of [
    'Не нужна Чистка.',
    'Нет, я ошибся. Не надо Чистку.',
    'Давайте Чистку, если останется время.',
  ]) {
    const { data, reply } = await follow(raw, { service: 'Чистка' });
    assert.notEqual(reply.dialogue.step, 'review', raw);
    assert.equal(data.service, null, raw);
  }
  const { data, reply } = await follow('Услугу не меняй. Нужна Чистка.', { service: 'Чистка' });
  assert.equal(data.service, null);
  assert.notEqual(reply.dialogue.step, 'review');
});
test('independent raw temporal proof cannot override a field explicitly protected by the user', async () => {
  for (const raw of [
    'Дату не меняй. Нужна Чистка на завтра.',
    'Время не меняй. Нужна Чистка в 14:00.',
    'Время не меняй. Нужна Чистка утром.',
    'Длительность не меняй. Нужна Чистка на 60 минут.',
  ]) {
    const { data, reply } = await follow(raw, { service: 'Чистка' });
    assert.notEqual(reply.dialogue.step, 'review', raw);
    assert.equal(data.service, null, raw);
    assert.equal(data.date, day, raw);
    assert.equal(data.time, '12:30', raw);
  }
});
