const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDialogueStore,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const {
  createClientCardFlow,
  cardSourceQuery,
} = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const {
  createAssistantDialogue,
} = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
function fixture({ missing = false, role = 'owner', now } = {}) {
  const f = dialogueFixture({ role });
  f.state.policy.commands = { clients: true, calendar: false, prepareAppointment: false };
  f.patients.splice(
    0,
    f.patients.length,
    ...(!missing
      ? ['Олеговна', 'Петровна'].map((middleName, index) => ({
          id: 'synthetic-popova-' + index,
          firstName: 'Александра',
          middleName,
          lastName: 'Попова',
          name: 'Александра ' + middleName + ' Попова',
          createdBy: 'owner',
          appointments: [],
          phone: index ? '+79995552222' : '+79995551111',
        }))
      : []),
  );
  const memory = createDialogueStore(now ? { now } : {});
  const cards = createClientCardFlow({ memory });
  let result;
  return {
    ...f,
    memory,
    cards,
    start(query = 'Поповой', raw) {
      const ticket = memory.beginCommand(f.c, f.member, f.state);
      return (result = cards.start(
        f.c,
        { intent: 'clientCard', query },
        f.state,
        f.member,
        f.clock,
        ticket,
        raw,
      ));
    },
    send(operation) {
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        ...operation,
      };
      result = cards.continueDialogue(f.c, body, f.state, f.member);
      return { body, reply: result };
    },
    get result() {
      return result;
    },
  };
}
test('ambiguous card asks only a short identity question and never navigates to a client list', () => {
  const f = fixture(),
    result = f.start();
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'client');
  assert.equal(result.dialogue.phase, 'clientChoice');
  assert.equal(result.dialogue.prompt, 'Александра Олеговна или Александра Петровна?');
  assert.equal(result.dialogue.options.length, 2);
  assert.deepEqual(result.dialogue.fields, []);
});

test('opening a card can select a surname-only legacy record after repeated ambiguous answers', () => {
  const f = fixture();
  const patientId = 'synthetic-surname-only';
  f.patients.push({ id: patientId, name: 'Попова', createdBy: 'owner', phone: '', appointments: [] });
  const initial = f.start('Попова', 'Открой карточку Попова');
  assert.equal(initial.dialogue.options.length, 3);
  assert.match(initial.dialogue.prompt, /без имени/u);
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = f.send({ text: 'Попова' }).reply;
    assert.equal(retry.action, null);
    assert.equal(retry.dialogue.options.length, 3);
    assert.match(retry.dialogue.prompt, /без имени/u);
  }
  const selected = f.send({ text: 'Без имени' }).reply;
  assert.deepEqual(selected.action, { type: 'clientCard', patientId });
  assert.equal(selected.dialogue, null);
});

test('a spoken surname with four named matches asks the given name and keeps opening a card as its intent', () => {
  const f = fixture();
  f.patients.splice(
    0,
    f.patients.length,
    ...['Алексей', 'Олег', 'Иван', 'Сергей'].map((firstName, index) => ({
      id: 'synthetic-semenov-' + index,
      firstName,
      lastName: 'Семёнов',
      name: firstName + ' Семёнов',
      createdBy: 'owner',
      appointments: [],
      phone: '',
    })),
  );
  const before = JSON.stringify(f.patients);
  const reply = f.start('Семенова', 'Открой карточку Семенова');
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.prompt, 'Какое имя?');
  assert.equal(reply.text, reply.dialogue.prompt, 'spoken reply is the exact server question');
  assert.equal(reply.dialogue.options.length, 4);
  assert.doesNotMatch(reply.text, /телефон|номер|полное/u);
  const entry = f.memory.get(f.c, f.member, f.state, reply.dialogue.id);
  assert.equal(entry.data.target, 'clientCard');
  assert.equal(entry.data.initialIntent.intent, 'clientCard');
  const selected = f.send({ text: 'Олега' }).reply;
  assert.deepEqual(selected.action, { type: 'clientCard', patientId: 'synthetic-semenov-1' });
  assert.equal(selected.dialogue, null);
  assert.equal(JSON.stringify(f.patients), before);
});

