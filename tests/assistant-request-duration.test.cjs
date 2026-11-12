const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModelIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const command = (patch = {}) => ({
  intent: 'prepareAppointment',
  query: 'Анна Семёнова',
  ...patch,
});
const invalid = [
  ['seven minutes', 'Запиши Анну завтра на семь минут.', {}],
  ['rounded model value', 'Запиши Анну на 7 минут.', { duration: 10 }],
  ['zero minutes', 'Запиши Анну на ноль минут.', {}],
  ['beyond application limit', 'Запиши Анну на 1500 минут.', {}],
  ['fractional minutes', 'Запиши Анну на 7,5 минут.', {}],
  ['conflicting durations', 'Запиши Анну на 30 минут и на 45 минут.', { duration: 30 }],
];
for (const [title, text, patch] of invalid)
  test(title + ' requires a contextual duration answer instead of a service default', () => {
    assert.deepEqual(intentRequestConstraints(command(patch), text), { requireDuration: true });
  });
test('a valid explicit duration remains authoritative when the model omits or substitutes it', () => {
  for (const patch of [{}, { duration: 45 }, { duration: 30 }])
    assert.deepEqual(intentRequestConstraints(command(patch), 'Запиши Анну на тридцать минут.'), {
      duration: 30,
    });
});
test('whole exact duration expressions preserve units and surrounding service/date prepositions', () => {
  for (const [text, duration] of [
    ['Запиши Анну на первичную консультацию на завтра на тридцать минут.', 30],
    ['Запиши Анну на один час тридцать минут.', 90],
    ['Запиши Анну на полчаса.', 30],
    ['Запиши Анну на 1.5 часа.', 90],
    ['Запиши Анну на 17 октября на 30 минут.', 30],
    ['Запиши Анну на семнадцатое октября длительностью 45 минут.', 45],
    ['Запиши Анну длительностью 45 мин.', 45],
  ])
    assert.deepEqual(intentRequestConstraints(command(), text), { duration }, text);
});
test('identical repetitions remain consistent and explicit corrections stay with the correction parser', () => {
  assert.deepEqual(intentRequestConstraints(command(), 'Запиши Анну на 30 минут, на 30 минут.'), {
    duration: 30,
  });
  assert.deepEqual(
    intentRequestConstraints(
      command({ duration: 30 }),
      'Запиши Анну на 7 минут, нет, лучше на 30 минут.',
    ),
    { duration: 30 },
  );
});
test('unparsed duration modifiers never become a shorter exact duration', () => {
  for (const text of [
    'Запиши Анну на час с четвертью.',
    'Запиши Анну на час или полтора часа.',
    'Запиши Анну на примерно тридцать минут.',
    'Запиши Анну на -30 минут.',
  ])
    assert.deepEqual(intentRequestConstraints(command(), text), { requireDuration: true }, text);
});
test('readonly availability rejects unsupported durations and retains exact literal duration constraints', () => {
  assert.throws(
    () => intentRequestConstraints({ intent: 'availability' }, 'Найди окно на семь минут.'),
    { status: 400 },
  );
  assert.deepEqual(
    intentRequestConstraints(
      { intent: 'availability', duration: 30 },
      'Найди окно по тридцать минут.',
    ),
    { duration: 30 },
  );
  assert.deepEqual(intentRequestConstraints({ intent: 'availability' }, 'Найди окно на полчаса.'), {
    duration: 30,
  });
});
test('unrelated dates, phones, actions, and missing request context do not create duration requirements', () => {
  assert.deepEqual(
    intentRequestConstraints(command(), 'Запиши Анну 17 октября в 14:30. Телефон +79990000001.'),
    {},
  );
  for (const intent of ['help', 'clients', 'calendar', 'clientCard'])
    assert.deepEqual(intentRequestConstraints({ intent }, 'Запиши Анну на семь минут.'), {});
  for (const text of [undefined, null, '', 'a'.repeat(4001)])
    assert.deepEqual(intentRequestConstraints(command(), text), {});
});
test('model decoding is a structural boundary and trusted request requirements remain separate', () => {
  assert.deepEqual(
    parseModelIntent('{"intent":"prepareAppointment","query":"Анна Семёнова"}'),
    command(),
  );
  assert.throws(() => parseModelIntent('{"intent":"prepareAppointment","duration":7}'), {
    status: 502,
  });
});
test('appointment hour qualifiers never become an additional multi-hour duration', () => {
  for (const text of [
    'Запиши Анну завтра на шесть часов вечера.',
    'Запиши Анну завтра на 6 часов вечера.',
    'Запиши Анну завтра на девять часов утра.',
  ])
    assert.deepEqual(intentRequestConstraints(command({ time: '18:00' }), text), {}, text);
  assert.deepEqual(
    intentRequestConstraints(command(), 'Запиши Анну на 6 часов вечера длительностью 30 минут.'),
    { duration: 30 },
  );
});

