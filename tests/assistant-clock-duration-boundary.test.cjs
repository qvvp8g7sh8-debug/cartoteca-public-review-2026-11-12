const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTimeText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { intentRequestConstraints } = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { bookingTemporalConstraints } = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const { continuationOperation } = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: day, hour: 8, minute: 0 };
const intent = { intent: 'prepareAppointment' };
const twelve = ['на 12 часов', 'на двенадцать часов', 'на12часов', 'надвенадцатьчасов'];
const current = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
const fields = (values) => ({ client: null, staff: null, service: null, date: null, time: null, duration: null, ...values });
const proposal = (values) => ({ operation: 'patch', fields: fields(values), choice: null, field: null });

test('whole appointment clock hours in numeric spoken or joined form are not a length', () => {
  for (const phrase of twelve) {
    assert.equal(parseTimeText(phrase), '12:00', phrase);
    for (const request of [
      'Запиши Анну Семенову ' + phrase + ' на Чистку.',
      'Запиши прием ' + phrase + '.',
      'На Чистку запиши ' + phrase + ' Анну Семенову на завтра.',
      phrase + ' завтра запиши Анну Семенову на Чистку.',
    ]) {
      const result = bookingTemporalConstraints(intent, request, clock);
      assert.equal(result.time, '12:00', request);
      assert.equal(result.duration, undefined, request);
      assert.equal(result.requireDuration, undefined, request);
    }
  }
  for (const [phrase, time] of [['на один час', '13:00'], ['на2часа', '14:00'], ['на два часа', '14:00'], ['на двенадцать часов ночи', '00:00']])
    assert.equal(parseTimeText(phrase), time, phrase);
});

test('explicit length markers and natural minute fractional or compound lengths remain authoritative', () => {
  for (const [phrase, duration] of [
    ['длительностью 12 часов', 720], ['продолжительностью 12 часов', 720],
    ['длительность процедуры на 60 минут', 60], ['длительность:60мин', 60],
    ['измени продолжительность процедуры на 45 минут', 45], ['прием длится 12 часов', 720],
    ['на 30 минут', 30], ['на полчаса', 30], ['на полтора часа', 90],
    ['длительностью один час тридцать минут', 90], ['на 1.5 часа', 90],
  ]) {
    const text = 'Запиши Анну на завтра на Чистку, ' + phrase + '.';
    const result = bookingTemporalConstraints(intent, text, clock);
    assert.equal(result.duration, duration, text);
    assert.ok(result.time === undefined || result.time === null, 'A length alone does not invent a starting clock: ' + text);
  }
  assert.deepEqual(intentRequestConstraints(intent, 'Запиши Анну в 14:00 на два часа.'), { duration: 120 });
  assert.deepEqual(intentRequestConstraints({ intent: 'availability' }, 'Найди окно завтра на 12 часов.'), { duration: 720 });
});

