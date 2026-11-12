const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { configuration } = require('../src/server/config.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  createAppointmentExecution,
} = require('../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const { createAssistantDialogue } = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const {
  acquireAssistantExecutorAuthority,
  filename,
} = require('../src/server/infrastructure/assistant-executor-authority.cjs');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const { fail } = require('../src/shared/errors.cjs');

const isolated = {
  production: true,
  origin: 'https://synthetic.example',
  processRole: 'web',
  assistantAppointmentSavingEnabled: true,
  sendMail: null,
  telegramBot: null,
  supportDelivery: { telegram: null, email: null },
  telegramAutostart: false,
  telegramIdentityAutostart: false,
  supportAutostart: false,
  maxAutostart: false,
  pushAutostart: false,
  adminEmailAutostart: false,
  bookingPublicationAutostart: false,
  commonNotificationsEnabled: false,
  scheduledNotifications: false,
  maxConnectionsEnabled: false,
  pushEnabled: false,
  maxEnabled: false,
  releaseGate: false,
};
const close = (server) =>
  new Promise((resolve) => {
    server.once('close', resolve);
    server.close();
    server.closeAllConnections?.();
  });
const command = (revision, values) => ({
  expectedRevision: revision,
  requestId: randomUUID(),
  reason: 'Synthetic production autosave regression',
  ...values,
});
function enable(f) {
  const api = f.store.assistant.admin,
    actor = f.admin.accountId;
  let view = api.view(actor);
  view = api.settings(
    actor,
    command(view.revision, {
      policy: { mode: 'selected' },
      timewebApiKey: 'synthetic-autosave-test-key',
      providers: { llm: { provider: 'timeweb' } },
    }),
  );
  return api.setMember(
    actor,
    command(view.revision, {
      organizationId: f.owner.organizationId,
      accountId: f.owner.accountId,
      enabled: true,
    }),
  );
}

test('production autosave requires exact explicit configuration, with no default enablement', () => {
  assert.equal(configuration({}, {}).assistantAppointmentSavingEnabled, false);
  for (const value of ['', '0', 'true', 'yes', '01', ' 1 '])
    assert.equal(
      configuration({}, { CARTOTECA_ASSISTANT_APPOINTMENT_SAVING: value })
        .assistantAppointmentSavingEnabled,
      false,
    );
  const configured = configuration(
    {},
    {
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://synthetic.example',
      CARTOTECA_ASSISTANT_APPOINTMENT_SAVING: '1',
    },
  );
  assert.equal(configured.assistantAppointmentSavingEnabled, true);
  assert.equal(configured.production, true);
});

test('a production web server holds one authority until normal close and releases it afterwards', async (t) => {
  const f = await adminFixture(t);
  enable(f);
  const server = createMultiServer({ ...isolated, dataDir: f.directory });
  let closed = false;
  f.cleanup(async () => {
    if (!closed) await close(server);
  });
  assert.equal(fs.existsSync(path.join(f.directory, filename)), true);
  assert.throws(() => acquireAssistantExecutorAuthority(f.directory), { status: 503 });
  assert.throws(() => createMultiServer({ ...isolated, dataDir: f.directory }), { status: 503 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/api/assistant/scope',
        headers: {
          Host: 'synthetic.example',
          Cookie: 'cartoteca_v2_session=' + f.ownerSession.token,
          ...require('./helpers/account-context.cjs').authContextHeaders(f.ownerSession),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (part) => chunks.push(part));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.enabled, true);
  assert.equal(response.body.appointmentSavingEnabled, true);
  await close(server);
  closed = true;
  const next = acquireAssistantExecutorAuthority(f.directory);
  next.assertOwned();
  next.close();
});

test('production initialization failure releases authority acquired before the platform was opened', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-assistant-production-'));
  try {
    assert.throws(
      () => createMultiServer({ ...isolated, dataDir: directory }),
      /Initialize an owner/,
    );
    const authority = acquireAssistantExecutorAuthority(directory);
    authority.assertOwned();
    authority.close();
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-assistant-production-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const variant of [
  { name: 'default off', assistantAppointmentSavingEnabled: false },
  { name: 'release gate', releaseGate: true },
  { name: 'background', processRole: 'background' },
  { name: 'preflight', processRole: 'preflight' },
  { name: 'explicit local pilot', production: false, origin: '' },
])
  test(variant.name + ' never acquires production executor authority', async (t) => {
    const f = await adminFixture(t);
    const server = createMultiServer({ ...isolated, ...variant, dataDir: f.directory });
    try {
      assert.equal(fs.existsSync(path.join(f.directory, filename)), false);
      const authority = acquireAssistantExecutorAuthority(f.directory);
      authority.assertOwned();
      authority.close();
    } finally {
      await close(server);
    }
  });

test('loss of authority disables access and fails before model provider or clinical reads', async (t) => {
  const f = await adminFixture(t);
  enable(f);
  let owned = true,
    providers = 0;
  const assistant = createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      appointmentSavingEnabled: true,
      assertExecutorOwned() {
        if (!owned) throw fail(503, 'Synthetic executor authority lost');
      },
      fetchImpl: async () => {
        providers++;
        throw Error('Unexpected provider');
      },
    },
  );
  const actor = f.store.session(f.ownerSession.token),
    allowed = assistant.access(actor);
  assert.equal(allowed.appointmentSavingEnabled, true);
  owned = false;
  assert.equal(assistant.access(actor).enabled, false);
  assert.equal(assistant.access(actor).appointmentSavingEnabled, false);
  const c = {
    current: actor,
    platform: f.store,
    assertCurrent() {},
    tenantStore() {
      assert.fail('No clinical read after ownership loss');
    },
  };
  await assert.rejects(
    assistant.turn(c, { text: 'Покажи расписание', policyVersion: allowed.policyVersion }),
    { status: 503 },
  );
  assert.equal(providers, 0);
});

