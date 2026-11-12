const test = require('node:test');
const assert = require('node:assert/strict');
const { queryNameAnchor } = require('../src/server/modules/assistant/language/names/name-query-anchor.cjs');
const { nameSuggestionPlan, rankNameSuggestions, SUGGESTION_LIMITS } = require('../src/server/modules/assistant/language/names/name-suggestions.cjs');
const { resolveClient, suggestClientMatches } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { initialEntities } = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const { createClientCardFlow, cardSourceQuery } = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const { createDialogueStore } = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const person = (id, firstName, lastName, middleName = '') => ({ id, firstName, lastName, middleName, name: [firstName, middleName, lastName].filter(Boolean).join(' '), phone: '', createdBy: 'owner', appointments: [] });
const rows = () => [
  person('alena', 'Алёна', 'Петрова', 'Игоревна'),
  person('alexey', 'Алексей', 'Иванов', 'Петрович'),
  person('elena', 'Елена', 'Петрова', 'Сергеевна'),
];
const rank = (patients, raw) => rankNameSuggestions(patients, nameSuggestionPlan(raw)).map(row => row.id);
function cardFixture(patients, role = 'owner') {
  const f = dialogueFixture({ role });
  f.state.policy.commands.clients = true;
  f.patients.splice(0, f.patients.length, ...patients);
  const memory = createDialogueStore(), flow = createClientCardFlow({ memory });
  let reply;
  return {
    ...f,
    start(query, raw) {
      const ticket = memory.beginCommand(f.c, f.member, f.state);
      return reply = flow.start(f.c, { intent: 'clientCard', query }, f.state, f.member, f.clock, ticket, raw);
    },
    answer(operation) {
      return reply = flow.continueDialogue(f.c, { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, ...operation }, f.state, f.member, f.clock);
    },
  };
}

// Prepared from the reported Алёна Петровна / Алексей alias collision; not executed here.
test('an exact raw given name anchors the whole query before fuzzy first-name alias and patronymic ranking', () => {
  const patients = rows(), before = JSON.stringify(patients);
  for (const raw of ['Алёна Петровна', 'Алена Петровна', 'Петровна Алёна', 'Алёну Петровну', 'Петровну Алёну']) {
    assert.deepEqual(rank(patients, raw), ['alena'], raw);
    const anchor = queryNameAnchor(patients, nameSuggestionPlan(raw));
    assert.equal(anchor.conflict, false);
    assert.equal(anchor.words.length, 1);
  }
  assert.equal(JSON.stringify(patients), before);
});

test('the declared Алексей alias remains exact only for Алёша and cannot absorb the distinct given Алёна', () => {
  const patients = rows();
  assert.deepEqual(rank(patients, 'Алёша Петрович Ивонов'), ['alexey']);
  assert.deepEqual(rank(patients, 'Алёна Петровна'), ['alena']);
  assert.deepEqual(rank(patients, 'Елена Петровна'), ['elena']);
});

test('query-wide first-name evidence cannot be reassigned to a different FIO field to rescue a candidate', () => {
  const patients = [
    person('wanted', 'Алёна', 'Петрова'),
    person('wrong-given', 'Алексей', 'Иванов', 'Петрович'),
  ];
  const anchor = queryNameAnchor(patients, nameSuggestionPlan('Алёна Петровна'));
  assert.deepEqual(anchor.words, ['алена']);
  assert.deepEqual(rank(patients, 'Алёна Петровна'), ['wanted']);
  assert.deepEqual(rank(patients, 'Алёна Алёна Петровна'), [], 'one complete name token cannot satisfy two source tokens');
});

test('unlisted structured given names anchor in either source order without extending a static name dictionary', () => {
  const patients = [person('wanted', 'Эсмеральда', 'Петрова'), person('wrong', 'Эсмеральта', 'Петрова')];
  for (const raw of ['Эсмеральду Петровну', 'Петровну Эсмеральду'])
    assert.deepEqual(rank(patients, raw), ['wanted'], raw);
});

test('a shared exact short given-name form keeps its candidate ambiguity rather than choosing a canonical family', () => {
  const patients = [person('male', 'Александр', 'Соколов'), person('female', 'Александра', 'Соколова')];
  assert.deepEqual(new Set(rank(patients, 'Саша Соколоа')), new Set(['male', 'female']));
  assert.deepEqual(rank(patients, 'Александр Соколоа'), ['male']);
});

