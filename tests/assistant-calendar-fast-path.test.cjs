const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');

test('whole calendar reads bypass all model providers and leave provider usage and ruble reservations unchanged', async (t) => {
  const f = await assistantBoundariesFixture(t, { dailyRequests: 1 });
  f.hooks.llm = () => {
    throw Error('An exact calendar read must never call a model');
  };
  for (const provider of ['codex', 'timeweb', 'demo']) {
    f.settings({
      providers: { llm: { provider } },
      policy: { limits: { monthlyBudgetRub: 0 } },
    });
    const before = f.readState();
    for (const [text, mode, date] of [
      ['Открой записи на 2027-10-21', 'day', '2027-10-21'],
      ['Покажи приёмы на следующую неделю', 'week', null],
      ['Пожалуйста, покажите мне записи за ноябрь 2027.', 'month', '2027-11-01'],
    ]) {
      const reply = await f.request('llm', 'owner', { text });
      assert.equal(reply.intent, 'calendar', text);
      assert.equal(reply.action.mode, mode, text);
      if (date) assert.equal(reply.action.date, date, text);
      assert.equal(reply.action.staffId, f.current('owner').accountId);
      assert.equal(reply.demo, provider === 'demo');
      assert.equal(Object.hasOwn(reply, 'usage'), false, 'no invented model or subscription usage');
      assert.equal(reply.dialogue, undefined);
      assert.equal(reply.action.executionId, undefined);
    }
    const after = f.readState();
    for (const key of ['daily', 'usage', 'reservations'])
      assert.deepEqual(after[key], before[key], key);
  }
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
  const stats = f.api.runtimeStats();
  assert.deepEqual(stats.turns, {
    localCalendar: 9,
    localAvailability: 0,
    localClients: 0,
    localClientCard: 0,
    localPrepareAppointment: 0,
    localHelp: 0,
    model: 0,
  });
  assert.equal(stats.dialogues.active, 0);
  assert.equal(stats.commands.active, 1);
  assert.equal(stats.pending.active, 0);
  assert.doesNotMatch(JSON.stringify(stats), /accountId|organizationId|sessionId|synthetic|2027/);
});

test('bounded denial stays local while alternatives, filters, conditions and writes keep the model path', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.hooks.llm = () => ({ text: 'synthetic malformed model output' });
  await assert.rejects(f.request('llm', 'owner', { text: 'Не открывай записи на завтра' }), {
    status: 400,
  });
  assert.equal(f.calls.llm, 0);
  const commands = [
    'Открой записи на завтра или послезавтра',
    'Открой записи на завтра у Ивановой',
    'Открой записи на 31 февраля',
    'Открой записи, если завтра свободно',
    'Открой записи на завтра и удали запись Ивановой',
    'Открой запись Ивановой',
    'Открой карточку Ивановой, если она найдётся',
    'Запиши Иванову на завтра у Петровой',
    'Перенеси запись Ивановой на завтра',
    'Отмени запись Ивановой',
  ];
  for (const text of commands) {
    const before = f.calls.llm;
    await assert.rejects(f.request('llm', 'owner', { text }), { status: 502 }, text);
    assert.equal(f.calls.llm, before + 1, text);
  }
});

test('fast calendar reads still reject disabled categories, revoked grants and stale policy without provider calls', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.settings({ policy: { commands: { calendar: false } } });
  await assert.rejects(f.request('llm', 'owner', { text: 'Покажи записи на завтра' }), {
    status: 403,
  });
  f.settings({ policy: { commands: { calendar: true } } });
  await assert.rejects(
    f.request('llm', 'owner', {
      text: 'Покажи записи на завтра',
      policyVersion: f.revision() - 1,
    }),
    { status: 409 },
  );
  f.grant('owner', false);
  await assert.rejects(f.request('llm', 'owner', { text: 'Покажи записи на завтра' }), {
    status: 403,
  });
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
});

