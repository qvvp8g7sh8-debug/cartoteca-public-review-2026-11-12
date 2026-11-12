const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createDialogueStore,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const {
  createClientCardFlow,
  cardSourceQuery,
} = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const { matchesName } = require('../src/server/modules/assistant/language/names/name-matching.cjs');
const {
  nameForms,
  firstNameKind,
  nameGender,
} = require('../src/server/modules/assistant/language/names/name-forms.cjs');
const {
  entityText,
} = require('../src/server/modules/assistant/interpretation/entity-provenance.cjs');
const {
  expandClientSource,
} = require('../src/server/modules/assistant/language/names/client-source-span.cjs');
const { randomUUID } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
function fixture({ arthur = true, artem = true, role = 'owner', extras = [] } = {}) {
  const f = dialogueFixture({ role });
  f.state.policy.commands.clients = true;
  const patient = (id, firstName, lastName, middleName = '') => ({
    id,
    firstName,
    lastName,
    middleName,
    name: [firstName, middleName, lastName].filter(Boolean).join(' '),
    phone: '',
    createdBy: 'owner',
    appointments: [],
    visits: [],
  });
  f.patients.splice(
    0,
    f.patients.length,
    ...(artem ? [patient('artem', 'Артём', 'Макартычан')] : []),
    ...(arthur ? [patient('arthur', 'Артур', 'Макартычан')] : []),
    ...extras.map((p) => patient(...p)),
  );
  const memory = createDialogueStore(),
    cards = createClientCardFlow({ memory });
  let reply;
  let before;
  return {
    ...f,
    memory,
    cards,
    start(proposed, raw) {
      before = JSON.stringify(f.patients);
      const ticket = memory.beginCommand(f.c, f.member, f.state);
      reply = cards.start(
        f.c,
        { intent: 'clientCard', query: proposed },
        f.state,
        f.member,
        f.clock,
        ticket,
        raw,
      );
      assert.equal(
        JSON.stringify(f.patients),
        before,
        'Opening never changes synthetic clinical data',
      );
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
      assert.equal(JSON.stringify(f.patients), before);
      return reply;
    },
    get entry() {
      return reply.dialogue ? memory.get(f.c, f.member, f.state, reply.dialogue.id) : null;
    },
  };
}
const proposals = [null, '', 'Артём', 'Артём Макартычан', 'Макартычан', 'Артур'];
for (const proposed of proposals)
  for (const name of [
    'Артур',
    'Артур Макартычан',
    'Макартычан Артур',
    'Артура Макартычана',
    'Макартычана Артура',
  ])
    test(
      'whole raw identity chooses Arthur despite model locator=' +
        JSON.stringify(proposed) +
        '; raw=' +
        name,
      () => {
        const f = fixture();
        const raw = 'Открой карточку ' + name + '.';
        assert.equal(cardSourceQuery(raw, proposed), name);
        assert.deepEqual(f.start(proposed, raw).action, {
          type: 'clientCard',
          patientId: 'arthur',
        });
      },
    );
for (const proposed of proposals)
  for (const name of ['Артур', 'Артур Макартычан', 'Макартычан Артур', 'Артура Макартычана'])
    test(
      'an absent Arthur never auto-opens Artem; model=' +
        JSON.stringify(proposed) +
        '; raw=' +
        name,
      () => {
        const f = fixture({ arthur: false });
        const raw = 'Открой карточку ' + name;
        const result = f.start(proposed, raw);
        assert.equal(result.action, null);
        assert.equal(result.dialogue.step, 'client');
        assert.ok(result.text.trim(), 'A missing identity receives an audible server question');
        assert.equal(
          result.dialogue.manualInputRequired,
          undefined,
          'Fresh card lookup does not stop voice mode',
        );
        assert.equal(
          f.entry.data.clientQuery,
          name,
          'The spoken identity is retained for clarification',
        );
        assert.doesNotMatch(
          result.text,
          /^Как зовут клиента\?$/u,
          'Do not discard an already spoken name',
        );
        if (name === 'Артур') assert.equal(result.dialogue.options.length, 0);
      },
    );
