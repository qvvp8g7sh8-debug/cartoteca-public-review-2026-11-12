const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
function fixture({ duplicate = false } = {}) {
  const f = dialogueFixture();
  f.patients.push({
    id: 'alla',
    firstName: 'Алла',
    middleName: 'Ивановна',
    lastName: 'Семёнова',
    name: 'Алла Ивановна Семёнова',
    phone: '+79990001031',
    createdBy: 'owner',
    appointments: [],
  });
  if (duplicate)
    f.patients.push({
      id: 'alla-other',
      firstName: 'Алла',
      middleName: 'Александровна',
      lastName: 'Семёнова',
      name: 'Алла Александровна Семёнова',
      phone: '+79990001032',
      createdBy: 'owner',
      appointments: [],
    });
  f.services.splice(0, f.services.length, {
    id: 'plasma',
    name: 'Плазмалифтинг',
    duration: 45,
    staffId: 'owner',
  });
  f.changed();
  return f;
}
const entry = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
const noSave = (f) => assert.ok(f.patients.every((row) => row.appointments.length === 0));
function initial(f, raw, query = 'Алла Семёнова') {
  const model = { intent: 'prepareAppointment', query, serviceQuery: 'Плазмолифтинг' };
  const constraints = bookingTemporalConstraints(model, raw, f.clock);
  return f.start(initialEntities(model, raw, constraints), {
    ...constraints,
    openWhenComplete: true,
  });
}
function assertDateOnly(f, result) {
  assert.equal(result.dialogue.step, 'date');
  assert.equal(result.dialogue.phase, 'date');
  assert.equal(entry(f).data.patient.id, 'alla');
  assert.equal(entry(f).data.service.id, 'plasma');
  assert.equal(entry(f).data.duration, 45);
  assert.equal(result.action, null);
  assert.doesNotMatch(result.text, /верно|правильно|имеете в виду|Выберите.*(?:клиент|услуг)/iu);
  noSave(f);
}

test('an exact inflected first and last name without the stored patronymic plus a whole service asks only for the date', () => {
  for (const raw of [
    'Запиши Аллу Семенову на плазмолифтинг.',
    'Запиши Аллу Семёнову на Плазмолифтинг.',
    'На плазмолифтинг запиши Аллу Семенову.',
  ]) {
    const f = fixture();
    const result = initial(f, raw);
    assertDateOnly(f, result);
    f.answer({ text: day });
    assert.equal(f.result.dialogue.step, 'time');
    assert.equal(entry(f).data.patient.id, 'alla');
    assert.equal(entry(f).data.service.id, 'plasma');
    const ready = f.answer({ text: 'В12:30' }).result;
    assert.equal(ready.dialogue, null);
    assert.equal(ready.action.patientId, 'alla');
    assert.deepEqual(ready.action.serviceIds, ['plasma']);
    assert.equal(ready.action.duration, 45);
    assert.equal(ready.action.time, '12:30');
    noSave(f);
  }
});

test('the complete command with date and time opens one checked action without asking to confirm a unique exact pair or service', () => {
  const f = fixture();
  const raw = 'На 5 января 2099 года в12:30 на плазмолифтинг запиши Аллу Семенову.';
  const result = initial(f, raw);
  assert.equal(result.dialogue, null);
  assert.equal(result.action.patientId, 'alla');
  assert.deepEqual(result.action.serviceIds, ['plasma']);
  assert.equal(result.action.duration, 45);
  assert.equal(result.action.date, day);
  assert.equal(result.action.time, '12:30');
  noSave(f);
});

test('an exact service continuation after a unique first-last match does not add a patronymic or service confirmation', () => {
  for (const text of ['Плазмолифтинг', 'на плазмолифтинг']) {
    const f = fixture();
    f.start({ query: 'Аллу Семенову' }, { openWhenComplete: true });
    assert.equal(f.result.dialogue.step, 'service');
    assert.equal(entry(f).data.patient.id, 'alla');
    const body = {
      policyVersion: f.state.revision,
      dialogueId: f.result.dialogue.id,
      dialogueVersion: f.result.dialogue.version,
      text,
    };
    assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
    assertDateOnly(f, f.answer({ text }).result);
  }
});

test('two cards sharing first and last names but differing in patronymic still require an exact clarification', () => {
  const f = fixture({ duplicate: true });
  const result = initial(f, 'Запиши Аллу Семенову на плазмолифтинг.');
  assert.equal(result.dialogue.step, 'client');
  assert.equal(result.dialogue.options.length, 2);
  assert.equal(entry(f).data.patient, null);
  assert.equal(result.action, null);
  const repeat = f.answer({ text: 'Да' }).result;
  assert.equal(repeat.dialogue.step, 'client');
  assert.equal(entry(f).data.patient, null);
  assert.equal(repeat.action, null);
  const selected = f.answer({ text: 'Алла Ивановна Семёнова' }).result;
  assertDateOnly(f, selected);
});