for (const kind of ['create', 'move', 'cancel'])
  test(
    kind + ': ownership is rechecked inside the common writer before any mutation or marker',
    async (t) => {
      const f = kind === 'cancel' ? cancellationFixture(t) : moveExecutionFixture(t);
      if (kind === 'cancel') f.answer({ text: 'да' });
      let request;
      if (kind === 'create') {
        const memory = createAssistantDialogue({ appointmentSavingEnabled: true });
        const reply = memory.start(
          f.c,
          {
            intent: 'prepareAppointment',
            query: 'Анна Семёнова',
            serviceQuery: 'Чистка',
            date: '2099-01-06',
            time: '12:30',
          },
          f.state,
          f.member,
          f.clock,
          memory.beginCommand(f.c, f.member, f.state),
          { openWhenComplete: true, createRequested: true },
        );
        assert.equal(reply.action.type, 'createAppointment');
        f.options = { ...f.options, dialogues: memory };
        request = { executionId: reply.action.executionId, policyVersion: f.state.revision };
      } else {
        assert.equal(
          f.result.action.type,
          kind === 'move' ? 'moveAppointment' : 'cancelAppointment',
        );
        request = f.body();
      }
      let owned = true;
      const api = createAppointmentExecution({
        ...f.options,
        assertExecutorOwned() {
          if (!owned) throw fail(503, 'Synthetic executor authority lost');
        },
      });
      const before = structuredClone(f.storage.read());
      f.hooks.beforeCommit = () => {
        owned = false;
      };
      await assert.rejects(api.execute(f.c, request), { status: 503 });
      assert.deepEqual(f.storage.read(), before);
      assert.equal(
        f.storage.db
          .prepare(
            "SELECT count(*) n FROM meta WHERE key LIKE 'assistant-created:%' OR key LIKE 'assistant-moved:%' OR key LIKE 'assistant-cancelled:%'",
          )
          .get().n,
        0,
      );
    },
  );

test('workers reject autosave with concurrency above one before preflight or any fork', () => {
  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=192', 'scripts/start-workers.cjs'],
    {
      cwd: path.resolve(__dirname, '..'),
      timeout: 10000,
      env: { ...process.env, WEB_CONCURRENCY: '2', CARTOTECA_ASSISTANT_APPOINTMENT_SAVING: '1' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Assistant automatic saving requires WEB_CONCURRENCY=1/u);
  assert.equal(result.stdout, '');
});

test('disabled assistant access never validates executor files, while enabled access is fenced', async (t) => {
  const f = await adminFixture(t);
  let assertions = 0;
  const assistant = createAssistant(
    { ...f.database, organizationTimeZone: f.store.organizationTimeZone },
    {
      directory: f.platformDirectory,
      appointmentSavingEnabled: true,
      assertExecutorOwned() {
        assertions++;
        throw fail(503, 'Synthetic authority unavailable');
      },
    },
  );
  const actor = f.store.session(f.ownerSession.token);
  assert.equal(assistant.access(actor).enabled, false);
  assert.equal(assertions, 0);
  enable(f);
  assert.equal(assistant.access(actor).enabled, false);
  assert.equal(assertions, 1);
});
