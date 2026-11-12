const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const emptyFields = () => ({
  client: null,
  staff: null,
  service: null,
  date: null,
  time: null,
  duration: null,
});
function fixture({ role = 'owner', query = 'Гульнара', duration = 45 } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = 'cosmetologist';
  const ticket = f.flow.beginCommand(f.c, f.member, f.state);
  let result = f.flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query,
      serviceQuery: 'Чистка',
      date: day,
      time: '10:00',
      duration,
    },
    f.state,
    f.member,
    f.clock,
    ticket,
    { openWhenComplete: true },
  );
  const body = (raw) => ({
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    text: raw,
  });
  const entry = () => f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  return {
    ...f,
    get result() {
      return result;
    },
    entry,
    model(raw, proposal) {
      const request = body(raw);
      const snapshot = f.flow.prepareModelTurn(f.c, request, f.state, f.member, f.clock);
      assert.ok(snapshot, 'synthetic model clarification must have an active snapshot');
      result = f.flow.applyModelTurn(f.c, request, f.state, f.member, f.clock, proposal, snapshot);
      return result;
    },
    text(raw) {
      result = f.flow.continueDialogue(f.c, body(raw), f.state, f.member, f.clock);
      return result;
    },
  };
}
const clarify = (field) => ({ operation: 'clarify', fields: emptyFields(), choice: null, field });
const patch = (fields) => ({
  operation: 'patch',
  fields: { ...emptyFields(), ...fields },
  choice: null,
  field: null,
});
const saved = (entry) => ({
  date: entry.data.date,
  time: entry.data.time,
  duration: entry.data.duration,
  durationSource: entry.data.durationSource,
  staff: entry.data.staff?.id,
  service: entry.data.service?.id,
  serviceQuery: entry.data.serviceQuery,
  serviceChosen: entry.data.serviceChosen,
});
const noSave = (f) => assert.ok(f.patients.every((patient) => patient.appointments.length === 0));
const assertForm = (f, result) => {
  assert.equal(result.action?.type, 'prepareAppointment');
  assert.equal(result.action.patientId, f.patients[0].id);
  assert.equal(result.action.date, day);
  assert.equal(result.action.time, '10:00');
  assert.equal(result.action.duration, 45);
  noSave(f);
};

for (const role of ['owner', 'salon_admin', 'cosmetologist'])
  test(
    role +
      ': unknown client and irrelevant model questions retain all known slots until the literal corrected name opens the form',
    () => {
      for (const field of ['date', 'service', 'duration', 'staff']) {
        const f = fixture({ role });
        assert.equal(f.result.dialogue.step, 'client');
        assert.equal(f.result.dialogue.options.length, 0);
        const before = saved(f.entry());
        const question = f.model('Гульнара', clarify(field));
        assert.equal(question.dialogue.step, 'client', field);
        assert.doesNotMatch(
          question.text,
          /какую.*дат|назовите услугу|сколько минут|назовите специалиста/iu,
        );
        assert.deepEqual(saved(f.entry()), before);
        assert.equal(f.entry().data.patient, null);
        noSave(f);
        const ready = f.model('Анна Семёнова', patch({ client: 'Анна Семёнова' }));
        assertForm(f, ready);
      }
    },
  );

test('model clarify client retains fresh approximate choices instead of replacing them with an empty generic question', () => {
  const f = fixture({ query: 'Анна Семёнофа' });
  assert.equal(f.result.dialogue.options.length, 1);
  const before = saved(f.entry());
  const result = f.model('Это точно нужный клиент?', clarify('client'));
  assert.equal(result.dialogue.step, 'client');
  assert.equal(result.dialogue.phase, 'clientChoice');
  assert.equal(result.dialogue.options.length, 1);
  assert.equal(result.dialogue.prompt, 'Анна Семёнова, верно?');
  assert.deepEqual(saved(f.entry()), before);
  assert.equal(f.entry().data.patient, null);
  assertForm(f, f.text('да'));
});

test('an explicitly impossible date is cleared while all other known slots survive and only actual missing fields are asked', () => {
  const f = fixture();
  const before = saved(f.entry());
  const result = f.model('на 32 октября 2099 года', clarify('date'));
  assert.equal(result.dialogue.step, 'client');
  assert.equal(f.entry().data.date, null);
  assert.equal(f.entry().data.time, before.time);
  assert.equal(f.entry().data.service.id, before.service);
  assert.equal(f.entry().data.duration, before.duration);
  const corrected = f.model('Анна Семёнова', patch({ client: 'Анна Семёнова' }));
  assert.equal(corrected.action, null);
  assert.equal(corrected.dialogue.step, 'date');
  assertForm(f, f.text(day));
});

