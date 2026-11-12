const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');

async function fixture(t, options) {
  const f = await assistantBoundariesFixture(t, options),
    clinical = dialogueFixture();
  clinical.patients[0].createdBy = f.current('owner').accountId;
  function context(role = 'owner') {
    const c = f.context(role);
    return {
      ...c,
      tenantStore(organizationId) {
        assert.equal(organizationId, c.current.organizationId);
        return clinical.c.tenantStore();
      },
    };
  }
  const turn = (text, values = {}, role = 'owner', api = f.api) =>
    api.turn(context(role), { policyVersion: f.revision(), text, ...values });
  return { ...f, clinical, context, turn };
}

test('infinitive card opening removes one model request while retaining the canonical action and literal identity', async (t) => {
  const f = await fixture(t);
  f.hooks.llm = () => ({
    text: JSON.stringify(intentEnvelope({ intent: 'clientCard', query: 'Анны Семёновой' })),
  });
  const before = structuredClone(f.clinical.patients);
  const canonical = await f.turn('Открою карточку Анны Семёновой');
  assert.equal(f.calls.llm, 1);
  const local = await f.turn('Открыть карточку Анны Семёновой');
  assert.equal(f.calls.llm, 1, 'the infinitive request must remove its former model call');
  assert.deepEqual(local.action, canonical.action);
  assert.deepEqual(local.action, { type: 'clientCard', patientId: f.clinical.patients[0].id });
  assert.equal(local.usage, undefined);
  assert.deepEqual(f.clinical.patients, before);
});

test('literal client reads bypass every model provider without inventing usage or changing provider budgets', async (t) => {
  const f = await fixture(t, { dailyRequests: 1 });
  f.hooks.llm = () => assert.fail('A whole client read cannot call the model');
  const beforePatients = structuredClone(f.clinical.patients);
  for (const provider of ['codex', 'timeweb', 'demo']) {
    f.settings({ providers: { llm: { provider } }, policy: { limits: { monthlyBudgetRub: 0 } } });
    const before = f.readState();
    for (const [text, type] of [
      ['Найди клиента Анну Семенову', 'clients'],
      ['Открой карточку Анны Семёновой', 'clientCard'],
      ['Открыть карточку Анны Семёновой', 'clientCard'],
      ['Открой карточку +7 (999) 111-22-33', 'clientCard'],
      ['Открой карточку по телефону +79991112233', 'clientCard'],
    ]) {
      const reply = await f.turn(text);
      assert.equal(reply.intent, type, text);
      assert.equal(reply.action.type, type, text);
      if (type === 'clientCard') assert.equal(reply.action.patientId, f.clinical.patients[0].id);
      assert.equal(reply.demo, provider === 'demo');
      assert.equal(Object.hasOwn(reply, 'usage'), false);
      assert.equal(reply.action.executionId, undefined);
      assert.equal(reply.saved, undefined);
    }
    const after = f.readState();
    for (const key of ['daily', 'usage', 'reservations']) assert.deepEqual(after[key], before[key]);
  }
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  assert.deepEqual(f.api.runtimeStats().turns, {
    localCalendar: 0,
    localAvailability: 0,
    localClients: 3,
    localClientCard: 12,
    localPrepareAppointment: 0,
    localHelp: 0,
    model: 0,
  });
  assert.deepEqual(f.clinical.patients, beforePatients);
});

test('an ambiguous surname and an empty card query enter the existing scoped clarification without a model', async (t) => {
  const f = await fixture(t),
    original = f.clinical.patients[0];
  f.clinical.patients.push({
    ...original,
    id: randomUUID(),
    firstName: 'Ольга',
    name: 'Ольга Семёнова',
    phone: '+79991114455',
  });
  f.clinical.changed();
  const before = structuredClone(f.clinical.patients);
  const empty = await f.turn('Открыть карточку');
  assert.equal(empty.action, null);
  assert.equal(empty.dialogue.step, 'client');
  assert.equal(empty.dialogue.options.length, 0);
  const ambiguous = await f.turn('Открыть карточку Семёновой');
  assert.equal(ambiguous.action, null);
  assert.equal(ambiguous.dialogue.options.length, 2);
  await assert.rejects(
    f.api.turn(f.context('salon_admin'), {
      policyVersion: f.revision(),
      dialogueId: ambiguous.dialogue.id,
      dialogueVersion: ambiguous.dialogue.version,
      choice: ambiguous.dialogue.options[0].id,
    }),
    { status: 409 },
  );
  const selected = await f.turn('Анну', {
    dialogueId: ambiguous.dialogue.id,
    dialogueVersion: ambiguous.dialogue.version,
  });
  assert.deepEqual(selected.action, { type: 'clientCard', patientId: original.id });
  assert.equal(selected.dialogue, null);
  assert.equal(f.calls.llm, 0);
  assert.deepEqual(f.clinical.patients, before);
});

