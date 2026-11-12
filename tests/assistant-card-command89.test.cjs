const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const root = '../src/server/modules/assistant/';
const { createAssistant } = require(root + 'service.cjs');
const { intentEnvelope } = require(root + 'interpretation/intent-contract.cjs');
const { createDialogueStore } = require(root + 'dialogue/dialogue-store.cjs');
const { createClientCardFlow, cardSourceQuery } = require(root + 'actions/client-card-flow.cjs');
const { clientCardCommand, containsCardCommand, unsupportedCardObject } = require(
  root + 'interpretation/client-card-grammar.cjs',
);
const { detectRequestedOperation } = require(root + 'interpretation/requested-operation.cjs');
const { assertIntentAction } = require(root + 'interpretation/intent-action-grounding.cjs');
const { demoIntent } = require(root + 'interpretation/demo-intents.cjs');
const { expandClientSource } = require(root + 'language/names/client-source-span.cjs');
const { dialogueControl } = require(root + 'dialogue/dialogue-control.cjs');
const { repairOperation } = require(root + 'dialogue/dialogue-repair-parse.cjs');
const { dayTurnConstraints } = require(root + 'dialogue/bare-day-proposal.cjs');
const { continuationOperation } = require(
  root + 'dialogue/continuation/continuation-operation.cjs',
);
const { continuationExample } = require(root + 'dialogue/continuation/continuation-contract.cjs');
const { hints } = require(root + 'behavior/example-features.cjs');
const { domainRules } = require(root + 'behavior/domain-rules.cjs');
const clock = { date: '2099-01-05', hour: 8 };
function fixture({ ded = true, arthur = true, role = 'owner' } = {}) {
  const f = dialogueFixture({ role });
  f.state.policy.commands.clients = true;
  const patient = (id, firstName, lastName) => ({
    id,
    firstName,
    lastName,
    name: firstName + ' ' + lastName,
    phone: '',
    createdBy: 'owner',
    appointments: [],
    visits: [],
  });
  f.patients.splice(
    0,
    f.patients.length,
    patient('artem', 'Артём', 'Макартычан'),
    ...(arthur ? [patient('arthur', 'Артур', 'Макартычан')] : []),
    ...(ded ? [patient('ded', 'Дед', 'Мороз')] : []),
  );
  const memory = createDialogueStore(),
    cards = createClientCardFlow({ memory });
  let reply;
  let before;
  const unchanged = () =>
    assert.equal(
      JSON.stringify(f.patients),
      before,
      'A card read never writes synthetic client/appointment data',
    );
  return {
    ...f,
    memory,
    cards,
    start(raw, query = null) {
      before = JSON.stringify(f.patients);
      reply = cards.start(
        f.c,
        { intent: 'clientCard', query },
        f.state,
        f.member,
        f.clock,
        memory.beginCommand(f.c, f.member, f.state),
        raw,
      );
      unchanged();
      return reply;
    },
    send(text) {
      reply = cards.continueDialogue(
        f.c,
        { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, text },
        f.state,
        f.member,
        f.clock,
      );
      unchanged();
      return reply;
    },
    get entry() {
      return memory.get(f.c, f.member, f.state, reply.dialogue.id);
    },
  };
}
for (const raw of [
  'Открой карту Дед Мороз',
  'Открой карточку Дед Мороз',
  'Пожалуйста, откройте мне карту клиента Дед Мороз',
  'Покажи карту Дед Мороз',
  'Найди карту Дед Мороз',
  'Открыть карту Дед Мороз',
])
  test('One card grammar grounds, strips and opens the literal identity: ' + raw, () => {
    assert.equal(clientCardCommand(raw).query, 'Дед Мороз');
    assert.equal(containsCardCommand(raw), true);
    assert.equal(detectRequestedOperation(raw).intent, 'clientCard');
    assert.equal(demoIntent(raw, clock).intent, 'clientCard');
    assert.equal(demoIntent(raw, clock).query, 'Дед Мороз');
    assert.equal(cardSourceQuery(raw, 'Артём'), 'Дед Мороз');
    assert.equal(
      expandClientSource(raw, 'Дед Мороз'),
      'Дед Мороз',
      'The object noun cannot become part of a client name',
    );
    assert.deepEqual(fixture().start(raw, 'Артём').action, {
      type: 'clientCard',
      patientId: 'ded',
    });
    const absent = fixture({ ded: false }).start(raw, 'Артём');
    assert.equal(absent.action, null);
    assert.equal(absent.dialogue.step, 'client');
    assert.ok(absent.text.trim());
  });
