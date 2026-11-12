const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceMatches } = require('../src/server/modules/assistant/language/services/service-matching.cjs');
const {
  serviceSuggestionScore,
  suggestServices,
  serviceChoiceOperation,
} = require('../src/server/modules/assistant/language/services/service-suggestions.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
function fixture(names = ['Миндальный пилинг'], query = 'миндалный пилинг') {
  const f = dialogueFixture();
  f.services.splice(
    0,
    f.services.length,
    ...names.map((name, index) => ({
      id: 'service-' + index,
      name,
      duration: 30,
      staffId: 'owner',
    })),
  );
  f.changed();
  const result = f.start({
    query: 'Анна',
    serviceQuery: query,
    date: day,
    time: '10:00',
    duration: 45,
  });
  return { f, result, entry: () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id) };
}
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));

test('strict service matching remains first and unchanged while whole-word typos and adjacent swaps become only suggestions', () => {
  for (const [name, query] of [
    ['Первичная консультация', 'первичную консултацию'],
    ['Миндальный пилинг', 'миндалный пилинг'],
    ['Пилинг', 'пилниг'],
  ]) {
    assert.equal(serviceMatches(name, query), false);
    assert.ok(Number.isFinite(serviceSuggestionScore(name, query)), query);
  }
  assert.equal(serviceSuggestionScore('Первичная консультация', 'консультацию'), 0);
  assert.equal(serviceMatches('Миндальный пилинг', 'миндального пилинга'), true);
});

test('joined actual catalog words and inflections are bounded hypotheses, never arbitrary substrings', () => {
  for (const query of ['миндальныйпилинг', 'миндальногопилинга'])
    assert.ok(Number.isFinite(serviceSuggestionScore('Миндальный пилинг', query)), query);
  for (const query of ['миндаль', 'пил', 'чист', 'миндальныйпилинготправь', 'пилинг завтра'])
    assert.equal(serviceSuggestionScore('Миндальный пилинг', query), Infinity, query);
});

test('every spoken qualifier consumes a separate whole catalog token and numeric service names never use fuzzy matching', () => {
  for (const [name, query] of [
    ['Миндальный пилинг', 'молочный пелинг'],
    ['Пилинг 1.5', 'пилинга 5,1'],
    ['Пилинг 30%', 'пелинг 30%'],
    ['Пилинг 30%', 'пилинг'],
    ['Пилинг 10', 'пилинг 1O'],
    ['Пилинг', 'пилинг 1'],
  ])
    assert.equal(serviceSuggestionScore(name, query), Infinity, query);
  assert.equal(serviceSuggestionScore('Пилинг 30%', 'пилинга 30%'), 0);
});

test('negative, alternatives, conditions and compound requests never produce approximate offers', () => {
  for (const query of [
    'не миндалный пилинг',
    'миндалный или молочный пилинг',
    'если можно миндалный пилинг',
    'миндалный пилинг и отправь сообщение',
    'миндалный пилинг, запиши еще',
  ])
    assert.equal(
      suggestServices([{ id: 's', name: 'Миндальный пилинг' }], query).matches.length,
      0,
      query,
    );
});

test('courtesy wrappers are removed only by the existing service wrapper, without dropping other query words', () => {
  for (const query of [
    'на миндалный пилинг',
    'пожалуйста, миндалный пилинг',
    'выбираю миндалный пилинг',
  ])
    assert.ok(Number.isFinite(serviceSuggestionScore('Миндальный пилинг', query)), query);
  assert.equal(
    serviceSuggestionScore('Миндальный пилинг', 'хочу миндалный пилинг завтра'),
    Infinity,
  );
});

test('read and candidate caps require clarification rather than selecting a truncated result', () => {
  const catalog = Array.from({ length: 4 }, (_, index) => ({
    id: 's' + index,
    name: ['Миндальный', 'Молочный', 'Жёлтый', 'Кислотный'][index] + ' пилинг',
  }));
  const four = suggestServices(catalog, 'пилниг');
  assert.equal(four.overflow, true);
  assert.ok(four.matches.length <= 3);
  assert.equal(
    suggestServices(
      Array.from({ length: 201 }, () => catalog[0]),
      'пилниг',
    ).overflow,
    true,
  );
  assert.equal(suggestServices(catalog, 'пилинг '.repeat(9)).overflow, true);
});

test('one approximate offer never resolves itself; yes confirms it while retaining client, date, time and manual duration', () => {
  const { f, result, entry } = fixture();
  assert.equal(result.dialogue.step, 'service');
  assert.equal(result.dialogue.phase, 'serviceChoice');
  assert.equal(result.dialogue.options.length, 1);
  assert.equal(result.dialogue.prompt, 'Вы имеете в виду «Миндальный пилинг»?');
  assert.equal(entry().data.serviceChosen, false);
  assert.equal(result.action, null);
  const known = {
    patient: entry().data.patient.id,
    date: entry().data.date,
    time: entry().data.time,
    duration: entry().data.duration,
  };
  const chosen = f.answer({ text: 'да' }).result;
  assert.equal(chosen.dialogue.step, 'review');
  assert.equal(entry().data.service.id, 'service-0');
  assert.deepEqual(
    {
      patient: entry().data.patient.id,
      date: entry().data.date,
      time: entry().data.time,
      duration: entry().data.duration,
    },
    known,
  );
  const form = f.answer({ text: 'открой форму' }).result;
  assert.equal(form.action.type, 'prepareAppointment');
  noSave(f);
});

test('two approximate services require a specific full title or opaque choice and never accept a bare yes', () => {
  const { f, result, entry } = fixture(['Миндальный пилинг', 'Молочный пилинг'], 'пилниг');
  assert.equal(result.dialogue.options.length, 2);
  assert.match(result.dialogue.prompt, /или/);
  assert.equal(serviceChoiceOperation(entry(), 'да').kind, 'localHelp');
  assert.equal(entry().data.serviceChosen, false);
  assert.equal(serviceChoiceOperation(entry(), 'пилинг').kind, 'localHelp');
  const chosen = f.answer({ text: 'Молочный пилинг' }).result;
  assert.equal(chosen.dialogue.step, 'review');
  assert.equal(entry().data.service.id, 'service-1');
  noSave(f);
});

test('stale suggested service name, duration or staff cannot be accepted through an old opaque choice', () => {
  for (const change of ['name', 'duration', 'staffId']) {
    const { f, result } = fixture();
    const before = f.result.dialogue.fields;
    f.services[0][change] =
      change === 'name' ? 'Другой пилинг' : change === 'duration' ? 60 : 'other';
    f.changed();
    assert.throws(
      () => f.answer({ choice: result.dialogue.options[0].id }),
      { status: 409 },
      change,
    );
    assert.deepEqual(f.result.dialogue.fields, before);
    noSave(f);
  }
});

test('suggested choices stay in the selected specialist catalog and numeric typos do not create a confirmable suggestion', () => {
  const { f, result } = fixture(['Пилинг 30%'], 'пелинг 30%');
  assert.equal(result.dialogue.options.length, 0);
  assert.equal(result.action, null);
  noSave(f);
  const normal = fixture();
  normal.f.services.push({
    id: 'foreign',
    name: 'Миндалный пилинг',
    duration: 30,
    staffId: 'other',
  });
  normal.f.changed();
  assert.equal(normal.entry().data.serviceChosen, false);
  noSave(normal.f);
});
