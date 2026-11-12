const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('../src/shared/errors.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createAssistantDialogue } = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const {
  createAppointmentExecution,
} = require('../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
const { createScheduleBooking } = require('../src/server/modules/schedules/booking.cjs');
const { createServiceCatalog } = require('../src/server/modules/services/catalog.cjs');
const { defaults } = require('../src/server/modules/workspace/policy.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const NOW = Date.parse(day + 'T05:00:00Z');
const gate = () => {
  let resolve;
  return {
    promise: new Promise((r) => {
      resolve = r;
    }),
    resolve: () => resolve(),
  };
};
function fixture(
  t,
  {
    enabled = true,
    closed = false,
    confirmClosed = false,
    failWritten = false,
    recovery = false,
    move = false,
  } = {},
) {
  const f = dialogueFixture();
  if (move)
    f.patients[0].appointments = [
      {
        id: randomUUID(),
        date: day,
        time: '10:00',
        duration: 30,
        staffId: 'owner',
        roomId: 'main',
        status: 'scheduled',
        service: 'Историческая услуга',
        serviceItems: [
          {
            id: 'archived',
            name: 'Историческая услуга',
            category: 'other',
            duration: 30,
            price: 700,
          },
        ],
        notes: 'Synthetic original',
      },
    ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-execute-synthetic-'));
  const storage = createStorage(directory);
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  storage.write({
    revision: 0,
    patients: f.patients.map((p) => ({ ...p, visits: [] })),
    services: [{ ...f.services[0], duration: '30', category: 'other', price: 100 }],
  });
  const workspace = defaults('owner');
  workspace.enabled = false;
  workspace.rooms[0].preventOverlap = false;
  const days = {
    [day]: { status: closed ? 'closed' : 'working', intervals: closed ? [] : [['09:00', '18:00']] },
  };
  const hooks = {},
    personal = [];
  let revoked = false,
    calls = 0,
    insideLock = false,
    savedAtLock = 0,
    recoveries = 0;
  f.state.providers = { llm: { provider: 'codex', model: 'synthetic-no-provider' } };
  const standaloneServices = storage.readServices;
  storage.readServices = () => {
    assert.equal(
      insideLock,
      false,
      'standalone readServices must never enter the existing cabinet writer',
    );
    return standaloneServices();
  };
  f.c.req = { headers: {}, aborted: false };
  f.c.res = { destroyed: false };
  f.c.tenantStore = () => storage;
  f.c.assertCurrent = () => {
    if (revoked) throw fail(403, 'Synthetic revoked access');
  };
  const booking = createScheduleBooking(
    { key: Buffer.alloc(32, 7), fail, organizationTimeZone: () => 'Europe/Moscow' },
    {
      day: (_org, staff, date) => (staff === 'organization' ? undefined : days[date]),
      profile: () => ({ revision: 1 }),
      authorize(actor, staff) {
        if (actor.role === 'cosmetologist' && staff !== actor.accountId)
          throw fail(403, 'Synthetic foreign staff');
      },
    },
  );
  Object.assign(f.c.platform, {
    session: () => (revoked ? null : f.c.current),
    subscription: () => ({
      status: 'active',
      limits: { patients: 1000, photos: 1000, services: 1000 },
    }),
    workspaceIdentities: () => f.members,
    workspaceSettings: () => workspace,
    notificationChannels: { enabled: () => false },
    appointmentConfirmations: { invalidateChanges() {} },
    telegram: { cancelPending() {} },
    assertServiceGroups() {},
    assertWorkspaceSelection() {},
    async withAsyncWriteLock(callback) {
      if (hooks.beforeCommit) await hooks.beforeCommit();
      insideLock = true;
      try {
        return callback();
      } finally {
        insideLock = false;
      }
    },
    personalEvents: { occupancy: () => personal, assertAppointments() {} },
    workSchedules: {
      view: () => ({ days, closures: {} }),
      check: (_token, appointment) => booking.check(f.c.current, appointment),
      assertChanges: (actor, before, next, ack, identities) =>
        booking.assertChanges(actor, before, next, ack, identities),
    },
  });
  f.c.platform.assertServiceCatalog = createServiceCatalog(f.c.platform).assertServiceCatalog;
  const scope = (c, version) => {
    c.assertCurrent();
    if (version !== f.state.revision) throw fail(409, 'Synthetic stale policy');
    return { state: f.state, member: f.member };
  };
  const memory = createAssistantDialogue({ appointmentSavingEnabled: enabled });
  const flow = move
    ? createAppointmentManagementFlow({ memory, appointmentSavingEnabled: enabled })
    : memory;
  let result = flow.start(
    f.c,
    {
      intent: move ? 'moveAppointment' : 'prepareAppointment',
      query: 'Анна Семёнова',
      ...(move ? {} : { serviceQuery: 'Чистка' }),
      date: day,
      time: move ? '12:00' : '10:00',
    },
    f.state,
    f.member,
    f.clock,
    memory.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: true, createRequested: true },
  );
  if (closed && confirmClosed)
    result = flow.continueDialogue(
      f.c,
      {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        text: 'да',
      },
      f.state,
      f.member,
      f.clock,
    );
  const api = createAppointmentExecution({
    dialogues: memory,
    scope,
    currentScope: (c) => scope(c, f.state.revision),
    enabled,
    now: () => NOW,
    ...(recovery
      ? {
          recoverExecutionTime(c, entry, fresh, error) {
            recoveries++;
            return flow.recoverExecutionTime(c, entry, fresh.state, fresh.member, f.clock, error);
          },
        }
      : {}),
    async commit(c, body, options) {
      calls++;
      if (hooks.beforeMutation) await hooks.beforeMutation(c, body, options);
      const written = options.trustedCommit.written;
      options.trustedCommit.written = (store) => {
        assert.equal(insideLock, true, 'marker and appointment must share the writer transaction');
        written(store);
        if (failWritten) throw fail(503, 'Synthetic failure after writing marker');
        savedAtLock++;
      };
      const saved = await saveMutation(c, body, options);
      if (hooks.afterMutation) await hooks.afterMutation();
      return saved;
    },
  });
  const body = () => ({ executionId: result.action.executionId, policyVersion: f.state.revision });
  const appointments = () => storage.read().patients.flatMap((p) => p.appointments);
  const entry = () =>
    memory.get(f.c, f.member, f.state, result.action?.executionId || result.dialogue.id);
  const answer = (operation) => {
    const current = entry();
    result = flow.continueDialogue(
      f.c,
      { dialogueId: current.id, dialogueVersion: current.version, ...operation },
      f.state,
      f.member,
      f.clock,
    );
    return result;
  };
  return {
    ...f,
    storage,
    days,
    hooks,
    personal,
    flow,
    api,
    get result() {
      return result;
    },
    answer,
    body,
    appointments,
    entry,
    calls: () => calls,
    savedAtLock: () => savedAtLock,
    recoveries: () => recoveries,
    revoke: () => {
      revoked = true;
    },
  };
}

test('ready action does not save in turn; execute uses real mutation pipeline and confirms only its committed appointment', async (t) => {
  const f = fixture(t),
    before = f.storage.get('revision');
  assert.equal(f.result.action.type, 'createAppointment');
  assert.equal(f.result.text, 'Записываю.');
  assert.equal(f.appointments().length, 0);
  assert.equal(f.storage.get('revision'), before);
  const result = await f.api.execute(f.c, f.body());
  assert.equal(result.saved, true);
  assert.match(result.text, /^Записал:/u);
  assert.equal(result.action.type, 'calendar');
  assert.equal(f.calls(), 1);
  assert.equal(f.savedAtLock(), 1);
  assert.equal(f.appointments().length, 1);
  const appointment = f.appointments()[0];
  assert.equal(appointment.id, result.appointmentId);
  assert.equal(appointment.service, 'Чистка');
  assert.equal(appointment.serviceItems[0].price, 100);
  assert.equal(appointment.duration, 30);
  assert.equal(appointment.status, 'scheduled');
});

test('same-token concurrent execution coalesces and a repeated commit never creates another appointment', async (t) => {
  const f = fixture(t),
    wait = gate(),
    entered = gate();
  f.hooks.beforeCommit = async () => {
    entered.resolve();
    await wait.promise;
  };
  const first = f.api.execute(f.c, f.body());
  await entered.promise;
  const second = f.api.execute(f.c, f.body());
  wait.resolve();
  const replies = await Promise.all([first, second]);
  assert.ok(replies.every((r) => r.saved));
  assert.equal(replies[1].alreadySaved, true);
  assert.equal(f.calls(), 1);
  assert.equal(f.appointments().length, 1);
  assert.equal((await f.api.execute(f.c, f.body())).alreadySaved, true);
});

test('permanent marker reconciles after deletion, dialogue expiry, changed policy and a new login without resurrection', async (t) => {
  const f = fixture(t),
    request = f.body();
  const first = await f.api.execute(f.c, request);
  const next = f.storage.read();
  next.patients[0].appointments = [];
  f.storage.write(next);
  f.flow.clearSession(f.c.current.sessionId);
  f.c.current.sessionId = randomUUID();
  f.state.revision++;
  const replay = await f.api.execute(f.c, request);
  assert.equal(replay.saved, true);
  assert.equal(replay.alreadySaved, true);
  assert.equal(replay.appointmentId, first.appointmentId);
  assert.equal(replay.policyVersion, f.state.revision);
  assert.equal(replay.action, null);
  assert.equal(f.appointments().length, 0);
  assert.equal(f.calls(), 1);
});

test('post-marker failure rolls back appointment and permanent marker in the same cabinet transaction', async (t) => {
  const f = fixture(t, { failWritten: true });
  const before = f.storage.get('revision');
  await assert.rejects(f.api.execute(f.c, f.body()), { status: 503 });
  assert.equal(f.appointments().length, 0);
  assert.equal(f.storage.get('revision'), before);
  assert.equal(
    f.storage.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'assistant-created:%'").get()
      .n,
    0,
  );
});

for (const change of ['occupancy', 'service', 'client', 'permission'])
  test(
    'fresh commit guard rejects a changed ' + change + ' after asynchronous image preparation',
    async (t) => {
      const f = fixture(t);
      f.hooks.beforeCommit = () => {
        if (change === 'permission') {
          f.revoke();
          return;
        }
        const next = f.storage.read();
        if (change === 'service') next.services[0].price = 200;
        else if (change === 'client') {
          next.patients[0].firstName = 'Ольга';
          next.patients[0].name = 'Ольга Семёнова';
        } else
          next.patients[0].appointments.push({
            id: randomUUID(),
            date: day,
            time: '10:00',
            duration: 30,
            staffId: 'owner',
            roomId: 'main',
            status: 'scheduled',
            service: 'Другая запись',
            notes: '',
          });
        f.storage.write(next);
      };
      await assert.rejects(f.api.execute(f.c, f.body()), {
        status: change === 'permission' ? 403 : 409,
      });
      assert.equal(f.appointments().filter((a) => a.id === 'a' + f.body().executionId).length, 0);
      assert.equal(f.savedAtLock(), 0);
    },
  );

test('one closed-day confirmation becomes a bound schedule acknowledgement with no second question', async (t) => {
  const f = fixture(t, { closed: true, confirmClosed: true });
  assert.equal(f.result.action.type, 'createAppointment');
  assert.equal((await f.api.execute(f.c, f.body())).saved, true);
  assert.equal(f.appointments().length, 1);
  assert.equal(f.days[day].status, 'closed', 'saving an exception does not open the working day');
});

test('unconfirmed closed day, incomplete token, management target and demo mode cannot execute', async (t) => {
  const closed = fixture(t, { closed: true });
  assert.equal(closed.result.dialogue.phase, 'closedDay');
  await assert.rejects(
    closed.api.execute(closed.c, {
      executionId: closed.result.dialogue.id,
      policyVersion: closed.state.revision,
    }),
    { status: 409 },
  );
  const f = fixture(t);
  const entry = f.entry();
  entry.data.target = 'appointmentManagement';
  await assert.rejects(f.api.execute(f.c, f.body()), { status: 409 });
  delete entry.data.target;
  f.state.providers.llm.provider = 'demo';
  await assert.rejects(f.api.execute(f.c, f.body()), { status: 403 });
  assert.equal(f.appointments().length, 0);
});

test('feature remains default off and unknown client fields cannot create a permission or override', async (t) => {
  const f = fixture(t, { enabled: false });
  assert.equal(f.result.action.type, 'prepareAppointment');
  await assert.rejects(
    f.api.execute(f.c, { executionId: randomUUID(), policyVersion: f.state.revision }),
    { status: 403 },
  );
  const enabled = fixture(t);
  for (const extra of [
    { allowClosedDay: true },
    { staffId: 'other' },
    { patientId: randomUUID() },
    { appointmentId: randomUUID() },
  ])
    await assert.rejects(enabled.api.execute(enabled.c, { ...enabled.body(), ...extra }), {
      status: 400,
    });
  assert.equal(enabled.appointments().length, 0);
});

test('missing uncommitted memory is definitive, while a marker from another account is never exposed', async (t) => {
  const f = fixture(t),
    request = f.body();
  f.flow.clearSession(f.c.current.sessionId);
  const expired = await f.api.execute(f.c, request);
  assert.equal(expired.saved, false);
  assert.equal(expired.definitive, true);
  assert.equal(expired.code, 'ASSISTANT_EXECUTION_EXPIRED');
  assert.equal(f.calls(), 0);
  const other = fixture(t),
    otherRequest = other.body();
  await other.api.execute(other.c, otherRequest);
  other.c.current = { ...other.c.current, accountId: 'another-account', sessionId: randomUUID() };
  const hidden = await other.api.execute(other.c, otherRequest);
  assert.equal(hidden.saved, false);
  assert.equal(other.calls(), 1);
});

test('actual HTTP createMultiServer context executes and reconciles with real platform locks and a synthetic model transport', async (t) => {
  const { adminFixture } = require('./helpers/admin-fixture.cjs');
  const { createMultiServer } = require('../multi-server.cjs');
  const http = require('node:http');
  const f = await adminFixture(t),
    actor = f.admin.accountId,
    owner = f.owner.accountId;
  const command = (revision, values) => ({
    expectedRevision: revision,
    requestId: randomUUID(),
    reason: 'Synthetic HTTP appointment execution regression',
    ...values,
  });
  let view = f.store.assistant.admin.view(actor);
  view = f.store.assistant.admin.settings(
    actor,
    command(view.revision, {
      policy: { mode: 'selected' },
      timewebApiKey: 'synthetic-http-execution-key',
      providers: { llm: { provider: 'timeweb' } },
    }),
  );
  f.store.assistant.admin.setMember(
    actor,
    command(view.revision, {
      organizationId: f.owner.organizationId,
      accountId: owner,
      enabled: true,
    }),
  );
  const tenant = createStorage(path.join(f.directory, 'tenants', f.owner.organizationId));
  f.cleanup(() => tenant.close());
  const patientId = randomUUID(),
    serviceId = randomUUID();
  tenant.write({
    revision: 0,
    patients: [
      {
        id: patientId,
        firstName: 'Анна',
        lastName: 'Семёнова',
        name: 'Анна Семёнова',
        phone: '+79991112233',
        createdBy: owner,
        appointments: [],
        visits: [],
      },
    ],
    services: [
      {
        id: serviceId,
        staffId: owner,
        name: 'Консультация',
        duration: '60',
        price: 100,
        category: 'other',
      },
    ],
  });
  const zone = f.store.organizationTimeZone(f.owner.organizationId);
  const schedule = f.store.workSchedules.view(f.ownerSession.token, owner, day, day);
  f.store.workSchedules.save(
    f.ownerSession.token,
    {
      staffId: owner,
      dates: [day],
      status: 'working',
      intervals: [['09:00', '18:00']],
      revision: schedule.revision,
      expectedTimeZone: zone,
    },
    tenant,
  );
  let providerCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(
      url,
      'https://api.timeweb.ai/v1/chat/completions',
      'no unplanned outbound transport',
    );
    assert.equal(options.method, 'POST');
    providerCalls++;
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                intent: 'prepareAppointment',
                query: 'Анну Семёнову',
                serviceQuery: 'консультацию',
                date: day,
                time: providerCalls === 1 ? '10:00' : '00:00',
                ...(providerCalls === 1 ? {} : { duration: 720 }),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const server = createMultiServer({
    dataDir: f.directory,
    host: '127.0.0.1',
    port: 0,
    production: false,
    origin: '',
    additionalOrigins: [],
    trustedProxies: [],
    processRole: 'web',
    assistantAppointmentSavingEnabled: true,
    releaseGate: false,
    sendMail: null,
    telegramBot: null,
    supportBot: null,
    supportDelivery: { telegram: null, email: null },
    telegramAutostart: false,
    telegramIdentityAutostart: false,
    maxAutostart: false,
    pushAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
    commonNotificationsEnabled: false,
    scheduledNotifications: false,
    maxEnabled: false,
    maxConnectionsEnabled: false,
    pushEnabled: false,
  });
  f.cleanup(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      }),
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port,
    origin = 'http://127.0.0.1:' + port;
  function request(url, body) {
    return new Promise((resolve, reject) => {
      const raw = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        origin + url,
        {
          method: raw === null ? 'GET' : 'POST',
          headers: {
            Cookie: 'cartoteca_v2_session=' + f.ownerSession.token,
            ...require('./helpers/account-context.cjs').authContextHeaders(f.ownerSession),
            Origin: origin,
            'X-Cartoteca-Request': '1',
            'Content-Type': 'application/json',
            ...(raw === null ? {} : { 'Content-Length': Buffer.byteLength(raw) }),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      if (raw !== null) req.write(raw);
      req.end();
    });
  }
  const scoped = await request('/api/assistant/scope');
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.appointmentSavingEnabled, true);
  const turn = await request('/api/assistant/turn', {
    policyVersion: scoped.body.policyVersion,
    text: 'Запиши Анну Семёнову на консультацию 2099-01-05 в 10:00.',
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.body));
  assert.equal(turn.body.action?.type, 'createAppointment', JSON.stringify(turn.body));
  assert.equal(tenant.readSelected([patientId]).patients[0].appointments.length, 0);
  const executeBody = {
    executionId: turn.body.action.executionId,
    policyVersion: turn.body.policyVersion,
  };
  const saved = await request('/api/assistant/execute', executeBody);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.saved, true);
  assert.match(saved.body.text, /^Записал:/u);
  assert.equal(saved.body.action.type, 'calendar');
  assert.equal(tenant.readSelected([patientId]).patients[0].appointments.length, 1);
  const replay = await request('/api/assistant/execute', executeBody);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.alreadySaved, true);
  assert.equal(tenant.readSelected([patientId]).patients[0].appointments.length, 1);
  assert.equal(providerCalls, 1, 'execution never calls a provider');
  const clockTurn = await request('/api/assistant/turn', {
    policyVersion: scoped.body.policyVersion,
    text: 'Запиши Анну Семёнову на консультацию 2099-01-05 на двенадцать часов.',
  });
  assert.equal(clockTurn.status, 200, JSON.stringify(clockTurn.body));
  assert.equal(clockTurn.body.action?.type, 'createAppointment', JSON.stringify(clockTurn.body));
  assert.equal(tenant.readSelected([patientId]).patients[0].appointments.length, 1);
  const clockBody = {
    executionId: clockTurn.body.action.executionId,
    policyVersion: clockTurn.body.policyVersion,
  };
  const clockSave = await request('/api/assistant/execute', clockBody);
  assert.equal(clockSave.status, 200, JSON.stringify(clockSave.body));
  assert.equal(clockSave.body.saved, true);
  const appointments = tenant.readSelected([patientId]).patients[0].appointments;
  assert.equal(appointments.length, 2);
  const noon = appointments.find((row) => row.time === '12:00');
  assert.ok(noon, 'spoken twelve hours is a noon start, overriding an unproven model time');
  assert.equal(Number(noon.duration), 60, 'catalog duration wins over an unproven model 720');
  const clockReplay = await request('/api/assistant/execute', clockBody);
  assert.equal(clockReplay.status, 200);
  assert.equal(clockReplay.body.alreadySaved, true);
  assert.equal(tenant.readSelected([patientId]).patients[0].appointments.length, 2);
  assert.equal(
    providerCalls,
    2,
    'only two initial synthetic model parses; no execution/replay provider calls',
  );
});

