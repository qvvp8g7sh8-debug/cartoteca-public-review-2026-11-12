const test = require('node:test');
const assert = require('node:assert/strict');
const { exactServiceAnswer } = require('../src/server/modules/assistant/language/services/service-exact-followup.cjs');
const { entityText, initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const services = (names) => names.map((name, index) => ({
  id: 'service-' + index, name, duration: 60, staffId: 'owner',
}));
function fixture(names = ['Пилинг PRX-T133']) {
  const f = dialogueFixture();
  f.services.splice(0, f.services.length, ...services(names));
  f.changed();
  const entry = () => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  return { f, entry };
}
const known = { query: 'Анна Семёнова', date: day, time: '12:00' };
const aliases = ['PRX', 'prx', 'пилинг PRX', 'на пилинг PRX', 'пи-эр-икс',
  'пи эр икс', 'перикс', 'пилинг PeriX', 'PRХ', 'РRХ', 'РRX'];

test('short identifiers and deterministic spoken/visual forms resolve a current unique catalog identity', () => {
  for (const alias of aliases) {
    const catalog = services(['Пилинг PRX-T133', 'Миндальный пилинг']);
    assert.deepEqual(exactServiceAnswer(catalog, alias).matches.map((row) => row.id), ['service-0'], alias);
  }
  for (const alias of ['эр эф', 'RF', 'rf'])
    assert.equal(exactServiceAnswer(services(['RF лифтинг']), alias).matches.length, 1, alias);
});

test('abbreviated first command and followup skip yes while preserving known booking fields and catalog duration', () => {
  for (const initial of [true, false]) for (const alias of aliases) {
    const { f, entry } = fixture();
    f.start({ ...known, ...(initial ? { serviceQuery: alias } : {}) });
    if (!initial) {
      const body = { dialogueId: f.result.dialogue.id, dialogueVersion: f.result.dialogue.version,
        policyVersion: f.state.revision, text: alias };
      assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null, alias);
      f.answer({ text: alias });
    }
    assert.equal(f.result.dialogue.step, 'review', alias);
    assert.equal(entry().data.service.id, 'service-0', alias);
    assert.equal(entry().data.duration, 60);
    assert.equal(entry().data.durationSource, 'service');
    assert.equal(entry().data.patient.id, f.patients[0].id);
    assert.equal(entry().data.date, day);
    assert.equal(entry().data.time, '12:00');
    assert.doesNotMatch(f.result.text, /верно|имеете в виду/iu);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('explicit duration is retained for a unique abbreviated service and the prepared form carries its real id', () => {
  const { f, entry } = fixture();
  f.start({ ...known, serviceQuery: 'PRX', duration: 45 });
  assert.equal(entry().data.duration, 45);
  assert.equal(entry().data.durationSource, 'manual');
  const form = f.answer({ text: 'открой форму' }).result;
  assert.deepEqual(form.action.serviceIds, ['service-0']);
  assert.equal(form.action.duration, 45);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('different codes duplicate services and extra qualifiers remain ambiguous rather than selecting the first singleton', () => {
  for (const names of [
    ['Пилинг PRX-T33', 'Пилинг PRX-T133'],
    ['Пилинг PRX-T133', 'Пилинг PRX-T133'],
    ['Пилинг PRX-T133 лицо', 'Пилинг PRX-T133 шея'],
  ]) {
    const { f, entry } = fixture(names);
    f.start({ ...known, serviceQuery: 'PRX' });
    assert.equal(f.result.dialogue.step, 'service');
    assert.equal(entry().data.serviceChosen, false);
    assert.equal(f.result.dialogue.options.length, 2);
    assert.equal(f.result.action, null);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('unknown words wrong product codes negation alternatives prefixes and fuzzy singleton do not auto-select', () => {
  const catalog = services(['Пилинг PRX-T133', 'Жёлтый пилинг']);
  for (const alias of ['PRX-T113', 'PRX-T33', 'PRX-133', 'PR', 'пилинг PRX массаж',
    'PRX или массаж', 'не PRX', 'если PRX', 'жолтый пилинг', 'Жёлтый', 'пилинг'])
    assert.equal(exactServiceAnswer(catalog, alias).matches.length, 0, alias);
  assert.equal(exactServiceAnswer(services(['Пилинг PRX-T01']), 'PRX-T1').matches.length, 0);
});

test('fresh scoped catalog is used after local classification and generic singleton still asks a real question', () => {
  const { f, entry } = fixture();
  f.start(known);
  const body = { dialogueId: f.result.dialogue.id, dialogueVersion: f.result.dialogue.version,
    policyVersion: f.state.revision, text: 'PRX' };
  assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
  f.services.push({ ...f.services[0], id: 'duplicate', name: 'Пилинг PRX-T33' });
  f.changed();
  f.answer({ text: 'PRX' });
  assert.equal(entry().data.serviceChosen, false);
  assert.equal(f.result.dialogue.options.length, 2);
  const generic = fixture(['Жёлтый пилинг']);
  generic.f.start({ ...known, serviceQuery: 'жёлтый' });
  assert.equal(generic.entry().data.serviceChosen, false);
  assert.equal(generic.f.result.dialogue.prompt, 'Жёлтый пилинг, верно?');
});

test('staff changes and removal cannot reuse an abbreviated match from another current catalog', () => {
  for (const mutation of ['staff', 'remove']) {
    const { f, entry } = fixture();
    f.start(known);
    if (mutation === 'staff') f.services[0].staffId = 'foreign';
    else f.services.splice(0);
    f.changed();
    f.answer({ text: 'PRX' });
    assert.equal(entry().data.serviceChosen, false);
    assert.equal(entry().data.patient.id, f.patients[0].id);
    assert.equal(entry().data.date, day);
    assert.equal(entry().data.time, '12:00');
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('short identity scan is bounded and complete exact titles preserve precedence', () => {
  assert.equal(exactServiceAnswer(services(Array.from({ length: 201 }, () => 'Пилинг PRX-T133')), 'PRX').matches.length, 0);
  const catalog = services(['PRX', 'Пилинг PRX-T133']);
  assert.deepEqual(exactServiceAnswer(catalog, 'PRX').matches.map((row) => row.id), ['service-0']);
});


test('canonical model title reaches initial source grounding and a fresh ready form without inventing its code', () => {
  for (const [raw, expected] of [
    ['Запиши Анну Семёнову на пилинг PRX завтра в 12:00.', 'пилинг PRX'],
    ['Запиши на завтра в 12:00 Анну Семёнову на PRX.', 'PRX'],
    ['Запиши Анну Семёнову на пи-эр-икс завтра в 12:00.', 'пи-эр-икс'],
    ['Запиши Анну Семёнову на пилинг PeriX завтра в 12:00.', 'пилинг PeriX'],
    ['Запиши Анну Семёнову на РRХ завтра в 12:00.', 'РRХ'],
  ]) {
    const { f, entry } = fixture();
    const grounded = initialEntities({ intent: 'prepareAppointment', ...known,
      serviceQuery: 'Пилинг PRX-T133', duration: 720 }, raw, { date: day, time: '12:00' });
    assert.equal(grounded.serviceQuery, expected, raw);
    assert.equal(grounded.duration, undefined, 'model cannot create an unheard duration');
    assert.equal(grounded.query, 'Анну Семёнову');
    f.start(grounded);
    assert.equal(f.result.dialogue.step, 'review');
    assert.equal(entry().data.service.id, 'service-0');
    assert.equal(entry().data.duration, 60);
    const ready = f.answer({ text: 'открой форму' }).result;
    assert.equal(ready.action.type, 'prepareAppointment');
    assert.deepEqual(ready.action.serviceIds, ['service-0']);
    assert.equal(ready.action.duration, 60);
    assert.equal(ready.action.date, day);
    assert.equal(ready.action.time, '12:00');
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('canonical continuation proposal keeps the spoken short identity and existing booking fields', () => {
  const { f, entry } = fixture();
  f.start(known);
  const body = { dialogueId: f.result.dialogue.id, dialogueVersion: f.result.dialogue.version,
    policyVersion: f.state.revision, text: 'Мне нужен пилинг PRX' };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.ok(snapshot);
  const result = f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, {
    operation: 'patch', fields: { client: null, staff: null, service: 'Пилинг PRX-T133',
      date: null, time: null, duration: null }, choice: null, field: null,
  }, snapshot);
  assert.equal(result.dialogue.step, 'review');
  assert.equal(entry().data.serviceQuery, 'пилинг PRX');
  assert.equal(entry().data.service.id, 'service-0');
  assert.equal(entry().data.patient.id, f.patients[0].id);
  assert.equal(entry().data.date, day);
  assert.equal(entry().data.time, '12:00');
  assert.equal(f.patients[0].appointments.length, 0);
});

test('raw identity fallback retains heard conflicting codes and lets only the current catalog resolve them', () => {
  for (const [raw, expected] of [
    ['Запиши на пилинг PeriX T134.', 'пилинг PeriX T134'],
    ['Запиши на пилинг PeriX-T134.', 'пилинг PeriX-T134'],
    ['Запиши на T134 пилинг PeriX.', 'T134 пилинг PeriX'],
  ]) {
    const grounded = entityText(raw, 'Пилинг PRX-T133', 'service');
    assert.equal(grounded, expected, raw);
    assert.ok(!grounded.includes('T133'));
    assert.equal(exactServiceAnswer(services(['Пилинг PRX-T133']), grounded).matches.length, 0);
  }
  const grounded = entityText('Запиши на пилинг PeriX-T33.', 'Пилинг PRX-T133', 'service');
  assert.equal(grounded, 'пилинг PeriX-T33');
  assert.deepEqual(exactServiceAnswer(services(['Пилинг PRX-T133', 'Пилинг PRX-T33']), grounded)
    .matches.map((row) => row.id), ['service-1']);
});

test('raw identity fallback rejects negative alternatives unrelated words and unknown adjacent qualifiers', () => {
  for (const raw of [
    'Запиши не на пилинг PRX.', 'Не пилинг PRX.', 'Запиши на PRX или массаж.',
    'Запиши на пилинг PRX или консультацию.', 'Запиши на PRX и массаж.',
    'Запиши на PRX массаж.', 'Запиши на массаж PRX.', 'Запиши на пи эр.',
    'Запиши на массаж.', 'Запиши на PRX-T134 или PRX-T133.',
  ]) assert.equal(entityText(raw, 'Пилинг PRX-T133', 'service'), '', raw);
  assert.equal(entityText('Не пилинг PRX, а пилинг PeriX завтра.', 'Пилинг PRX-T133', 'service'),
    'пилинг PeriX');
  const raw = 'Запиши на PRX завтра.';
  const grounded = entityText(raw, 'Пилинг PRX-T133', 'service');
  assert.equal(grounded, 'PRX');
  assert.equal(exactServiceAnswer(services(['Пилинг PRX-T33', 'Пилинг PRX-T133']), grounded)
    .matches.length, 2, 'model canonical code cannot collapse a real ambiguity');
});


test('initial service-first commands use only already-proven client and staff edges as field boundaries', () => {
  for (const raw of [
    'Запиши на пилинг PRX Анну Семёнову завтра в12:00.',
    'Запиши Анну Семёнову пилинг PRX завтра в12:00.',
    'На пилинг PRX запиши Анну Семёнову на завтра в12:00.',
  ]) {
    const { f, entry } = fixture();
    const grounded = initialEntities({ intent: 'prepareAppointment', ...known,
      serviceQuery: 'Пилинг PRX-T133' }, raw, { date: day, time: '12:00' });
    assert.equal(grounded.serviceQuery, 'пилинг PRX', raw);
    assert.equal(grounded.query, 'Анну Семёнову', raw);
    f.start(grounded);
    assert.equal(f.result.dialogue.step, 'review', raw);
    assert.equal(entry().data.service.id, 'service-0');
    assert.equal(entry().data.duration, 60);
    assert.equal(entry().data.date, day);
    assert.equal(entry().data.time, '12:00');
    assert.equal(entry().data.patient.id, f.patients[0].id);
    const form = f.answer({ text: 'открой форму' }).result;
    assert.deepEqual(form.action.serviceIds, ['service-0']);
    assert.equal(f.patients[0].appointments.length, 0);
  }
  const raw = 'Запиши на пилинг PRX Анну Семёнову завтра в12:00.';
  assert.equal(entityText(raw, 'Пилинг PRX-T133', 'service'), '',
    'unknown adjacent names are not allowed without an independently source-proven client');
  const unproven = initialEntities({ intent: 'prepareAppointment', ...known,
    query: 'Жанна Семёнова', serviceQuery: 'Пилинг PRX-T133' }, raw,
  { date: day, time: '12:00' });
  assert.equal(unproven.serviceQuery, undefined, 'unheard client proposal grants no boundary');
  const withNoise = initialEntities({ intent: 'prepareAppointment', ...known,
    serviceQuery: 'Пилинг PRX-T133' },
  'Запиши на пилинг PRX массаж Анну Семёнову завтра в12:00.',
  { date: day, time: '12:00' });
  assert.equal(withNoise.serviceQuery, undefined, 'a proven client does not hide another service word');
});


test('literal short model proposals retain neighboring service words instead of hiding qualifiers', () => {
  for (const [raw, expected, count] of [
    ['Запиши на пилинг PRX.', 'пилинг PRX', 1],
    ['Запиши на PRX массаж.', 'PRX массаж', 0],
    ['Запиши на массаж PRX.', 'массаж PRX', 0],
    ['Запиши на PRX глубокий.', 'PRX глубокий', 0],
    ['Запиши на пилинг PRX завтра в12:00.', 'пилинг PRX', 1],
    ['Запиши на пилинг PRX двенадцать часов.', 'пилинг PRX', 1],
    ['Запиши на пилинг PRX двадцатого.', 'пилинг PRX', 1],
  ]) {
    const grounded = entityText(raw, 'PRX', 'service');
    assert.equal(grounded, expected, raw);
    assert.equal(exactServiceAnswer(services(['Пилинг PRX-T133']), grounded).matches.length, count, raw);
  }
  for (const raw of ['Запиши не на пилинг PRX.', 'Не пилинг PRX.', 'Запиши на PRX или массаж.',
    'Запиши на пилинг PRX и массаж.'])
    assert.equal(entityText(raw, 'PRX', 'service'), '', raw);
  const raw = 'Запиши на пилинг PRX Анну Семёнову завтра в12:00.';
  const grounded = initialEntities({ intent: 'prepareAppointment', ...known, serviceQuery: 'PRX' },
    raw, { date: day, time: '12:00' });
  assert.equal(grounded.serviceQuery, 'пилинг PRX');
  const { f, entry } = fixture();
  f.start(grounded);
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(entry().data.service.id, 'service-0');
  assert.equal(entry().data.patient.id, f.patients[0].id);
});