for (const identity of ['Артур', 'Артур Макартычан', 'Макартычан Артур', 'Артура Макартычана'])
  for (const proposal of [null, '', 'Артём'])
    test(
      'The alias preserves exact Arthur grounding, including an absent Arthur: ' +
        identity +
        '/' +
        proposal,
      () => {
        const raw = 'Открой карту ' + identity;
        assert.equal(cardSourceQuery(raw, proposal), identity);
        assert.deepEqual(fixture().start(raw, proposal).action, {
          type: 'clientCard',
          patientId: 'arthur',
        });
        const result = fixture({ arthur: false }).start(raw, proposal);
        assert.equal(result.action, null);
        assert.equal(result.dialogue.step, 'client');
      },
    );
for (const raw of ['Открой карту', 'Открой карточку', 'Покажи мне карту клиента'])
  test('A bare card object asks for the missing client and keeps voice dialogue: ' + raw, () => {
    const f = fixture(),
      reply = f.start(raw, 'Артём');
    assert.equal(demoIntent(raw, clock).intent, 'clientCard');
    assert.equal(reply.action, null);
    assert.equal(reply.dialogue.step, 'client');
    assert.equal(reply.dialogue.manualInputRequired, undefined);
    assert.equal(f.entry.data.clientQuery, '');
    assert.deepEqual(f.send('Дед Мороз').action, { type: 'clientCard', patientId: 'ded' });
  });
for (const raw of ['Открой карту Дед Мороз', 'Открой карту Артур', 'Покажи карту Артур Макартычан'])
  test(
    'An alias command during a sole approximate offer starts a fresh scoped lookup: ' + raw,
    () => {
      const f = fixture(),
        initial = f.start('Открой карточку Артёма Мыкартычана', 'Артёма Мыкартычана');
      assert.equal(initial.action, null);
      assert.equal(initial.dialogue.options.length, 1);
      assert.deepEqual(f.send(raw).action, {
        type: 'clientCard',
        patientId: raw.includes('Дед') ? 'ded' : 'arthur',
      });
    },
  );
for (const raw of [
  'Открой карту банка',
  'Открой банковскую карту',
  'Открой кредитную карту',
  'Открой карту оплаты',
  'Открой карту для оплаты',
  'Открой карту сайта',
  'Открой карту мира',
  'Покажи географическую карту',
])
  test(
    'Explicit non-client card/map objects are help at runtime and retrieval boundaries: ' + raw,
    () => {
      assert.equal(unsupportedCardObject(raw), true);
      assert.equal(detectRequestedOperation(raw).intent, 'help');
      assert.deepEqual(demoIntent(raw, clock), { intent: 'help' });
      assert.deepEqual([...hints(raw)], [['help', 1.4]]);
      assert.equal(cardSourceQuery(raw, 'Артур'), '');
      assert.throws(() => assertIntentAction(raw, 'clientCard'), { status: 502 });
      assert.doesNotThrow(() => assertIntentAction(raw, 'help'));
    },
  );