test('correction words do not disable the duration guard for a leading preference or another field', () => {
  for (const text of [
    'Лучше подготовь запись Анне на семь минут.',
    'Запиши Анну на семь минут, точнее услуга первичная консультация.',
    'Вместо осмотра запиши Анну на семь минут.',
  ])
    assert.deepEqual(
      intentRequestConstraints(command({ duration: 30 }), text),
      { requireDuration: true },
      text,
    );
});
test('a clear final duration correction remains exact without retaining the retracted duration', () => {
  assert.deepEqual(
    intentRequestConstraints(
      command({ duration: 45 }),
      'Запиши Анну на 7 минут, нет, лучше на 30 минут.',
    ),
    { duration: 30 },
  );
  assert.deepEqual(
    intentRequestConstraints(
      command({ duration: 30 }),
      'Запиши Анну на 30 минут, точнее 45 минут.',
    ),
    { duration: 45 },
  );
  assert.deepEqual(
    intentRequestConstraints(command(), 'Запиши Анну на 30 минут, точнее на завтра.'),
    { duration: 30 },
  );
});
test('a date phrase before an evening clock never creates a duration requirement', () => {
  for (const text of [
    'Запиши Анну на 2026-10-19 в шесть часов вечера на 30 минут.',
    'Запиши Анну на 20.10.2026 в шесть часов вечера на полчаса.',
    'Запиши Анну на восемнадцатое октября в 6 часов вечера на тридцать минут.',
  ])
    assert.deepEqual(intentRequestConstraints(command(), text), { duration: 30 }, text);
});
test('time offsets never replace an explicitly selected appointment duration', () => {
  assert.deepEqual(
    intentRequestConstraints(
      command({ duration: 30 }),
      'Запиши Анну завтра в 14:30 на 60 минут, точнее на полчаса позже.',
    ),
    { duration: 60 },
  );
  assert.deepEqual(
    intentRequestConstraints(command(), 'Запиши Анну завтра в 14:30, время на 30 минут позже.'),
    {},
  );
});
test('a conjunction with a date, clock or employee preserves one exact duration', () => {
  for (const text of [
    'Запиши Анну на 30 минут и в 14:30 завтра.',
    'Запиши Анну на 30 минут и на завтра.',
    'Запиши Анну на 30 минут и к Ирине Орловой.',
  ])
    assert.deepEqual(intentRequestConstraints(command(), text), { duration: 30 }, text);
  assert.deepEqual(
    intentRequestConstraints(command(), 'Запиши Анну длительностью один час с Ириной Орловой.'),
    { duration: 60 },
  );
});
test('a real second duration or hour modifier still requires clarification', () => {
  for (const text of [
    'Запиши Анну на 30 минут и 45 минут.',
    'Запиши Анну на час с четвертью.',
    'Запиши Анну на 30 минут или на 45 минут.',
  ])
    assert.deepEqual(intentRequestConstraints(command(), text), { requireDuration: true }, text);
});
test('comma-adjacent duration phrases retain contradictory values instead of silently keeping the first', () => {
  assert.deepEqual(intentRequestConstraints(command(), 'Запиши Анну на 30 минут,на 7 минут.'), {
    requireDuration: true,
  });
});

test('comparative forms of a time shift cannot shorten the requested appointment', () => {
  for (const shift of ['позднее', 'ранее']) {
    const text = 'Запиши Анну завтра в 14:30 на 60 минут, точнее на 15 минут ' + shift + '.';
    assert.deepEqual(
      intentRequestConstraints(command({ duration: 15 }), text),
      { duration: 60 },
      text,
    );
    assert.deepEqual(
      intentRequestConstraints(command(), 'Запиши Анну завтра в 14:30, на полчаса ' + shift + '.'),
      {},
      shift,
    );
  }
});
