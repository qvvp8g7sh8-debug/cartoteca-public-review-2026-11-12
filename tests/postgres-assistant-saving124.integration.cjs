const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { readRuntime } = require('../src/server/infrastructure/postgres/runtime.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createMultiServer } = require('../src/server/application/server.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const {
  assistantSavingPolicy,
  assistantAuthorityProof,
} = require('../scripts/postgres-readiness.cjs');
const day = '2099-01-05';
function request(server, actor, route, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: route,
        method: bytes ? 'POST' : 'GET',
        headers: {
          Host: 'synthetic.test',
          Origin: 'https://synthetic.test',
          'X-Cartoteca-Request': '1',
          Cookie: 'cartoteca_v2_session=' + actor.token,
          'X-Cartoteca-Account-Id': actor.accountId,
          'X-Cartoteca-Organization-Id': actor.organizationId,
          ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () => {
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
    req.once('error', reject);
    req.end(bytes);
  });
}
async function close(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) =>
    server.close((error) =>
      error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
    ),
  );
}
test(
  'actual PostgreSQL retains enabled voice create, move, confirmed cancellation, replay and exact executor authority',
  { timeout: 120000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t, { organizations: 2 }),
      [actor, foreign] = f.actors;
    const sourceClose = f.platform.close;
    let sourceClosed = false;
    f.platform.close = () => {
      if (!sourceClosed) {
        sourceClosed = true;
        sourceClose();
      }
    };
    const adminAccount = await f.platform.bootstrapGlobalAdmin({
      email: 'voice-operator@synthetic.test',
      password: 'Synthetic-voice-operator-password',
      displayName: 'Synthetic operator',
    });
    const command = (revision, values) => ({
      expectedRevision: revision,
      requestId: randomUUID(),
      reason: 'Synthetic PG execution preservation',
      ...values,
    });
    let view = f.platform.assistant.admin.view(adminAccount.accountId);
    view = f.platform.assistant.admin.settings(
      adminAccount.accountId,
      command(view.revision, {
        policy: { mode: 'selected' },
        timewebApiKey: 'synthetic-never-sent-key',
        providers: { llm: { provider: 'timeweb' } },
      }),
    );
    f.platform.assistant.admin.setMember(
      adminAccount.accountId,
      command(view.revision, {
        organizationId: actor.organizationId,
        accountId: actor.accountId,
        enabled: true,
      }),
    );
    const seed = createStorage(path.join(f.directory, 'tenants', actor.organizationId));
    try {
      const current = seed.read();
      current.patients[0] = {
        ...current.patients[0],
        firstName: 'Анна',
        lastName: 'Семёнова',
        name: 'Анна Семёнова',
      };
      current.services = [
        {
          id: randomUUID(),
          staffId: actor.accountId,
          name: 'Консультация',
          duration: '60',
          price: 100,
          category: 'other',
        },
      ];
      seed.write(current);
      const schedule = f.platform.workSchedules.view(actor.token, actor.accountId, day, day);
      f.platform.workSchedules.save(
        actor.token,
        {
          staffId: actor.accountId,
          dates: [day],
          status: 'working',
          intervals: [['09:00', '18:00']],
          revision: schedule.revision,
          expectedTimeZone: f.platform.organizationTimeZone(actor.organizationId),
        },
        seed,
      );
    } finally {
      seed.close();
    }
    f.platform.close();
    const source = createPlatformDatabase(path.join(f.directory, 'platform'));
    try {
      for (const [file, name] of [
        ['012-max-connections', 'migrateMaxConnections'],
        ['013-notification-queue', 'migrateNotificationQueue'],
        ['014-notification-channels', 'migrateNotificationChannels'],
        ['015-max-inbox', 'migrateMaxInbox'],
        ['016-staff-max', 'migrateStaffMax'],
        ['017-staff-push', 'migrateStaffPush'],
        ['018-notification-schedule', 'migrateNotificationSchedule'],
        ['019-paid-services', 'migratePaidServices'],
      ])
        require('../src/server/migrations/' + file + '.cjs')[name](
          source,
          path.join(f.directory, 'platform'),
        );
      source.db.exec(
        require('../src/server/infrastructure/booking-public-links-schema.cjs').schema,
      );
    } finally {
      source.closeWriter();
      source.db.close();
    }
    const preparationMarker = path.join(f.directory, '.restore-in-progress');
    fs.writeFileSync(preparationMarker, 'booking-read-budget-preparation-v1', {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      require('../src/server/migrations/001-booking-read-budget.cjs').migrateBookingReadBudget(
        path.join(f.directory, 'platform'),
      );
    } finally {
      fs.unlinkSync(preparationMarker);
    }
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      technical = new Client(runtime.application);
    const destination = path.join(runtime.root, 'voice-assets');
    const originalFetch = globalThis.fetch;
    let server,
      owner,
      cabinet,
      competing,
      providerCalls = 0;
    const operationCounts = { create: 0, move: 0, cancel: 0, replay: 0 };
    let phase = 'import';
    await admin.connect();
    await technical.connect();
    try {
      const migrated = await migratePostgresData({
        source: f.directory,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        offline: true,
        dryRun: false,
      });
      assert.equal(migrated.sourceUnchanged, true);
      const marker = readRuntime(destination),
        config = {
          ...f.config,
          dataDir: destination,
          notificationSchema: 19,
          production: true,
          origin: 'https://synthetic.test',
          processRole: 'web',
          storageBackend: 'postgres',
          postgresProfile: 'production-v1',
          postgresAllowedHosts: [runtime.application.host],
          postgres: runtime.application,
          assistantAppointmentSavingEnabled: true,
          releaseGate: false,
        };
      phase = 'initialize-owner';
      const options = await initializePostgresOwner(config);
      owner = options.databaseOwner;
      phase = 'prepared-saving-policy';
      const policy = assistantSavingPolicy(options);
      assert.deepEqual(policy, { version: 1, configured: true, enabled: true });
      await assert.rejects(
        assistantAuthorityProof(technical, marker, policy),
        /AUTHORITY_UNCONFIRMED/,
      );
      globalThis.fetch = async (url, options) => {
        assert.equal(url, 'https://api.timeweb.ai/v1/chat/completions');
        providerCalls++;
        const input = JSON.parse(options.body).messages.at(-1).content;
        const cancelling = /^Отмени/u.test(input),
          moving = /^Перенеси/u.test(input);
        const intent = intentEnvelope({
          intent: cancelling
            ? 'cancelAppointment'
            : moving
              ? 'moveAppointment'
              : 'prepareAppointment',
          query: 'Анну Семёнову',
          date: day,
          time: cancelling || moving ? '12:00' : input.includes('14:00') ? '14:00' : '10:00',
          ...(!cancelling && !moving ? { serviceQuery: 'консультацию' } : {}),
        });
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(intent) } }],
            usage: { prompt_tokens: 20, completion_tokens: 20 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      };
      phase = 'server-construction';
      server = createMultiServer(options);
      phase = 'cabinet-open';
      cabinet = createStorage(path.join(destination, 'tenants', actor.organizationId), {
        databaseOwner: owner,
        databaseRoot: destination,
        photoOrganizationId: actor.organizationId,
        cabinetSchema: 1,
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      assert.deepEqual(await assistantAuthorityProof(technical, marker, policy), {
        required: true,
        owned: true,
        holders: 1,
      });
      phase = 'competing-authority';
      competing = (await initializePostgresOwner(config)).databaseOwner;
      assert.throws(() => competing.acquireExecutorAuthority(marker.platformStoreId), {
        code: 'POSTGRES_AUTHORITY_BUSY',
      });
      await competing.close();
      competing = null;
      phase = 'active-scope';
      const scope = await request(server, actor, '/api/assistant/scope');
      assert.equal(scope.status, 200);
      assert.equal(scope.body.enabled, true);
      assert.equal(scope.body.appointmentSavingEnabled, true);
      const policyVersion = scope.body.policyVersion;
      const appointments = () => cabinet.readSelected([actor.patientId]).patients[0].appointments;
      const turn = async (text) => {
        const result = await request(server, actor, '/api/assistant/turn', { policyVersion, text });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return result.body;
      };
      const execution = (reply) => ({ policyVersion, executionId: reply.action.executionId });
      const execute = async (reply) => {
        const result = await request(server, actor, '/api/assistant/execute', execution(reply));
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.saved, true);
        return result.body;
      };
      const replay = async (reply) => {
        const revision = cabinet.get('revision'),
          result = await execute(reply);
        assert.equal(result.alreadySaved, true);
        assert.equal(cabinet.get('revision'), revision);
        operationCounts.replay++;
      };
      phase = 'create';
      const created = await turn('Запиши Анну Семёнову на консультацию 2099-01-05 в 10:00.');
      assert.equal(created.action?.type, 'createAppointment');
      assert.equal(appointments().length, 0, 'interpretation prepares; only execute commits');
      assert.equal(
        (await request(server, foreign, '/api/assistant/execute', execution(created))).status,
        403,
      );
      assert.equal(
        (
          await request(server, actor, '/api/assistant/execute', {
            ...execution(created),
            policyVersion: policyVersion + 1,
          })
        ).status,
        409,
      );
      await execute(created);
      operationCounts.create++;
      assert.equal(appointments().length, 1);
      const appointmentId = appointments()[0].id;
      await replay(created);
      phase = 'move';
      const moved = await turn('Перенеси запись Анны Семёновой на 2099-01-05 в 12:00.');
      assert.equal(moved.action?.type, 'moveAppointment', JSON.stringify(moved));
      assert.equal(appointments()[0].time, '10:00');
      const savedMove = await execute(moved);
      operationCounts.move++;
      assert.equal(savedMove.moved, true);
      assert.equal(appointments()[0].id, appointmentId);
      assert.equal(appointments()[0].time, '12:00');
      await replay(moved);
      phase = 'cancel-confirmation';
      const cancellation = await turn('Отмени запись Анны Семёновой 2099-01-05 в 12:00.');
      assert.equal(cancellation.action, null);
      assert.equal(cancellation.dialogue.phase, 'cancelConfirmation');
      const premature = await request(server, actor, '/api/assistant/execute', {
        policyVersion,
        executionId: cancellation.dialogue.id,
      });
      assert.equal(premature.status, 409);
      assert.notEqual(appointments()[0].status, 'cancelled');
      const confirmation = await request(server, actor, '/api/assistant/turn', {
        policyVersion,
        dialogueId: cancellation.dialogue.id,
        dialogueVersion: cancellation.dialogue.version,
        choice: cancellation.dialogue.options[0].id,
      });
      assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
      assert.equal(confirmation.body.action?.type, 'cancelAppointment');
      const savedCancel = await execute(confirmation.body);
      operationCounts.cancel++;
      assert.equal(savedCancel.cancelled, true);
      assert.equal(appointments()[0].status, 'cancelled');
      assert.equal(appointments()[0].id, appointmentId);
      await replay(confirmation.body);
      phase = 'authority-loss';
      const pending = await turn('Запиши Анну Семёнову на консультацию 2099-01-05 в 14:00.');
      assert.equal(pending.action?.type, 'createAppointment');
      const revision = cabinet.get('revision');
      const sessions = (
        await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='cartoteca-assistant-authority'",
        )
      ).rows;
      assert.equal(sessions.length, 1);
      await admin.query('SELECT pg_terminate_backend($1)', [sessions[0].pid]);
      await assert.rejects(
        assistantAuthorityProof(technical, marker, policy),
        /AUTHORITY_UNCONFIRMED/,
      );
      assert.equal(
        (await request(server, actor, '/api/assistant/execute', execution(pending))).status,
        503,
      );
      assert.equal(
        (await request(server, actor, '/api/assistant/execute', execution(created))).status,
        503,
        'even a replay rechecks current authority',
      );
      assert.equal(cabinet.get('revision'), revision);
      assert.equal(appointments().length, 1);
      assert.equal(appointments()[0].status, 'cancelled');
      assert.equal(providerCalls, 4, 'no execution, replay or denied action calls a provider');
      cabinet.close();
      cabinet = null;
      await close(server);
      server = null;
      owner = null;
      phase = 'release-gate';
      const gatedOptions = await initializePostgresOwner({ ...config, releaseGate: true });
      owner = gatedOptions.databaseOwner;
      server = createMultiServer(gatedOptions);
      assert.deepEqual(assistantSavingPolicy(gatedOptions), {
        version: 1,
        configured: true,
        enabled: false,
      });
      assert.deepEqual(
        await assistantAuthorityProof(technical, marker, assistantSavingPolicy(gatedOptions)),
        { required: false, owned: false, holders: 0 },
      );
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      assert.equal(
        (await request(server, actor, '/api/assistant/execute', execution(created))).status,
        503,
      );
      t.diagnostic(
        JSON.stringify({
          version: 1,
          backend: 'postgres',
          schema: 19,
          synthetic: true,
          operationCounts,
          providerCalls,
          authorityBeforeStartDenied: true,
          duplicateAuthorityDenied: true,
          authorityLossDenied: true,
          gateDenied: true,
        }),
      );
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          phase,
          code: error.code || null,
          name: error.name,
          frame: error.stack?.split('\n')[1]?.trim(),
        }),
      );
      throw error;
    } finally {
      globalThis.fetch = originalFetch;
      cabinet?.close();
      await close(server);
      await competing?.close();
      await owner?.close();
      await technical.end();
      await admin.end();
      await runtime.close();
    }
  },
);