for (const move of [false, true])
  test(
    'a ' +
      (move ? 'move' : 'create') +
      ' occupancy race returns replayable time input, then saves the corrected time exactly once',
    async (t) => {
      const f = fixture(t, { recovery: true, move }),
        request = f.body();
      const source = structuredClone(f.appointments()[0] || null),
        ready = structuredClone(f.entry().data);
      const wait = gate(),
        entered = gate();
      f.hooks.beforeCommit = async () => {
        entered.resolve();
        await wait.promise;
      };
      const first = f.api.execute(f.c, request);
      await entered.promise;
      const duplicate = f.api.execute(f.c, request);
      f.personal.push({
        id: randomUUID(),
        date: day,
        time: move ? '12:00' : '10:00',
        duration: 30,
        staffId: 'owner',
        roomId: 'main',
        status: 'scheduled',
      });
      wait.resolve();
      const [reply, concurrent] = await Promise.all([first, duplicate]);
      assert.equal(reply.saved, false);
      assert.equal(reply.definitive, true);
      assert.equal(reply.code, 'ASSISTANT_EXECUTION_REQUIRES_INPUT');
      assert.equal(reply.recovery.action, null);
      assert.equal(reply.recovery.dialogue.step, 'time');
      assert.equal(reply.recovery.policyVersion, f.state.revision);
      assert.deepEqual(concurrent, reply);
      assert.deepEqual(await f.api.execute(f.c, request), reply);
      assert.equal(
        f.recoveries(),
        1,
        'concurrent/repeated execution must not clear or advance the dialogue again',
      );
      assert.equal(f.entry().version, reply.recovery.dialogue.version);
      assert.equal(f.entry().complete, false);
      assert.equal(f.savedAtLock(), 0);
      assert.deepEqual(f.appointments(), source ? [source] : []);
      const state = f.entry().data;
      assert.equal(state.patient.id, ready.patient.id);
      if (move) {
        assert.deepEqual(state.management.source, ready.management.source);
        assert.equal(state.management.targetDate, day);
      } else {
        assert.equal(state.service.id, ready.service.id);
        assert.equal(state.staff.id, ready.staff.id);
        assert.equal(state.date, day);
        assert.equal(state.duration, 30);
      }
      f.hooks.beforeCommit = null;
      f.answer({ text: move ? '13:00' : '11:00' });
      assert.equal(f.result.action.type, move ? 'moveAppointment' : 'createAppointment');
      const saved = await f.api.execute(f.c, f.body());
      assert.equal(saved.saved, true);
      assert.equal(f.savedAtLock(), 1);
      const appointments = f.appointments();
      assert.equal(appointments.length, 1);
      assert.equal(appointments[0].time, move ? '13:00' : '11:00');
      if (move) {
        assert.equal(appointments[0].id, source.id);
        assert.deepEqual(appointments[0].serviceItems, source.serviceItems);
        assert.equal(appointments[0].notes, source.notes);
      }
      assert.equal((await f.api.execute(f.c, request)).alreadySaved, true);
      assert.equal(f.appointments().length, 1);
      assert.equal(f.savedAtLock(), 1);
    },
  );