test('initial trusted provenance ignores a spurious model length and the catalog supplies duration end to end', () => {
  for (const phrase of twelve) {
    const f = dialogueFixture(); f.services[0].duration = 60;
    const text = 'Запиши Анну Семенову на Чистку ' + phrase + ' на сегодня.';
    const parsed = { ...intent, query: 'Анну Семенову', serviceQuery: 'Чистку', duration: 720, time: '00:00' };
    const constraints = bookingTemporalConstraints(parsed, text, f.clock);
    const trusted = initialEntities(parsed, text, constraints);
    assert.equal(trusted.duration, undefined, phrase);
    let result = f.flow.start(f.c, trusted, f.state, f.member, f.clock,
      f.flow.beginCommand(f.c, f.member, f.state), constraints);
    assert.equal(result.dialogue.step, 'review', phrase);
    const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
    assert.equal(entry.data.time, '12:00', phrase);
    assert.equal(entry.data.duration, 60, phrase);
    assert.equal(entry.data.durationSource, 'service', phrase);
    assert.equal(entry.data.service.id, 'clean');
    result = f.flow.continueDialogue(f.c, { dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version, text: 'открой форму' }, f.state, f.member, f.clock);
    assert.equal(result.action.type, 'prepareAppointment');
    assert.equal(result.action.time, '12:00');
    assert.equal(result.action.duration, 60);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('whole-hour continuation repairs change the start from every entity stage without replacing catalog duration', () => {
  for (const missing of ['client', 'service', 'time', 'none']) {
    for (const phrase of twelve) {
      const f = dialogueFixture(); f.services[0].duration = 60;
      f.start({ query: missing === 'client' ? undefined : 'Анну Семенову',
        serviceQuery: missing === 'service' ? undefined : 'Чистка', date: day,
        time: missing === 'time' ? undefined : '10:00' });
      const prior = structuredClone(current(f).data);
      f.answer({ text: phrase });
      const data = current(f).data;
      assert.equal(data.time, '12:00', missing + ': ' + phrase);
      assert.equal(data.duration, prior.duration, phrase);
      assert.equal(data.durationSource, prior.durationSource, phrase);
      assert.equal(data.date, prior.date, phrase);
      assert.deepEqual(data.patient, prior.patient, phrase);
      assert.equal(f.result.action, null);
      assert.equal(f.patients[0].appointments.length, 0);
    }
  }
});

test('duration questions and explicit edits change only length and keep the selected start', () => {
  for (const phrase of ['на 12 часов', 'на двенадцать часов', '12 часов']) {
    const f = dialogueFixture(); f.c.platform.workSchedules.view = () => ({ days: {
      [day]: { status: 'working', intervals: [['00:00', '24:00']] },
    }, closures: {} });
    let result = f.flow.start(f.c, { ...intent, query: 'Анну Семенову', serviceQuery: 'Чистка', date: day, time: '09:00' },
      f.state, f.member, f.clock, f.flow.beginCommand(f.c, f.member, f.state), { requireDuration: true });
    assert.equal(result.dialogue.step, 'duration');
    result = f.flow.continueDialogue(f.c, { dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version, text: phrase }, f.state, f.member, f.clock);
    const data = f.flow.get(f.c, f.member, f.state, result.dialogue.id).data;
    assert.equal(data.time, '09:00', phrase);
    assert.equal(data.duration, 720, phrase);
    assert.equal(data.durationSource, 'manual', phrase);
    assert.equal(result.dialogue.step, 'review', phrase);
    assert.equal(f.patients[0].appointments.length, 0);
  }
  for (const phrase of ['измени длительность процедуры на 45 минут', 'длительность 45 минут', 'прием длится 45 минут', 'на полчаса']) {
    const f = dialogueFixture(); f.start({ query: 'Анну Семенову', serviceQuery: 'Чистка', date: day, time: '10:00' });
    f.answer({ text: phrase });
    assert.equal(current(f).data.time, '10:00', phrase);
    assert.equal(current(f).data.duration, phrase === 'на полчаса' ? 30 : 45, phrase);
    assert.equal(current(f).data.durationSource, 'manual', phrase);
    assert.equal(f.patients[0].appointments.length, 0);
  }
});

test('an actual model-assisted followup drops ungrounded duration720 while accepting the proven clock and service60', () => {
  const f = dialogueFixture(); f.services[0].duration = 60;
  f.start({ query: 'Анну Семенову', serviceQuery: 'Чистка', date: day, time: '10:00' });
  const before = structuredClone(current(f).data);
  const body = { dialogueId: f.result.dialogue.id, dialogueVersion: f.result.dialogue.version,
    text: 'Поменяй начало приема на 12 часов.' };
  const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
  assert.ok(snapshot, 'This deliberately non-local wording exercises the model continuation boundary');
  const result = f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock,
    proposal({ time: '12:00', duration: 720 }), snapshot);
  const data = f.flow.get(f.c, f.member, f.state, result.dialogue.id).data;
  assert.equal(data.time, '12:00');
  assert.equal(data.duration, 60);
  assert.equal(data.durationSource, 'service');
  assert.equal(data.service.id, 'clean');
  assert.deepEqual(data.patient, before.patient);
  assert.equal(data.date, before.date);
  assert.equal(result.dialogue.step, 'review');
  assert.equal(result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('an invalid whole clock is clarified rather than silently becoming a one-day service override', () => {
  for (const value of ['24', '25']) {
    const text = 'Запиши прием на ' + value + ' часов';
    assert.equal(parseTimeText('на ' + value + ' часов'), null);
    const result = bookingTemporalConstraints(intent, text, clock);
    assert.equal(result.time, null, text);
    assert.equal(result.duration, undefined, text);
  }
  assert.deepEqual(intentRequestConstraints(intent, 'Запиши прием длительностью 24 часа'), { duration: 1440 });
  assert.equal(intentRequestConstraints(intent, 'Запиши прием длительностью 25 часов').requireDuration, true);
});

test('model duration clarification context cannot also reinterpret the answer as a new starting clock', () => {
  const entry = { step: 'duration', data: { date: day, time: '09:00', durationSource: 'required' }, options: new Map() };
  const result = continuationOperation(proposal({ duration: 720 }), { text: 'на 12 часов' }, entry, clock);
  assert.equal(result.kind, 'modelPatch');
  assert.deepEqual(result.edits, [{ field: 'duration', text: '720' }]);
});

test('invalid length modifiers alternatives and relative shifts cannot silently overwrite a catalog length', () => {
  for (const phrase of ['на один час шестьдесят минут', 'длительностью 7 минут', 'длительностью 30 минут или 45 минут'])
    assert.equal(intentRequestConstraints(intent, 'Запиши Анну завтра ' + phrase).requireDuration, true, phrase);
  for (const phrase of ['на 12 часов или на 13 часов', 'примерно на 12 часов']) {
    const result = bookingTemporalConstraints(intent, 'Запиши Анну завтра ' + phrase, clock);
    assert.equal(result.duration, undefined, phrase);
    assert.equal(result.time, null, phrase);
  }
  assert.deepEqual(repairOperation({ step: 'time', data: { date: day, time: '10:00' }, options: new Map() },
    'на два часа позже', clock), { kind: 'shiftTime', minutes: 120 });
});


test('readonly availability keeps a window length distinct from an explicit starting-time followup', () => {
  const { applySearchRepair } = require('../src/server/modules/assistant/dialogue/dialogue-search-repair.cjs');
  assert.deepEqual(intentRequestConstraints({ intent: 'availability' }, 'Найди окно завтра на два часа'), { duration: 120 });
  const entry = { step: 'availability', data: { date: day, time: '10:00', duration: 30 },
    availabilitySearch: { intent: { intent: 'availability', date: day, duration: 30, time: '10:00' } }, options: new Map() };
  const length = continuationOperation(proposal({ duration: 120 }), { text: 'Подбери окно на два часа' }, entry, clock);
  assert.deepEqual(length.edits, [{ field: 'duration', text: '120' }]);
  applySearchRepair(entry, { kind: 'patch', edits: length.edits }, clock);
  assert.equal(entry.availabilitySearch.intent.duration, 120);
  assert.equal(entry.availabilitySearch.intent.time, '10:00');
  const initialLength = entry.availabilitySearch.intent.duration;
  const start = continuationOperation(proposal({ time: '12:00', duration: 720 }), { text: 'Время на 12 часов' }, entry, clock);
  assert.deepEqual(start.edits, [{ field: 'time', text: '12:00' }]);
  applySearchRepair(entry, { kind: 'patch', edits: start.edits }, clock);
  assert.equal(entry.availabilitySearch.intent.time, '12:00');
  assert.equal(entry.availabilitySearch.intent.duration, initialLength);
  assert.throws(() => continuationOperation(proposal({ duration: 120, time: '14:00' }),
    { text: 'Подбери окно на два часа' }, entry, clock), { status: 400 });
});