test('A client role still permits unusual literal names and no broad dictionary/fuzzy alias is added', () => {
  const raw = 'Открой карту клиента Миры';
  assert.equal(unsupportedCardObject(raw), false);
  assert.equal(detectRequestedOperation(raw).intent, 'clientCard');
  assert.equal(cardSourceQuery(raw, 'Мира'), 'Миры');
  assert.equal(clientCardCommand('Построй карту Дед Мороз'), null);
  assert.deepEqual(demoIntent('Построй карту Дед Мороз', clock), { intent: 'help' });
});
for (const raw of [
  'Не открывай карту Артур',
  'Открой карту Артур и удали запись',
  'Открой карту Артур и открой карточку Дед Мороз',
])
  test('The alias does not bypass negation or the single-action boundary: ' + raw, () => {
    assert.throws(() => assertIntentAction(raw, 'clientCard'), { status: 400 });
  });
for (const raw of [
  'Открой карту Артур, если он есть',
  'Открой карту Артур или Артём',
  'Открой карту не Артур',
])
  test('Unsafe identity scope never opens a card: ' + raw, () => {
    assert.equal(cardSourceQuery(raw, 'Артур'), '');
    assert.equal(fixture().start(raw, 'Артур').action, null);
  });
for (const raw of [
  'не открывай карту',
  'не открывай эту карту',
  'эту карту не открывай',
  'карту оставь как есть',
  'не надо открывать карту',
  'не хочу открывать карту',
])
  test('A card alias refusal stops the draft and cannot confirm a stale candidate: ' + raw, () => {
    assert.equal(dialogueControl(raw, 'open'), 'stop');
    const f = fixture(),
      before = f.start('Открой карточку Артёма Мыкартычана', 'Артёма Мыкартычана');
    assert.equal(before.dialogue.options.length, 1);
    const stopped = f.send(raw);
    assert.equal(stopped.action, null);
    assert.equal(stopped.dialogue, null);
    assert.throws(
      () =>
        f.cards.continueDialogue(
          f.c,
          { dialogueId: before.dialogue.id, dialogueVersion: before.dialogue.version, text: 'да' },
          f.state,
          f.member,
          f.clock,
        ),
      { status: 409 },
    );
  });
for (const raw of ['Открой карту Дед Мороз на двадцатое', 'Покажи карту Дед Мороз на двадцатое'])
  test('A new card task cannot become a create/client/date patch: ' + raw, () => {
    const entry = {
      step: 'date',
      data: { clientQuery: 'Анна Семёнова', date: null, time: null },
      options: new Map(),
    };
    const before = JSON.stringify(entry.data);
    assert.equal(dayTurnConstraints(entry, raw, clock), null);
    assert.equal(repairOperation(entry, raw, clock).kind, 'localHelp');
    const proposed = continuationExample({
      operation: 'patch',
      fields: { client: 'Дед Мороз', date: '2099-01-20' },
    });
    assert.equal(continuationOperation(proposed, { text: raw }, entry, clock).kind, 'modelClarify');
    assert.equal(JSON.stringify(entry.data), before);
  });