test('a four-digit answer selects only shown same-name card choices, preserving the card target after a nonmatching tail', () => {
  const f = fixture();
  f.patients.splice(
    0,
    f.patients.length,
    ...Array.from({ length: 4 }, (_, index) => ({
      id: 'synthetic-semenov-' + index,
      firstName: 'Иван',
      middleName: 'Петрович',
      lastName: 'Семёнов',
      name: 'Иван Петрович Семёнов',
      createdBy: 'owner',
      appointments: [],
      phone: '+7999000' + String(index + 1000),
    })),
    {
      id: 'synthetic-outside-choice',
      firstName: 'Борис',
      lastName: 'Иванов',
      name: 'Борис Иванов',
      createdBy: 'owner',
      appointments: [],
      phone: '+78880001002',
    },
  );
  const before = JSON.stringify(f.patients);
  const first = f.start('Семенова', 'Открой карточку Семенова');
  assert.equal(first.dialogue.options.length, 4);
  assert.equal(first.dialogue.prompt, 'Назовите последние четыре цифры телефона или полное имя.');
  assert.ok(first.dialogue.options.every((option) => /…100[0-3]$/u.test(option.label)));
  const missing = f.send({ text: '9999' }).reply;
  assert.equal(missing.action, null);
  assert.equal(missing.dialogue.options.length, 4);
  assert.equal(
    missing.dialogue.prompt,
    'В списке нет такого окончания — назовите имя или последние четыре цифры.',
  );
  assert.equal(missing.text, missing.dialogue.prompt);
  const entry = f.memory.get(f.c, f.member, f.state, missing.dialogue.id);
  assert.equal(entry.data.target, 'clientCard');
  const selected = f.send({ text: 'один ноль ноль два' }).reply;
  assert.deepEqual(selected.action, { type: 'clientCard', patientId: 'synthetic-semenov-2' });
  assert.equal(selected.dialogue, null);
  assert.equal(JSON.stringify(f.patients), before);
});
test('patronymic clarification opens the intended card without any booking questions', () => {
  const f = fixture();
  f.start();
  const { reply } = f.send({ text: 'Олеговна' });
  assert.deepEqual(reply.action, { type: 'clientCard', patientId: 'synthetic-popova-0' });
  assert.equal(reply.dialogue, null);
});
test('unique initial source-proven card opens immediately while booking permission is off', () => {
  const f = fixture();
  const result = f.start(
    'Попова Александра Олеговна',
    'Открой карточку Поповой Александры Олеговны',
  );
  assert.deepEqual(result.action, { type: 'clientCard', patientId: 'synthetic-popova-0' });
});
test('model-proposed name absent from raw speech cannot select a patient', () => {
  const f = fixture();
  const result = f.start('Попова Александра Олеговна', 'Открой карточку Петровой');
  assert.equal(result.action, null);
  assert.equal(result.dialogue.step, 'client');
});
test('source proof retains full name instead of trusting a model-dropped patronymic', () => {
  assert.equal(
    cardSourceQuery('Открой карточку Поповой Александры Олеговны', 'Александры'),
    'Поповой Александры Олеговны',
  );
});
test('missing client requests identity instead of substituting a list', () => {
  const f = fixture();
  const result = f.start('Несуществующая');
  assert.equal(result.action, null);
  assert.match(result.dialogue.prompt, /Клиент не найден/u);
});
test('three failed identities stop the automatic voice loop without losing the card target', () => {
  const f = fixture();
  f.start('Несуществующая');
  f.send({ text: 'Неизвестная' });
  const second = f.send({ text: 'Фамилия' }).reply;
  assert.equal(second.dialogue.manualInputRequired, undefined);
  const third = f.send({ text: 'Нетакойклиент' }).reply;
  assert.equal(third.dialogue.manualInputRequired, true);
  assert.equal(f.memory.get(f.c, f.member, f.state, third.dialogue.id).data.target, 'clientCard');
});
test('yes to two clients never guesses the first card', () => {
  const f = fixture();
  f.start();
  const reply = f.send({ text: 'да-да' }).reply;
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.options.length, 2);
});
test('opaque choice is checked against current candidates and opens only that identity', () => {
  const f = fixture();
  const first = f.start();
  const result = f.send({ choice: first.dialogue.options[1].id }).reply;
  assert.equal(result.action.patientId, 'synthetic-popova-1');
});
test('renamed current choice is rejected without opening a stale card', () => {
  const f = fixture();
  const first = f.start();
  f.patients[0].middleName = 'Ивановна';
  f.patients[0].name = 'Александра Ивановна Попова';
  assert.throws(() => f.send({ choice: first.dialogue.options[0].id }), { status: 409 });
});
test('deleted current choice is rejected and the old response remains usable for refresh', () => {
  const f = fixture();
  const first = f.start();
  f.patients.shift();
  assert.throws(() => f.send({ choice: first.dialogue.options[0].id }), { status: 409 });
});
test('employee cannot resolve or choose another employee client', () => {
  const f = fixture({ role: 'cosmetologist' });
  for (const patient of f.patients) patient.createdBy = 'other';
  const result = f.start();
  assert.equal(result.action, null);
  assert.equal(result.dialogue.options.length, 0);
});
test('clients permission is enforced independently from booking permission on every turn', () => {
  const f = fixture();
  f.start();
  f.state.policy.commands.clients = false;
  assert.throws(() => f.send({ text: 'Олеговна' }), { status: 403 });
});
test('malformed, foreign and stale choice requests do not change current state', () => {
  const f = fixture();
  const first = f.start();
  for (const body of [
    { dialogueId: first.dialogue.id, dialogueVersion: 0, text: 'Олеговна', choice: 'foreign' },
    { dialogueId: first.dialogue.id, dialogueVersion: 0, choice: 'foreign' },
    { dialogueId: first.dialogue.id, dialogueVersion: 8, text: 'Олеговна' },
    { dialogueId: first.dialogue.id, dialogueVersion: 0, edit: 'date' },
  ])
    assert.throws(
      () => f.cards.continueDialogue(f.c, body, f.state, f.member),
      (error) => [400, 409].includes(error.status),
    );
  const entry = f.memory.get(f.c, f.member, f.state, first.dialogue.id);
  assert.equal(entry.version, 0);
  assert.equal(entry.turns, 0);
});
test('replaying an accepted final answer returns the same card after a fresh ACL lookup', () => {
  const f = fixture();
  f.start();
  const accepted = f.send({ text: 'Олеговна' });
  const repeated = f.cards.continueDialogue(f.c, accepted.body, f.state, f.member);
  assert.deepEqual(repeated, accepted.reply);
  f.patients.shift();
  assert.throws(() => f.cards.continueDialogue(f.c, accepted.body, f.state, f.member), {
    status: 409,
  });
});
test('identical pending replay keeps response/version/options and does not count another failure', () => {
  const f = fixture();
  f.start('Ненайденная');
  const accepted = f.send({ text: 'Несуществующая' });
  const repeated = f.cards.continueDialogue(f.c, accepted.body, f.state, f.member);
  assert.deepEqual(repeated, accepted.reply);
  assert.equal(repeated.dialogue.version, 1);
});
test('cancelled card request stays cancelled on identical replay', () => {
  const f = fixture();
  f.start();
  const accepted = f.send({ cancel: true });
  assert.equal(accepted.reply.action, null);
  assert.equal(accepted.reply.dialogue, null);
  assert.deepEqual(f.cards.continueDialogue(f.c, accepted.body, f.state, f.member), accepted.reply);
});
test('TTL, role, membership and revision changes invalidate the previous card dialogue', () => {
  for (const change of ['ttl', 'role', 'membership', 'revision']) {
    let now = Date.now();
    const f = fixture({ now: () => now });
    const first = f.start();
    if (change === 'ttl') now += 10 * 60 * 1000 + 1;
    if (change === 'role') f.c.current.role = 'cosmetologist';
    if (change === 'membership') f.member.membershipId = 'another-membership';
    if (change === 'revision') f.state.revision++;
    assert.throws(
      () =>
        f.cards.continueDialogue(
          f.c,
          { dialogueId: first.dialogue.id, dialogueVersion: 0, text: 'Олеговна' },
          f.state,
          f.member,
        ),
      { status: 409 },
    );
  }
});
test('one shared command store fences old card dialogue when a booking or other new command is accepted', () => {
  const f = fixture();
  const first = f.start();
  const booking = createAssistantDialogue({ memory: f.memory });
  booking.beginCommand(f.c, f.member, f.state);
  assert.throws(
    () =>
      f.cards.continueDialogue(
        f.c,
        { dialogueId: first.dialogue.id, dialogueVersion: 0, text: 'Олеговна' },
        f.state,
        f.member,
      ),
    { status: 409 },
  );
});
test('full phone and current seven-digit suffix preserve card intent with the shared phone parser', () => {
  for (const text of ['+7 999 555 11 11', '555-11-11']) {
    const f = fixture();
    f.start();
    const result = f.send({ text }).reply;
    assert.deepEqual(result.action, { type: 'clientCard', patientId: 'synthetic-popova-0' });
  }
});
test('colliding phone suffix returns to distinguishing names instead of requiring the full phone', () => {
  const f = fixture();
  f.patients[1].phone = '+78885551111';
  f.start();
  const result = f.send({ text: '555-11-11' }).reply;
  assert.equal(result.action, null);
  assert.equal(
    result.dialogue.prompt,
    'Окончания совпали — Александра Олеговна или Александра Петровна?',
  );
  assert.equal(result.text, result.dialogue.prompt);
  const selected = f.send({ text: 'Петровна' }).reply;
  assert.deepEqual(selected.action, { type: 'clientCard', patientId: 'synthetic-popova-1' });
});
test('internal target/allow/onResolved hooks preserve the source-proven identity without imposing booking or clients grants', () => {
  const f = fixture();
  const resolved = [];
  const flow = createClientCardFlow({
    memory: f.memory,
    target: 'syntheticManagement',
    allow(c, state) {
      assert.equal(c, f.c);
      return state.policy.commands.prepareAppointment;
    },
    onResolved(c, entry, patient, clock) {
      resolved.push({ patientId: patient.id, clock });
      assert.equal(entry.data.initialIntent.intent, 'syntheticManagement');
      entry.complete = true;
      return { text: 'Synthetic prepared operation', dialogue: null, action: null };
    },
  });
  f.state.policy.commands = { clients: false, prepareAppointment: true };
  const ticket = f.memory.beginCommand(f.c, f.member, f.state);
  const first = flow.start(
    f.c,
    { intent: 'syntheticManagement', query: 'Попова' },
    f.state,
    f.member,
    f.clock,
    ticket,
  );
  assert.equal(first.action, null);
  const reply = flow.continueDialogue(
    f.c,
    { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text: 'Олеговна' },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(reply.text, 'Synthetic prepared operation');
  assert.deepEqual(resolved, [{ patientId: 'synthetic-popova-0', clock: f.clock }]);
});
test('polite card opening wrappers retain the same complete source name', () => {
  for (const raw of [
    'Открой мне карточку Поповой Александры Олеговны',
    'Найдите карточку клиентки Поповой Александры Олеговны',
    'Покажи карточку Поповой Александры Олеговны, пожалуйста',
  ])
    assert.equal(cardSourceQuery(raw, 'Александры'), 'Поповой Александры Олеговны', raw);
});
test('actual assistant service keeps card intent through a local identity clarification with booking disabled', async (t) => {
  const { adminFixture } = require('./helpers/admin-fixture.cjs');
  const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
  const { randomUUID } = require('node:crypto');
  const f = await adminFixture(t),
    directory = fixture();
  let modelCalls = 0;
  const api = createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      codex: {
        available: true,
        async run({ guard, onOutbound }) {
          guard();
          onOutbound();
          modelCalls++;
          return { text: JSON.stringify({ intent: 'clientCard', query: 'Попова' }) };
        },
      },
      fetchImpl: () => assert.fail('No network in synthetic card-service verification'),
    },
  );
  const command = (revision, patch) => ({
    expectedRevision: revision,
    requestId: randomUUID(),
    reason: 'Synthetic card flow',
    ...patch,
  });
  const saved = api.admin.settings(
    f.admin.accountId,
    command(api.admin.view(f.admin.accountId).revision, {
      policy: {
        mode: 'selected',
        commands: { clients: true, calendar: false, prepareAppointment: false },
      },
      providers: { llm: { provider: 'codex' } },
    }),
  );
  api.admin.setMember(
    f.admin.accountId,
    command(saved.revision, {
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: true,
    }),
  );
  const current = f.store.session(f.ownerSession.token);
  const c = {
    current,
    platform: f.store,
    tenantStore: directory.c.tenantStore,
    assertCurrent() {
      const fresh = f.store.session(f.ownerSession.token);
      assert.equal(fresh.accountId, current.accountId);
      assert.equal(fresh.organizationId, current.organizationId);
    },
  };
  const policyVersion = api.access(current).policyVersion;
  const first = await api.turn(c, { policyVersion, text: 'Открою карточку Поповой' });
  assert.equal(first.action, null);
  assert.equal(first.dialogue.step, 'client');
  const final = await api.turn(c, {
    policyVersion,
    dialogueId: first.dialogue.id,
    dialogueVersion: first.dialogue.version,
    text: 'Олеговна',
  });
  assert.deepEqual(final.action, { type: 'clientCard', patientId: 'synthetic-popova-0' });
  assert.equal(final.dialogue, null);
  assert.equal(modelCalls, 1);
  assert.ok(directory.patients.every((patient) => patient.appointments.length === 0));
});
test('card command wrappers never swallow surnames that begin with client noun letters', () => {
  for (const surname of ['Клиентовой', 'Клиенткиной', 'Клиентаевой'])
    assert.equal(
      cardSourceQuery('Открой карточку ' + surname + ' Анны', 'Анны'),
      surname + ' Анны',
      surname,
    );
});
