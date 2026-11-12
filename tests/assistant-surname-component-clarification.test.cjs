const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { createDialogueStore } = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const { createClientCardFlow } = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const { clientComponentPlan } = require('../src/server/modules/assistant/language/names/client-name-components.cjs');
const { searchPlan } = require('../src/server/modules/assistant/language/names/name-matching.cjs');
const person = (id, firstName, lastName, middleName = 'Игоревна') => ({
  id, firstName, lastName, middleName, name: [firstName, middleName, lastName].join(' '),
  phone: '', appointments: [], createdBy: 'owner',
});
function fixture({ kind = 'booking', role = 'owner', singleton = false } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = 'cosmetologist';
  f.state.policy.commands.clients = true;
  f.patients.splice(0, f.patients.length,
    person('alena', 'Алёна', 'Петрова'), person('ksenia', 'Ксения', 'Ковалёва'),
    ...(singleton ? [] : [person('oksana', 'Оксана', 'Ковалёва')]));
  const memory = kind === 'card' ? createDialogueStore() : f.flow;
  const flow = kind === 'card' ? createClientCardFlow({ memory }) : f.flow;
  let reply;
  return {
    ...f, kind,
    start(query = 'Алёна Ковалёва') {
      const ticket = memory.beginCommand(f.c, f.member, f.state);
      const intent = kind === 'card' ? { intent: 'clientCard', query } : {
        intent: 'prepareAppointment', query, serviceQuery: 'Чистка',
        date: day, time: '14:30', staffQuery: 'Тестовый Специалист',
      };
      reply = kind === 'card'
        ? flow.start(f.c, intent, f.state, f.member, f.clock, ticket, 'Открой карточку ' + query)
        : flow.start(f.c, intent, f.state, f.member, f.clock, ticket, { openWhenComplete: true });
      return reply;
    },
    answer(operation) {
      reply = flow.continueDialogue(f.c, {
        policyVersion: f.state.revision, dialogueId: reply.dialogue.id,
        dialogueVersion: reply.dialogue.version, ...operation,
      }, f.state, f.member, f.clock);
      return reply;
    },
    entry() { return memory.get(f.c, f.member, f.state, reply.dialogue.id); },
    get reply() { return reply; },
  };
}
function assertQuestion(reply, count = 2) {
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.step, 'client');
  assert.equal(reply.dialogue.phase, 'clientChoice');
  assert.equal(reply.dialogue.options.length, count);
  if (count) {
    assert.match(reply.dialogue.prompt, /Ковал[её]в/iu);
    assert.match(reply.dialogue.prompt, /Ксени/iu);
    if (count === 2) assert.match(reply.dialogue.prompt, /Оксан/iu);
  }
  assert.doesNotMatch(reply.dialogue.prompt, /вариант|назовите номер|первый|второй/iu);
}
function assertBooking(reply) {
  assert.equal(reply.dialogue, null);
  assert.equal(reply.action.type, 'prepareAppointment');
  assert.equal(reply.action.patientId, 'ksenia');
  assert.equal(reply.action.staffId, 'owner');
  assert.equal(reply.action.date, day);
  assert.equal(reply.action.time, '14:30');
  assert.equal(reply.action.duration, 30);
  assert.deepEqual(reply.action.serviceIds, ['clean']);
}
function choiceFor(reply, name = 'Ксения') {
  const choice = reply.dialogue.options.find(row => row.label.includes(name));
  assert.ok(choice, 'a named current choice must be offered');
  return choice.id;
}
for (const query of ['Алёна Ковалёва', 'Ковалеву Алёну', 'Алёны Ковалевой',
  'Алёна Игоревна Ковалёва', 'Ковалевой Алены Игоревны']) {
  test('conflicting exact name components ask for a named person and retain booking fields: ' + query, () => {
    const f = fixture(), before = JSON.stringify(f.patients), first = f.start(query);
    assertQuestion(first);
    const fields = new Map(first.dialogue.fields.map(row => [row.key, row.value]));
    assert.equal(fields.get('date'), day);
    assert.equal(fields.get('time'), '14:30');
    assert.equal(fields.get('service'), 'Чистка');
    assert.equal(fields.get('duration'), '30 мин');
    assert.equal(f.entry().data.clientQuery, query);
    assertBooking(f.answer({ text: 'Ксения' }));
    assert.equal(JSON.stringify(f.patients), before);
  });
}
for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
  test(role + ' explicitly chooses the current named person without changing the permitted specialist', () => {
    const f = fixture({ role }), before = JSON.stringify(f.patients);
    assertQuestion(f.start());
    assertBooking(f.answer({ text: 'Ксению' }));
    assert.equal(JSON.stringify(f.patients), before);
  });
}
test('card resolution keeps its original action and opens only the named confirmed current identity', () => {
  const f = fixture({ kind: 'card' }), before = JSON.stringify(f.patients);
  assertQuestion(f.start('Ковалевой Алёны'));
  assert.deepEqual(f.answer({ text: 'Ксения' }).action, { type: 'clientCard', patientId: 'ksenia' });
  assert.equal(JSON.stringify(f.patients), before);
});
for (const kind of ['booking', 'card']) {
  test(kind + ' does not select from repeated surname, unknown single name or an ambiguous yes', () => {
    const f = fixture({ kind }), before = JSON.stringify(f.patients);
    assertQuestion(f.start());
    const originalQuery = f.entry().data.clientQuery;
    const anchor = structuredClone(f.entry().data.clientComponentAnchor);
    const fields = structuredClone(f.reply.dialogue.fields);
    for (const [index, text] of ['Ковалёва', 'Татьяна', 'да'].entries()) {
      const reply = f.answer({ text });
      assert.equal(reply.action, null);
      assert.equal(reply.dialogue.step, 'client');
      assert.equal(reply.dialogue.phase, 'clientChoice');
      assert.equal(reply.dialogue.options.length, 2);
      assert.ok(reply.dialogue.options.some(row => /Ксения.*Ковал[её]ва/u.test(row.label)));
      assert.ok(reply.dialogue.options.some(row => /Оксана.*Ковал[её]ва/u.test(row.label)));
      assert.deepEqual(reply.dialogue.fields, fields);
      assert.deepEqual(f.entry().data.clientComponentAnchor, anchor);
      assert.equal(f.entry().data.clientQuery, originalQuery);
      assert.equal(reply.dialogue.manualInputRequired === true, index === 2);
    }
    assert.equal(JSON.stringify(f.patients), before);
  });
  test(kind + ' still asks for one alternative by name and a clear yes confirms that named person', () => {
    const f = fixture({ kind, singleton: true }), before = JSON.stringify(f.patients);
    assertQuestion(f.start(), 1);
    assertQuestion(f.answer({ text: 'Ковалёва' }), 1);
    const reply = f.answer({ text: 'да' });
    if (kind === 'booking') assertBooking(reply);
    else assert.deepEqual(reply.action, { type: 'clientCard', patientId: 'ksenia' });
    assert.equal(JSON.stringify(f.patients), before);
  });
}
test('a heard patronymic remains an exact constraint rather than being discarded with the wrong given name', () => {
  const f = fixture();
  f.patients.find(row => row.id === 'oksana').middleName = 'Павловна';
  assertQuestion(f.start('Алёна Игоревна Ковалёва'), 1);
  assertBooking(f.answer({ text: 'Ксения' }));
  const impossible = fixture();
  impossible.patients.find(row => row.id === 'ksenia').middleName = 'Павловна';
  impossible.patients.find(row => row.id === 'oksana').middleName = 'Павловна';
  assertQuestion(impossible.start('Алёна Игоревна Ковалёва'), 0);
});
test('a shared short-name family does not pick gender or a canonical given name for the user', () => {
  const f = fixture({ kind: 'card' });
  f.patients.splice(0, 1, person('alexander', 'Александр', 'Петров', 'Игоревич'),
    person('alexandra', 'Александра', 'Смирнова'));
  assertQuestion(f.start('Саша Ковалёва'));
  assert.deepEqual(f.answer({ text: 'Ксения' }).action, { type: 'clientCard', patientId: 'ksenia' });
});
for (const kind of ['booking', 'card']) {
  for (const change of ['selected-name', 'other-name', 'hidden-selected', 'new-exact', 'new-alternative']) {
    test(kind + ' rejects a stale current choice after ' + change, () => {
      const f = fixture({ kind, role: 'cosmetologist' });
      const first = f.start(), id = choiceFor(first);
      if (change === 'selected-name') f.patients.find(row => row.id === 'ksenia').firstName = 'Мария';
      if (change === 'other-name') f.patients.find(row => row.id === 'oksana').firstName = 'Ольга';
      if (change === 'hidden-selected') f.patients.find(row => row.id === 'ksenia').createdBy = 'other-staff';
      if (change === 'new-exact') f.patients.push(person('new-exact', 'Алёна', 'Ковалёва'));
      if (change === 'new-alternative') f.patients.push(person('new-alternative', 'Дарья', 'Ковалёва'));
      f.changed(); // Real cabinet mutations advance the directory snapshot revision.
      assert.throws(() => f.answer({ choice: id }), error => error.status === 409);
      assert.ok(f.patients.every(row => row.appointments.length === 0));
    });
  }
  test(kind + ' checks current request access before using an offered choice', () => {
    const f = fixture({ kind }), id = choiceFor(f.start());
    f.c.assertCurrent = () => { throw Object.assign(new Error('Synthetic access revoked'), { status: 403 }); };
    assert.throws(() => f.answer({ choice: id }), error => error.status === 403);
    assert.ok(f.patients.every(row => row.appointments.length === 0));
  });
  test(kind + ' does not truncate an overflowing surname cohort or lose the surname on a short reply', () => {
    const f = fixture({ kind });
    for (const [index, firstName] of ['Дарья', 'Татьяна', 'Мария', 'Надежда'].entries())
      f.patients.push(person('overflow-' + index, firstName, 'Ковалёва'));
    assertQuestion(f.start(), 0);
    const originalQuery = f.entry().data.clientQuery;
    const reply = f.answer({ text: 'Алёна' });
    assert.equal(reply.action, null);
    assert.equal(reply.dialogue.options.length, 0);
    assert.equal(f.entry().data.clientQuery, originalQuery);
    assert.ok(f.patients.every(row => row.appointments.length === 0));
  });
}
test('staff sees only the accessible surname cohort and confirms a single visible person explicitly', () => {
  const f = fixture({ role: 'cosmetologist' });
  f.patients.find(row => row.id === 'oksana').createdBy = 'other-staff';
  const reply = f.start();
  assertQuestion(reply, 1);
  assert.doesNotMatch(reply.dialogue.prompt, /Оксана/iu);
  assert.ok(reply.dialogue.options.every(row => !row.label.includes('Оксана')));
  assertBooking(f.answer({ text: 'да' }));
});
test('the newly chosen client does not bypass fresh occupancy checks at final preparation', () => {
  const f = fixture();
  assertQuestion(f.start());
  f.busy.push({ id: 'synthetic-busy', date: day, time: '14:30', duration: 30, staffId: 'owner' });
  const reply = f.answer({ text: 'Ксения' });
  assert.equal(reply.action, null);
  assert.ok(reply.dialogue.fields.some(row => row.key === 'client' && row.value.includes('Ксения')));
  assert.ok(f.patients.every(row => row.appointments.length === 0));
});
for (const kind of ['booking', 'card']) {
  for (const text of ['отмена', 'стоп']) {
    test(kind + ' keeps cancellation active during surname component clarification: ' + text, () => {
      const f = fixture({ kind }), before = JSON.stringify(f.patients);
      assertQuestion(f.start());
      const reply = f.answer({ text });
      assert.equal(reply.action, null);
      assert.equal(reply.dialogue, null);
      assert.match(reply.text, text === 'стоп' ? /остановлен/iu : /отмен/iu);
      assert.equal(JSON.stringify(f.patients), before);
    });
  }
  test(kind + ' repeats the current named question without selecting a person or changing source', () => {
    const f = fixture({ kind });
    const first = f.start(), query = f.entry().data.clientQuery;
    assertQuestion(f.answer({ text: 'повтори' }));
    assert.equal(f.reply.dialogue.prompt, first.dialogue.prompt);
    assert.equal(f.entry().data.clientQuery, query);
  });
  for (const text of ['верно', 'это она', 'подтверждаю']) {
    test(kind + ' needs a named person after a multi-person confirmation: ' + text, () => {
      const f = fixture({ kind });
      assertQuestion(f.start());
      assertQuestion(f.answer({ text }));
      assert.equal(f.entry().data.clientQuery, 'Алёна Ковалёва');
    });
  }
  test(kind + ' accepts the existing singleton confirmation word and a named reply with a harmless prefix', () => {
    const single = fixture({ kind, singleton: true });
    assertQuestion(single.start(), 1);
    const selected = single.answer({ text: 'верно' });
    if (kind === 'booking') assertBooking(selected);
    else assert.deepEqual(selected.action, { type: 'clientCard', patientId: 'ksenia' });
    const named = fixture({ kind });
    assertQuestion(named.start());
    assertQuestion(named.answer({ text: 'это Ковалёва' }));
    const reply = named.answer({ text: 'это Ксения' });
    if (kind === 'booking') assertBooking(reply);
    else assert.deepEqual(reply.action, { type: 'clientCard', patientId: 'ksenia' });
  });
}
test('a source component shared by given and surname fields remains unresolved', () => {
  const f = fixture();
  f.patients.push(person('cross-field', 'Ольга', 'Алёна'));
  assertQuestion(f.start(), 0);
  assert.ok(f.patients.every(row => row.appointments.length === 0));
});


test('declined FIO components retain every original lookup family within the same eight-query budget', () => {
  for (const query of ['Ковалевой Алены Игоревны', 'Алены Игоревны Ковалевой', 'Гульнары Мухамедьяновой']) {
    const plan = clientComponentPlan(query);
    assert.equal(plan.overflow, false, query);
    assert.ok(plan.queries.length > 0 && plan.queries.length <= 8, query);
    for (const word of plan.words)
      for (const original of searchPlan(word).queries)
        assert.ok(plan.queries.some(anchor => original.startsWith(anchor)), original);
  }
});