test('recovery never bypasses a changed policy or revoked actor', async (t) => {
  for (const change of ['policy', 'actor']) {
    const f = fixture(t, { recovery: true }),
      request = f.body();
    f.personal.push({ date: day, time: '10:00', duration: 30, staffId: 'owner' });
    const reply = await f.api.execute(f.c, request);
    assert.equal(reply.code, 'ASSISTANT_EXECUTION_REQUIRES_INPUT');
    if (change === 'policy') f.state.revision++;
    else f.revoke();
    if (change === 'policy') {
      const expired = await f.api.execute(f.c, request);
      assert.equal(expired.code, 'ASSISTANT_EXECUTION_EXPIRED');
      assert.equal(expired.saved, false);
      assert.equal(expired.definitive, true);
      assert.equal(expired.recovery, undefined);
      assert.equal(expired.policyVersion, f.state.revision);
    } else await assert.rejects(f.api.execute(f.c, request), { status: 403 });
    assert.equal(f.appointments().length, 0);
    assert.equal(f.recoveries(), 1);
  }
});

test('unknown execution failure leaves the unresolved action and never fabricates time recovery', async (t) => {
  const f = fixture(t, { recovery: true }),
    request = f.body();
  const before = structuredClone(f.entry().data);
  f.hooks.beforeMutation = () => {
    throw fail(500, 'Synthetic unknown write outcome');
  };
  await assert.rejects(f.api.execute(f.c, request), { status: 500 });
  assert.equal(f.entry().complete, true);
  assert.deepEqual(f.entry().data, before);
  assert.equal(f.entry().executionRecovery, undefined);
  assert.equal(f.recoveries(), 0);
  assert.equal(f.appointments().length, 0);
  assert.equal(
    f.storage.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'assistant-created:%'").get()
      .n,
    0,
  );
});