test('client fast paths keep the specialist directory ACL and never expose a foreign card choice', async (t) => {
  const f = await fixture(t),
    own = f.clinical.patients[0];
  own.createdBy = f.current('cosmetologist').accountId;
  const hidden = {
    ...own,
    id: randomUUID(),
    createdBy: f.current('owner').accountId,
    firstName: 'Мария',
    lastName: 'Петрова',
    name: 'Мария Петрова',
    phone: '+79990005566',
  };
  f.clinical.patients.push(hidden);
  f.clinical.changed();
  assert.deepEqual((await f.turn('Открой карточку Анны Семёновой', {}, 'cosmetologist')).action, {
    type: 'clientCard',
    patientId: own.id,
  });
  for (const query of ['Марии Петровой', '+79990005566']) {
    for (const prefix of ['Открой карточку ', 'Открыть карточку ']) {
      const reply = await f.turn(prefix + query, {}, 'cosmetologist');
      assert.equal(reply.action, null);
      assert.equal(reply.dialogue.options.length, 0);
      assert.ok(!JSON.stringify(reply).includes(hidden.id));
    }
  }
  assert.equal(f.calls.llm, 0);
});

test('disabled clients, revoked grants, stale policy and aborted transports remain fail-closed before model work', async (t) => {
  const f = await fixture(t);
  for (const text of [
    'Найди клиента Семёнову',
    'Открой карточку Семёновой',
    'Открыть карточку Семёновой',
  ]) {
    f.settings({ policy: { commands: { clients: false } } });
    await assert.rejects(f.turn(text), { status: 403 });
    f.settings({ policy: { commands: { clients: true } } });
    await assert.rejects(f.turn(text, { policyVersion: f.revision() - 1 }), { status: 409 });
    f.grant('owner', false);
    await assert.rejects(f.turn(text), { status: 403 });
    f.grant('owner');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.api.turn(
        { ...f.context(), transportAbortSignal: controller.signal },
        {
          policyVersion: f.revision(),
          text,
        },
      ),
      { code: 'ASSISTANT_REQUEST_ABORTED' },
    );
  }
  assert.equal(f.calls.llm, 0);
});

test('a grant changing during client lookup blocks the final response on both local read branches', async (t) => {
  const f = await fixture(t),
    indexes = f.clinical.c.tenantStore().indexes,
    summaryRows = indexes.summaryRows;
  for (const text of ['Найди клиента Анну Семёнову', 'Открой карточку Анны Семёновой']) {
    let revoked = false;
    indexes.summaryRows = (current) => {
      const rows = summaryRows(current);
      if (!revoked) {
        revoked = true;
        f.grant('owner', false);
      }
      return rows;
    };
    f.clinical.changed();
    await assert.rejects(f.turn(text), { status: 403 });
    assert.equal(revoked, true);
    f.grant('owner');
  }
  assert.equal(f.calls.llm, 0);
});

test('a new local client command fences an older pending provider result', async (t) => {
  const f = await fixture(t);
  let resolve, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  f.hooks.llm = () =>
    new Promise((done) => {
      resolve = done;
      entered();
    });
  const older = f.turn('Календарь');
  const rejected = assert.rejects(older, { status: 409 });
  await started;
  const latest = await f.turn('Открой карточку Анны Семёновой');
  assert.deepEqual(latest.action, { type: 'clientCard', patientId: f.clinical.patients[0].id });
  resolve({ text: JSON.stringify(intentEnvelope({ intent: 'calendar' })) });
  await rejected;
  assert.deepEqual(f.api.runtimeStats().turns, {
    localCalendar: 0,
    localAvailability: 0,
    localClients: 0,
    localClientCard: 1,
    localPrepareAppointment: 0,
    localHelp: 0,
    model: 1,
  });
});