test('fresh fast-path admission checks and a disconnected transport cannot return a calendar action', async (t) => {
  const f = await assistantBoundariesFixture(t),
    c = f.context();
  const current = c.assertCurrent;
  let checks = 0;
  c.assertCurrent = () => {
    current();
    if (++checks === 3) f.grant('owner', false);
  };
  await assert.rejects(
    f.api.turn(c, {
      text: 'Открой записи на завтра',
      policyVersion: f.revision(),
    }),
    { status: 403 },
  );
  f.grant('owner');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.api.turn(
      { ...f.context(), transportAbortSignal: controller.signal },
      {
        text: 'Открой записи на завтра',
        policyVersion: f.revision(),
      },
    ),
    { code: 'ASSISTANT_REQUEST_ABORTED' },
  );
  assert.equal(f.calls.llm, 0);
});

test('a completed local command fences an older provider result instead of reviving its action', async (t) => {
  const f = await assistantBoundariesFixture(t);
  let finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.hooks.llm = () =>
    new Promise((resolve) => {
      finish = resolve;
      entered();
    });
  const older = assert.rejects(f.request('llm', 'owner', { text: 'Календарь' }), { status: 409 });
  await started;
  const latest = await f.request('llm', 'owner', { text: 'Открой записи на 2027-10-21' });
  assert.equal(latest.action.date, '2027-10-21');
  finish({ text: JSON.stringify(intentEnvelope({ intent: 'calendar', date: '2027-11-01' })) });
  await older;
  assert.equal(f.calls.llm, 1);
});

test('paid local commands consume one package task and issue a scoped speech permit without any provider reservation', async (t) => {
  const f = await assistantBoundariesFixture(t);
  const events = [],
    request = randomUUID();
  let accepted = false,
    savedTicket;
  const packages = {
    reserveTask(input) {
      assert.equal(input.current.organizationId, f.current('owner').organizationId);
      assert.equal(input.requestId, request);
      events.push('reserve-task');
      savedTicket = { id: randomUUID(), grantId: randomUUID(), requestId: request, attempt: 1 };
      return savedTicket;
    },
    acceptTask(ticket, proof) {
      assert.equal(ticket, savedTicket);
      assert.equal(proof.outbound, undefined, 'a local action has no provider outbound');
      accepted = true;
      events.push('accept-task');
    },
    requireAcceptedTask({ current, requestId }) {
      assert.equal(accepted, true);
      assert.equal(current.accountId, f.current('owner').accountId);
      assert.equal(requestId, request);
      return savedTicket;
    },
    rejectTask() {
      events.push('reject-task');
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
            throw Error('Local reads must not reserve provider money');
          },
        },
      },
    },
    { directory: f.platformDirectory, ...f.ports, speechPermitCapacity: 1 },
  );
  const before = f.readState();
  const reply = await api.turn(f.context(), {
    text: 'Открой записи на завтра',
    policyVersion: f.revision(),
    taskRequestId: request,
  });
  assert.equal(reply.action.type, 'calendar');
  assert.equal(reply.taskRequestId, request);
  assert.ok(reply.speechPermit.token);
  assert.equal(reply.usage, undefined);
  assert.deepEqual(events, ['reserve-task', 'accept-task']);
  assert.equal(f.calls.llm, 0);
  assert.deepEqual(f.readState(), before);
  await assert.rejects(
    api.turn(f.context(), {
      text: 'Календарь',
      policyVersion: f.revision(),
      taskRequestId: randomUUID(),
    }),
    { status: 503, code: 'ASSISTANT_SPEECH_PERMIT_CAPACITY' },
  );
  assert.deepEqual(
    events,
    ['reserve-task', 'accept-task'],
    'capacity is checked before task or model admission',
  );
  assert.equal(f.calls.llm, 0);
  await assert.rejects(
    api.speak(f.context(), {
      policyVersion: f.revision(),
      taskRequestId: request,
      text: 'Посторонний ответ',
      speechToken: reply.speechPermit.token,
    }),
    { code: 'ASSISTANT_SPEECH_PROOF_REQUIRED' },
  );
});