test('Aliases keep command policy and employee ACLs', () => {
  const disabled = fixture();
  disabled.state.policy.commands.clients = false;
  assert.throws(() => disabled.start('Открой карту Дед Мороз'), { status: 403 });
  const employee = fixture({ role: 'cosmetologist' });
  employee.patients.find((p) => p.id === 'ded').createdBy = 'other';
  assert.equal(employee.start('Открой карту Дед Мороз').action, null);
});
test('The model instructions and the existing catalog example describe the same supported card action', () => {
  assert.match(domainRules, /«Открой карту Иванова» — clientCard\/query/u);
  assert.match(domainRules, /Банковская карта, карта оплаты, мира или сайта — help/u);
  const example = require(root + 'behavior/scenarios/cards-reading-1.json').find(
    (p) => p.id === 'card-open',
  );
  assert.equal(example.text, 'Открой карту Анны Ивановой');
  assert.equal(example.current.intent.intent, 'clientCard');
  assert.doesNotMatch(example.current.outcome, /обычный список клиентов/u);
});
test('Native model turn, bare alias clarification and command-in-choice use the exact server grammar', async (t) => {
  const f = await adminFixture(t),
    admin = f.store.assistant.admin;
  const command = (extra) => ({
    expectedRevision: admin.view(f.admin.accountId).revision,
    requestId: randomUUID(),
    reason: 'Synthetic card-command89',
    ...extra,
  });
  admin.settings(
    f.admin.accountId,
    command({
      policy: { mode: 'selected', limits: { dailyRequests: 100, monthlyBudgetRub: 100000 } },
      providers: { llm: { provider: 'timeweb' } },
      timewebApiKey: 'synthetic-card89-key',
    }),
  );
  admin.setMember(
    f.admin.accountId,
    command({
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: true,
    }),
  );
  let proposal = { intent: 'clientCard', query: 'Артём' },
    calls = 0;
  const api = createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      fetchImpl: async () => {
        calls++;
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify(intentEnvelope(proposal)) },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 20 },
        });
      },
    },
  );
  const current = f.store.session(f.ownerSession.token);
  const clinical = fixture(),
    before = JSON.stringify(clinical.patients);
  const context = {
    current,
    platform: f.store,
    token: f.ownerSession.token,
    tenantStore: () => clinical.c.tenantStore(),
    assertCurrent() {},
  };
  const turn = (body) =>
    api.turn(context, { policyVersion: api.access(current).policyVersion, ...body });
  // Conversational opening keeps this provider-envelope test on the model path.
  for (const [text, patientId] of [
    ['Открою карту Дед Мороз', 'ded'],
    ['Открою карту Артур', 'arthur'],
    ['Открою карту Артур Макартычан', 'arthur'],
  ]) {
    const result = await turn({ text, newCommand: true });
    assert.equal(result.intent, 'clientCard');
    assert.equal(result.demo, false);
    assert.deepEqual(result.action, { type: 'clientCard', patientId });
  }
  let reply = await turn({ text: 'Открою карту', newCommand: true });
  assert.equal(reply.action, null);
  const count = calls;
  reply = await turn({
    dialogueId: reply.dialogue.id,
    dialogueVersion: reply.dialogue.version,
    text: 'Дед Мороз',
  });
  assert.deepEqual(reply.action, { type: 'clientCard', patientId: 'ded' });
  assert.equal(calls, count);
  proposal = { intent: 'clientCard', query: 'Артёма Мыкартычана' };
  reply = await turn({ text: 'Открою карточку Артёма Мыкартычана', newCommand: true });
  assert.equal(reply.dialogue.options.length, 1);
  const choiceCalls = calls;
  reply = await turn({
    dialogueId: reply.dialogue.id,
    dialogueVersion: reply.dialogue.version,
    text: 'Открой карту Артур',
  });
  assert.deepEqual(reply.action, { type: 'clientCard', patientId: 'arthur' });
  assert.equal(calls, choiceCalls);
  proposal = { intent: 'help' };
  for (const text of ['Открой карту сайта', 'Открой карту мира', 'Открой карту банка']) {
    const result = await turn({ text, newCommand: true });
    assert.equal(result.intent, 'help');
    assert.equal(result.action, null);
    assert.equal(result.dialogue ?? null, null);
  }
  assert.equal(calls, 8);
  assert.equal(JSON.stringify(clinical.patients), before);
});

test('Shared open grammar preserves ordinary client search and guards modified non-client card objects', () => {
  for (const text of [
    'Найди клиента Анну Семёнову',
    'Найти клиента Артур',
    'Найдите клиента Дед Мороз',
  ])
    assert.equal(demoIntent(text, clock).intent, 'clients');
  const raw = 'Открой банковскую карту';
  assert.equal(containsCardCommand(raw), true);
  const f = fixture();
  const initial = f.start('Открой карточку Артёма Мыкартычана', 'Артёма Мыкартычана');
  assert.equal(initial.dialogue.options.length, 1);
  const reset = f.send(raw);
  assert.equal(reset.action, null);
  assert.equal(f.entry.data.clientQuery, '');
  assert.equal(
    f.send('да').action,
    null,
    'A foreign card object cannot leave an old candidate authorized',
  );
});