test('an explicitly impossible time is cleared without losing the client-independent date, catalog service or duration', () => {
  const f = fixture();
  const before = saved(f.entry());
  const result = f.model('в 25:99', clarify('time'));
  assert.equal(result.dialogue.step, 'client');
  assert.equal(f.entry().data.time, null);
  assert.equal(f.entry().data.date, before.date);
  assert.equal(f.entry().data.service.id, before.service);
  assert.equal(f.entry().data.duration, before.duration);
  const corrected = f.model('Анна Семёнова', patch({ client: 'Анна Семёнова' }));
  assert.equal(corrected.action, null);
  assert.equal(corrected.dialogue.step, 'time');
  assertForm(f, f.text('в 10:00'));
});

test('model fields without raw proof cannot replace known slots or partially select a different client', () => {
  const f = fixture();
  const before = saved(f.entry());
  const rejected = f.model(
    'Анна Семёнова',
    patch({ client: 'Анна Семёнова', date: '2099-01-06', time: '11:00', service: 'Чистка' }),
  );
  assert.equal(rejected.dialogue.step, 'client');
  assert.deepEqual(saved(f.entry()), before);
  assert.equal(f.entry().data.patient, null);
  noSave(f);
  assertForm(f, f.model('Анна Семёнова', patch({ client: 'Анна Семёнова' })));
});

test('name alternatives never erase unrelated temporal or catalog facts and never assign the first client', () => {
  const f = fixture();
  const before = saved(f.entry());
  const result = f.model('Анна или Ольга', clarify('date'));
  assert.equal(result.dialogue.step, 'client');
  assert.deepEqual(saved(f.entry()), before);
  assert.equal(f.entry().data.patient, null);
  noSave(f);
  assertForm(f, f.model('Анна Семёнова', patch({ client: 'Анна Семёнова' })));
});

test('fresh reference revocation still removes an unavailable service without discarding the proven date and time', () => {
  const f = fixture();
  f.services.splice(0);
  f.changed();
  assert.throws(() => f.model('Гульнара', clarify('date')), { status: 409 });
  const result = f.text('Гульнара');
  assert.equal(result.dialogue.step, 'client');
  assert.equal(f.entry().data.service, null);
  assert.equal(f.entry().data.serviceChosen, false);
  assert.equal(f.entry().data.date, day);
  assert.equal(f.entry().data.time, '10:00');
  noSave(f);
});

test('only a whole explicit user request can refocus a known field and premature ready cannot prepare the form', () => {
  const {
    rawClarificationTarget,
  } = require('../src/server/modules/assistant/dialogue/dialogue-clarification-target.cjs');
  for (const raw of [
    'Я не уверен, уточни специалиста',
    'уточните специалиста',
    'давай проверим сотрудника',
  ])
    assert.equal(rawClarificationTarget(raw), 'staff');
  for (const raw of [
    'Гульнара',
    'не записывай',
    'не Полина, а Анна',
    'если не уверен, уточни специалиста',
    'уточни специалиста или услугу',
    'уточни специалиста и отмени запись',
  ])
    assert.equal(rawClarificationTarget(raw), null, raw);
  const f = fixture();
  const before = saved(f.entry());
  const result = f.model('Я не уверен, уточни специалиста', clarify('date'));
  assert.equal(result.dialogue.step, 'staff');
  assert.deepEqual(saved(f.entry()), before);
  noSave(f);
  const premature = f.text('запиши');
  assert.equal(premature.action, null);
  assert.ok(premature.dialogue);
  assert.deepEqual(saved(f.entry()), before);
  noSave(f);
});

test('a split negative name can request client confirmation while retaining every other known slot and without automatic handoff', () => {
  const {
    rawClarificationTarget,
  } = require('../src/server/modules/assistant/dialogue/dialogue-clarification-target.cjs');
  assert.equal(rawClarificationTarget('не Полина'), 'client');
  const f = fixture();
  const before = saved(f.entry());
  const result = f.model('не Полина', clarify('date'));
  assert.equal(result.dialogue.step, 'client');
  assert.equal(result.action, null);
  assert.deepEqual(saved(f.entry()), before);
  assert.equal(f.entry().data.patient, null);
  noSave(f);
});