for (const proposed of proposals)
  for (const name of ['Артур Мыкартычан', 'Мыкартычан Артур', 'Артура Мыкартычана'])
    test(
      'a surname typo keeps the exact Arthur constraint and needs a bound confirmation: ' +
        name +
        '; model=' +
        JSON.stringify(proposed),
      () => {
        const f = fixture();
        const result = f.start(proposed, 'Открой карточку ' + name);
        assert.equal(result.action, null);
        assert.ok(result.dialogue.options.length > 0);
        assert.ok(result.dialogue.options.every((option) => /Артур/u.test(option.label)));
        assert.ok(result.dialogue.options.every((option) => !/Арт[её]м/u.test(option.label)));
        assert.deepEqual(f.send('Да, верно').action, { type: 'clientCard', patientId: 'arthur' });
      },
    );
for (const proposed of [null, '', 'Артём Макартычан'])
  for (const name of ['Артур Мыкартычан', 'Мыкартычан Артур', 'Артура Мыкартычана'])
    test(
      'a typo plus an absent Arthur remains unresolved instead of selecting Artem: ' +
        name +
        '; model=' +
        JSON.stringify(proposed),
      () => {
        const f = fixture({ arthur: false });
        const result = f.start(proposed, 'Открой карточку ' + name);
        assert.equal(result.action, null);
        assert.equal(result.dialogue.step, 'client');
        assert.equal(result.dialogue.manualInputRequired, undefined);
        assert.ok(result.text.trim());
        assert.equal(f.entry.data.clientQuery, name);
      },
    );
for (const raw of [
  'Открой карточку не Артура Макартычана',
  'Открой карточку Артура или Артёма Макартычана',
  'Открой карточку Артура, если он существует',
  'Открой карточку Артура и удали запись',
  'Открой карточку Артура. Отправь сообщение',
  'Открой карточку Артура; сохрани новую запись',
])
  test('literal fallback never drops a denial, condition or another operation: ' + raw, () => {
    const f = fixture();
    const result = f.start('Артур', raw);
    assert.equal(result.action, null);
    assert.equal(result.dialogue.options.length, 0);
  });