test('a source component present in different real FIO fields is unresolved in both source orders', () => {
  const patients = [person('given', 'Алёна', 'Петрова'), person('family', 'Ольга', 'Алёна')];
  for (const raw of ['Алёна Петровна', 'Петровна Алёна']) {
    assert.equal(queryNameAnchor(patients, nameSuggestionPlan(raw)).conflict, true);
    assert.deepEqual(rank(patients, raw), []);
  }
});

test('a declared family-field collision cannot be retyped as a given name using raw word position', () => {
  const f = cardFixture([person('given', 'Алёна', 'Петрова'), person('family', 'Ольга', 'Алёна')]);
  for (const raw of ['Алёна Петровна', 'Петровна Алёна']) {
    const reply = f.start(raw, 'Открой карточку ' + raw);
    assert.equal(reply.action, null);
    assert.equal(reply.dialogue.options.length, 0);
    assert.match(reply.dialogue.prompt, /имя.*фамили|полное имя/iu);
  }
});

test('a typo in an unanchored first name remains confirmation-only under the previous edit budget', () => {
  assert.deepEqual(rank([person('wanted', 'Аделина', 'Соколова')], 'Адлеина Соколова'), ['wanted']);
  assert.deepEqual(rank([person('short', 'Иван', 'Левина')], 'Ивна Левина'), []);
  assert.deepEqual(rank([person('surname', 'Анна', 'Левина')], 'Анна Елвниа'), []);
  assert.deepEqual(rank([person('near', 'Анна', 'Левина'), person('literal', 'Анна', 'Левниа')], 'Анна Левниа'), ['literal', 'near']);
  assert.deepEqual([SUGGESTION_LIMITS.queries, SUGGESTION_LIMITS.perQuery, SUGGESTION_LIMITS.candidates, SUGGESTION_LIMITS.results], [8, 50, 200, 5]);
});

test('source grounding keeps the original imperfect surname rather than replacing it with a proposed canonical name', () => {
  const raw = 'Запиши Алёну Петровну на Чистку на сегодня в 14:30.';
  const grounded = initialEntities({ intent: 'prepareAppointment', query: 'Алёна Петрова', serviceQuery: 'Чистка', date: day, time: '14:30' }, raw, { date: day, time: '14:30' });
  assert.equal(grounded.query, 'Алёну Петровну');
  assert.equal(grounded.serviceQuery, 'Чистку');
  assert.equal(grounded.date, day);
  assert.equal(grounded.time, '14:30');
  assert.equal(cardSourceQuery('Открой карточку Алёны Петровны.', 'Алёна Петрова'), 'Алёны Петровны');
});

for (const role of ['owner', 'salon_admin', 'cosmetologist'])
  test('a ' + role + ' must explicitly confirm the approximate surname while all booking fields survive and no record is written', () => {
    const f = dialogueFixture({ role });
    if (role === 'cosmetologist') f.members[0].role = role;
    f.patients.splice(0, f.patients.length, ...rows());
    const before = JSON.stringify(f.patients), ticket = f.flow.beginCommand(f.c, f.member, f.state);
    const reply = f.flow.start(f.c, { intent: 'prepareAppointment', query: 'Алёна Петровна', serviceQuery: 'Чистка', date: day, time: '14:30' }, f.state, f.member, f.clock, ticket, { openWhenComplete: true });
    assert.equal(reply.action, null);
    assert.equal(reply.dialogue.step, 'client');
    const entry = f.flow.get(f.c, f.member, f.state, reply.dialogue.id);
    assert.deepEqual([...entry.options.values()].map(choice => choice.value), ['alena']);
    assert.ok([...entry.options.values()].every(choice => choice.approximate === true));
    const ready = f.flow.continueDialogue(f.c, { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, text: 'да' }, f.state, f.member, f.clock);
    assert.equal(ready.action.type, 'prepareAppointment');
    assert.equal(ready.action.patientId, 'alena');
    assert.deepEqual(ready.action.serviceIds, ['clean']);
    assert.equal(ready.action.date, day);
    assert.equal(ready.action.time, '14:30');
    assert.equal(ready.action.duration, 30);
    assert.equal(JSON.stringify(f.patients), before);
  });