test('a durable cabinet commit wins over a later typed time error and does not reopen dialogue', async (t) => {
  const f = fixture(t, { recovery: true });
  f.hooks.afterMutation = () => {
    throw Object.assign(fail(409, 'Synthetic lost acknowledgement'), {
      code: 'ASSISTANT_TIME_UNAVAILABLE',
    });
  };
  const reply = await f.api.execute(f.c, f.body());
  assert.equal(reply.saved, true);
  assert.equal(reply.alreadySaved, true);
  assert.equal(reply.recovery, undefined);
  assert.equal(f.recoveries(), 0);
  assert.equal(f.appointments().length, 1);
  assert.equal(f.savedAtLock(), 1);
  assert.equal((await f.api.execute(f.c, f.body())).alreadySaved, true);
  assert.equal(f.calls(), 1);
});

test('a typed five-minute cabinet rejection recovers only the time and the revised action can really commit', async (t) => {
  const f = fixture(t, { recovery: true }),
    request = f.body();
  const known = structuredClone(f.entry().data);
  f.hooks.beforeMutation = (_context, body) => {
    // Simulate a stale prepared payload; the real cabinet validator supplies the typed error.
    f.entry().data.time = '10:01';
    body.changes[0].after.time = '10:01';
  };
  const reply = await f.api.execute(f.c, request);
  assert.equal(reply.code, 'ASSISTANT_EXECUTION_REQUIRES_INPUT');
  assert.equal(reply.recovery.dialogue.step, 'time');
  assert.match(reply.recovery.text, /5 минут/u);
  const after = f.entry().data;
  assert.equal(after.time, null);
  for (const key of ['patient', 'staff', 'service', 'date', 'duration'])
    assert.deepEqual(after[key], known[key]);
  assert.equal(f.appointments().length, 0);
  f.hooks.beforeMutation = null;
  f.answer({ text: '11:00' });
  assert.equal((await f.api.execute(f.c, f.body())).saved, true);
  assert.equal(f.appointments()[0].time, '11:00');
  assert.equal(f.savedAtLock(), 1);
});