test('out-of-grammar client commands still reach and validate the model instead of silently dropping their tail', async (t) => {
  const f = await fixture(t);
  f.hooks.llm = () => ({ text: 'synthetic malformed model output' });
  for (const text of ['Открой карту сайта', 'Открыть карту мира']) {
    const response = await f.turn(text);
    assert.equal(response.action, null);
    assert.match(response.text, /тип карты помощник не открывает/u);
    assert.equal(f.calls.llm, 0);
  }
  const commands = [
    'Найди Иванову',
    'Можешь найти клиента Иванову',
    'Открою карточку Ивановой',
    'Открой карточку Ивановой или Петровой',
    'Найди клиента Иванову с долгом',
    'Открой карточку Ивановой в 12:00',
    'Найди клиента Иванову по неизвестному фильтру',
    'Открой карточку Ивановой если она есть',
    'Открой карточку Ивановой и удали запись',
    'Запиши Иванову на завтра у Петровой',
    'Не открыть карточку Ивановой',
    'Открыть карточку Ивановой или Петровой',
    'Открыть карточку Ивановой, если она есть',
    'Открыть карточку Ивановой и удали запись',
    'Открыть банковскую карту Ивановой',
  ];
  for (const text of commands) {
    const before = f.calls.llm;
    await assert.rejects(f.turn(text), { status: 502 }, text);
    assert.equal(f.calls.llm, before + 1, text);
  }
  f.hooks.llm = () => ({
    text: JSON.stringify(intentEnvelope({ intent: 'clients', query: 'Ивановой' })),
  });
  await assert.rejects(f.turn('Открою карточку Ивановой'), { status: 502 });
  assert.deepEqual(f.api.runtimeStats().turns, {
    localCalendar: 0,
    localAvailability: 0,
    localClients: 0,
    localClientCard: 0,
    localPrepareAppointment: 0,
    localHelp: 2,
    model: commands.length + 1,
  });
});

test('paid local client reads preserve task accounting and scoped speech proof without reserving LLM money', async (t) => {
  const f = await fixture(t),
    tickets = new Map(),
    events = [];
  const packages = {
    reserveTask(input) {
      assert.equal(input.current.accountId, f.current('owner').accountId);
      const ticket = {
        id: randomUUID(),
        grantId: randomUUID(),
        requestId: input.requestId,
        attempt: 1,
      };
      tickets.set(input.requestId, ticket);
      events.push('reserve');
      return ticket;
    },
    acceptTask(ticket, proof) {
      assert.equal(tickets.get(ticket.requestId), ticket);
      assert.equal(proof.outbound, undefined);
      events.push('accept');
    },
    requireAcceptedTask({ current, requestId }) {
      assert.equal(current.accountId, f.current('owner').accountId);
      return tickets.get(requestId);
    },
    rejectTask() {
      events.push('reject');
    },
  };
  const api = createAssistant(
    {
      ...f.database,
      organizationTimeZone: f.store.organizationTimeZone,
      billing: {
        hasServiceConnection: () => true,
        isServiceEnabled: () => true,
        packages,
        wallet: {
          reserve() {
            assert.fail('Local client reads never reserve LLM money');
          },
        },
      },
    },
    { directory: f.platformDirectory, ...f.ports, speechPermitCapacity: 2 },
  );
  const before = f.readState();
  for (const text of ['Найди клиента Анну Семёнову', 'Открой карточку Анны Семёновой']) {
    const taskRequestId = randomUUID(),
      reply = await f.turn(text, { taskRequestId }, 'owner', api);
    assert.equal(reply.taskRequestId, taskRequestId);
    assert.ok(reply.speechPermit.token);
    assert.equal(reply.usage, undefined);
    await assert.rejects(
      api.speak(f.context(), {
        text: 'Неподписанный ответ',
        policyVersion: f.revision(),
        taskRequestId,
        speechToken: reply.speechPermit.token,
      }),
      { code: 'ASSISTANT_SPEECH_PROOF_REQUIRED' },
    );
  }
  await assert.rejects(
    f.turn('Найди клиента Анну', { taskRequestId: randomUUID() }, 'owner', api),
    { status: 503, code: 'ASSISTANT_SPEECH_PERMIT_CAPACITY' },
  );
  assert.deepEqual(events, ['reserve', 'accept', 'reserve', 'accept']);
  assert.equal(tickets.size, 2);
  assert.equal(api.runtimeStats().speechPermits.reserved, 0);
  assert.equal(f.calls.llm, 0);
  assert.deepEqual(f.readState(), before);
});