test('card resolution keeps the clientCard goal and opens only the explicitly confirmed anchored identity', () => {
  const f = cardFixture(rows()), before = JSON.stringify(f.patients);
  const reply = f.start('Алёна Петрова', 'Открой карточку Алёны Петровны.');
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.options.length, 1);
  assert.equal(reply.dialogue.prompt, 'Петрова?');
  assert.match(reply.dialogue.options[0].label, /Алёна/);
  assert.doesNotMatch(reply.dialogue.prompt, /Алексей|Елена/);
  assert.deepEqual(f.answer({ text: 'да' }).action, { type: 'clientCard', patientId: 'alena' });
  assert.equal(JSON.stringify(f.patients), before);
});

test('fresh ACL and name changes cannot turn a previously offered anchored client into another person', () => {
  for (const change of ['remove', 'rename', 'revoke']) {
    const f = cardFixture(rows(), change === 'revoke' ? 'cosmetologist' : 'owner'), reply = f.start('Алёна Петровна', 'Открой карточку Алёна Петровна');
    const body = { choice: reply.dialogue.options[0].id };
    if (change === 'remove') f.patients.splice(0, 1);
    else if (change === 'rename') f.patients[0].firstName = 'Алексей';
    else f.patients[0].createdBy = 'other-staff';
    assert.throws(() => f.answer(body), error => error.status === 409);
    assert.ok(f.patients.every(patient => patient.appointments.length === 0));
  }
});

test('candidate anchors are built only from ACL-visible summaries and never make an inaccessible given-name owner selectable', () => {
  const f = dialogueFixture({ role: 'cosmetologist' });
  f.patients.splice(0, f.patients.length, person('hidden', 'Алёна', 'Петрова'), person('visible', 'Алексей', 'Иванов', 'Петрович'));
  f.patients[0].createdBy = 'other-staff';
  const result = suggestClientMatches(f.c, 'Алёна Петровна');
  assert.ok(!result.matches.some(patient => patient.id === 'hidden'));
  assert.equal(result.approximate, true);
  assert.equal(resolveClient(f.c, 'Алёна Петровна').matches.length, 0);
  assert.ok(f.patients.every(patient => patient.appointments.length === 0));
});


test('ordinary full-name retrieval fairly retains literal ё anchors within eight queries even behind a strongly wrong surname', () => {
  for (const raw of ['Алена Ухабистонова', 'Ухабистонова Алена', 'Алена Игоревна Ухабистонова']) {
    const f = dialogueFixture();
    f.patients.splice(0, f.patients.length, person('wanted', 'Алёна', 'Петрова', 'Игоревна'), person('wrong', 'Алексей', 'Ухабистонова'));
    const before = JSON.stringify(f.patients), plan = nameSuggestionPlan(raw);
    assert.ok(plan.queries.includes('алён'), 'stored Алёна must enter the same bounded pool for ' + raw);
    assert.ok(plan.queries.length <= 8);
    assert.deepEqual(suggestClientMatches(f.c, raw).matches, [], 'the exact given name excludes Алексей but the unheard surname cannot be silently discarded');
    assert.equal(JSON.stringify(f.patients), before);
  }
});

test('unstructured legacy display text cannot create a structured given-name anchor', () => {
  const legacy = { id: 'legacy', name: 'Алёна Игоревна Петрова', phone: '', appointments: [] };
  assert.deepEqual(queryNameAnchor([legacy], nameSuggestionPlan('Алёна Петровна')), { words: [], conflict: false });
});

test('shared Женя aliases retain both current first-name families while an explicit formal name remains exact', () => {
  const patients = [person('male', 'Евгений', 'Соколов'), person('female', 'Евгения', 'Соколова')];
  assert.deepEqual(new Set(rank(patients, 'Женя Соколоа')), new Set(['male', 'female']));
  assert.deepEqual(rank(patients, 'Евгений Соколоа'), ['male']);
});

test('contradicting complete given and family evidence proposes another surname owner only for an explicit current choice', () => {
  const f = cardFixture([person('given', 'Гульнара', 'Мухамедьянова'), person('family', 'Юлия', 'Неволина')]);
  const before = JSON.stringify(f.patients), reply = f.start('Гульнары Неволиной', 'Открой карточку Гульнары Неволиной');
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.options.length, 1);
  assert.equal(reply.dialogue.prompt, 'Неволина: Юлия?');
  assert.equal(f.answer({ text: 'Гульнара' }).action, null);
  assert.equal(f.answer({ text: 'Неволина' }).action, null);
  assert.deepEqual(f.answer({ text: 'Юлия' }).action, { type: 'clientCard', patientId: 'family' });
  assert.equal(JSON.stringify(f.patients), before);
});