test('Arthur and Artem are separate inflection families, never aliases or fuzzy exact matches', () => {
  assert.equal(firstNameKind('артур'), true);
  const arthur = { firstName: 'Артур', lastName: 'Макартычан' };
  const artem = { firstName: 'Артём', lastName: 'Макартычан' };
  assert.ok(nameForms('Артур', 'first', 'male').includes('артура'));
  assert.ok(!nameForms('Артур', 'first', 'male').includes('артема'));
  assert.ok(!nameForms('Артём', 'first', 'male').includes('артура'));
  assert.equal(matchesName(arthur, 'Артура Макартычана'), true);
  assert.equal(matchesName(artem, 'Артура Макартычана'), false);
  assert.equal(matchesName(arthur, 'Артёма Макартычана'), false);
  assert.equal(
    entityText('Артура Макартычана', 'Артур Макартычан', 'client'),
    'Артура Макартычана',
  );
  assert.equal(expandClientSource('Артура Макартычана', 'Артур'), 'Артура Макартычана');
});
test('literal whole identities outside the static dictionary do not depend on a model name locator', () => {
  for (const [id, first, last] of [
    ['anaid', 'Анаид', 'Макартычян'],
    ['edgar', 'Эдгар', 'Саркисян'],
  ]) {
    const f = fixture({ extras: [[id, first, last]] });
    assert.equal(firstNameKind(first.toLowerCase()), false);
    const raw = 'Открой карточку ' + first + ' ' + last;
    assert.deepEqual(f.start(null, raw).action, { type: 'clientCard', patientId: id });
  }
});
test('productive unknown male given-name cases require explicit male metadata; female consonant names stay exact', () => {
  assert.equal(nameGender('Эдгар', 'Иванович'), 'male');
  const edgar = { firstName: 'Эдгар', middleName: 'Иванович', lastName: 'Саркисян' };
  assert.equal(matchesName(edgar, 'Эдгара Саркисяна'), true);
  assert.equal(
    matchesName({ firstName: 'Эдгар', lastName: 'Саркисян' }, 'Эдгара Саркисяна'),
    false,
    'Unknown consonant names without explicit male metadata remain exact',
  );
  assert.equal(
    matchesName({ firstName: 'Эстер', middleName: 'Ивановна', lastName: 'Ким' }, 'Эстера Ким'),
    false,
  );
  assert.deepEqual(nameForms('Эстер', 'first', 'female'), ['эстер']);
});
test('same first name plus distinct surnames stays ambiguous and employee scope is rechecked', () => {
  const f = fixture({ extras: [['arthur-other', 'Артур', 'Петров']] });
  const result = f.start(null, 'Открой карточку Артур');
  assert.equal(result.action, null);
  assert.equal(result.dialogue.options.length, 2);
  assert.deepEqual(f.send('Макартычан').action, { type: 'clientCard', patientId: 'arthur' });
  const denied = fixture({ role: 'cosmetologist' });
  denied.patients.find((patient) => patient.id === 'arthur').createdBy = 'foreign-staff';
  const other = denied.start(null, 'Открой карточку Артур');
  assert.equal(other.action, null);
  assert.equal(other.dialogue.options.length, 0);
});
for (const arthur of [false, true])
  for (const answer of [
    'Артур',
    'Открой карточку Артур',
    'нет, Артур',
    'Открой карточку Артур Макартычан',
  ])
    test(
      'an answer replacing a sole Artem hypothesis never acts as its consent; Arthur=' +
        arthur +
        '; answer=' +
        answer,
      () => {
        const f = fixture({ arthur });
        const first = f.start('Артёма Мыкартычана', 'Открой карточку Артёма Мыкартычана');
        assert.equal(first.action, null);
        assert.equal(first.dialogue.options.length, 1);
        assert.match(first.dialogue.options[0].label, /Артём/u);
        const selected = f.send(answer);
        if (arthur) assert.deepEqual(selected.action, { type: 'clientCard', patientId: 'arthur' });
        else {
          assert.equal(selected.action, null);
          assert.equal(selected.dialogue.step, 'client');
          assert.ok(selected.text.trim());
          assert.equal(selected.dialogue.manualInputRequired, undefined);
          assert.ok(f.entry.data.clientQuery.startsWith('Артур'));
        }
      },
    );
for (const name of ['Артур Макартычан', 'Макартычан Артур'])
  for (const arthur of [false, true])
    test(
      'legacy two-token name-only rows retain distinct Arthur and Artem identities: ' +
        name +
        '; Arthur=' +
        arthur,
      () => {
        const f = fixture({ arthur });
        for (const patient of f.patients) {
          patient.name =
            patient.id === 'arthur'
              ? name
              : name.startsWith('Макартычан')
                ? 'Макартычан Артём'
                : 'Артём Макартычан';
          delete patient.firstName;
          delete patient.lastName;
          delete patient.middleName;
        }
        const result = f.start('Артём', 'Открой карточку Артур Макартычан');
        if (arthur) assert.deepEqual(result.action, { type: 'clientCard', patientId: 'arthur' });
        else assert.equal(result.action, null);
      },
    );