test('an unrelated conflict or false grid error never turns into a fabricated time question', async (t) => {
  for (const code of ['SYNTHETIC_OTHER_CONFLICT', 'APPOINTMENT_TIME_STEP']) {
    const f = fixture(t, { recovery: true });
    f.hooks.beforeMutation = () => {
      throw Object.assign(fail(409, 'Synthetic non-time conflict'), { code });
    };
    await assert.rejects(f.api.execute(f.c, f.body()), { status: 409, code });
    assert.equal(f.entry().complete, true);
    assert.equal(f.entry().executionRecovery, undefined);
    assert.equal(f.appointments().length, 0);
  }
});

test('a typed unavailable-time error cannot recover under policy or actor changes during execution', async (t) => {
  for (const change of ['policy', 'actor']) {
    const f = fixture(t, { recovery: true });
    f.hooks.beforeMutation = () => {
      if (change === 'policy') f.state.revision++;
      else f.revoke();
      throw Object.assign(fail(409, 'Synthetic time race with changed access'), {
        code: 'ASSISTANT_TIME_UNAVAILABLE',
      });
    };
    await assert.rejects(f.api.execute(f.c, f.body()), { status: change === 'policy' ? 409 : 403 });
    assert.equal(f.recoveries(), 0);
    assert.equal(f.appointments().length, 0);
    assert.equal(f.savedAtLock(), 0);
  }
});