test('native service turn validates the provider envelope and action before source-proven card opening', async (t) => {
  const f = await adminFixture(t);
  const admin = f.store.assistant.admin;
  const command = (extra) => ({
    expectedRevision: admin.view(f.admin.accountId).revision,
    requestId: randomUUID(),
    reason: 'Synthetic identity88 native turn',
    ...extra,
  });
  admin.settings(
    f.admin.accountId,
    command({
      policy: { mode: 'selected', limits: { dailyRequests: 100, monthlyBudgetRub: 100000 } },
      providers: { llm: { provider: 'timeweb' } },
      timewebApiKey: 'synthetic-timeweb-identity88-key',
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
  let proposed,
    calls = 0,
    intent = 'clientCard';
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
              message: {
                content: JSON.stringify(intentEnvelope({ intent, query: proposed })),
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 20 },
        });
      },
    },
  );
  for (const arthur of [true, false])
    for (const value of [null, '', 'Артём', 'Артём Макартычан']) {
      const clinical = fixture({ arthur });
      proposed = value;
      const current = f.store.session(f.ownerSession.token);
      const context = {
        current,
        platform: f.store,
        token: f.ownerSession.token,
        tenantStore: () => clinical.c.tenantStore(),
        assertCurrent() {
          assert.equal(f.store.session(f.ownerSession.token).role, current.role);
        },
      };
      const before = JSON.stringify(clinical.patients);
      const result = await api.turn(context, {
        policyVersion: api.access(current).policyVersion,
        text: 'Открою карточку Артур',
        newCommand: true,
      });
      assert.equal(result.intent, 'clientCard');
      assert.equal(result.demo, false);
      if (arthur) assert.deepEqual(result.action, { type: 'clientCard', patientId: 'arthur' });
      else {
        assert.equal(result.action, null);
        assert.equal(result.dialogue.step, 'client');
        assert.ok(result.text.trim());
        assert.equal(result.dialogue.manualInputRequired, undefined);
      }
      assert.equal(JSON.stringify(clinical.patients), before);
    }
  assert.equal(
    calls,
    8,
    'The complete native service path consumed each synthetic provider response once',
  );
  for (const arthur of [true, false]) {
    const clinical = fixture({ arthur });
    const current = f.store.session(f.ownerSession.token);
    const context = {
      current,
      platform: f.store,
      token: f.ownerSession.token,
      tenantStore: () => clinical.c.tenantStore(),
      assertCurrent() {},
    };
    proposed = 'Артёма Мыкартычана';
    const initial = await api.turn(context, {
      policyVersion: api.access(current).policyVersion,
      text: 'Открою карточку Артёма Мыкартычана',
      newCommand: true,
    });
    assert.equal(initial.action, null);
    assert.equal(initial.dialogue.options.length, 1);
    const callCount = calls;
    const next = await api.turn(context, {
      policyVersion: api.access(current).policyVersion,
      dialogueId: initial.dialogue.id,
      dialogueVersion: initial.dialogue.version,
      text: 'Открыть карточку Артур',
    });
    if (arthur) assert.deepEqual(next.action, { type: 'clientCard', patientId: 'arthur' });
    else {
      assert.equal(next.action, null);
      assert.equal(next.dialogue.step, 'client');
    }
    assert.equal(
      calls,
      callCount,
      'A bound card correction remains local and never calls the model again',
    );
  }
  assert.equal(calls, 10);
  const clinical = fixture();
  const current = f.store.session(f.ownerSession.token);
  const context = {
    current,
    platform: f.store,
    token: f.ownerSession.token,
    tenantStore: () => clinical.c.tenantStore(),
    assertCurrent() {},
  };
  for (const text of ['Не открывай карточку Артур', 'Открой карточку Артур и удали запись'])
    await assert.rejects(
      api.turn(context, {
        policyVersion: api.access(current).policyVersion,
        text,
        newCommand: true,
      }),
      { status: 400 },
    );
  intent = 'clients';
  proposed = 'Артём';
  await assert.rejects(
    api.turn(context, {
      policyVersion: api.access(current).policyVersion,
      text: 'Открою карточку Артур',
      newCommand: true,
    }),
    { status: 502 },
    'A provider proposing a different action fails before card lookup instead of opening another person',
  );
  assert.equal(calls, 13);
});
