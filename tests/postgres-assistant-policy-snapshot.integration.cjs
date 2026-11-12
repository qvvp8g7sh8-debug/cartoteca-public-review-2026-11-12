const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { createAssistant } = require('../src/server/modules/assistant/service.cjs');
const {
  resolveClient,
} = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { Client } = require('pg');
const { fixture } = require('./helpers/assistant-state-rows-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const {
  prepareCompoundProfile,
} = require('../src/server/infrastructure/postgres/revision-operator133.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createAssistantStore } = require('../src/server/modules/assistant/access/store.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');
const {
  preparePostgresAssistantRows,
  MARKER,
} = require('../src/server/infrastructure/postgres/assistant-prepare145.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');

test(
  'actual PG assistant scope reads stay fresh while reducing synchronous database dispatch',
  { timeout: 120000 },
  async (t) => {
    let runtime, admin, options, database, cabinet;
    t.after(async () => {
      cabinet?.close();
      database?.closeWriter();
      database?.db.close();
      await options?.databaseOwner.close();
      await admin?.end();
      await runtime?.close();
    });
    const f = await fixture(t),
      destination = path.join(f.root, 'pg-assets');
    const seed = createStorage(path.join(f.source, 'tenants', f.owner.organizationId));
    seed.write({
      revision: 0,
      services: [],
      patients: Array.from({ length: 1500 }, (_, i) => ({
        id: randomUUID(),
        firstName: i === 0 ? 'Анна' : 'Синтетический',
        lastName: i === 0 ? 'Семёнова' : 'Клиент' + i,
        name: i === 0 ? 'Анна Семёнова' : 'Синтетический Клиент' + i,
        createdBy: f.owner.accountId,
        appointments: [],
        visits: [],
      })),
    });
    seed.close();
    runtime = await startPostgresTestRuntime();
    admin = new Client(runtime.admin);
    await admin.connect();
    await migratePostgresData({
      source: f.source,
      destination,
      client: admin,
      applicationRole: runtime.application.user,
      offline: true,
      dryRun: false,
    });
    await admin.query('BEGIN');
    await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
    await prepareCompoundProfile(admin, runtime.application.user);
    await admin.query('COMMIT');
    const directory = path.join(destination, 'platform'),
      gate = path.join(destination, '.restore-in-progress');
    fs.writeFileSync(gate, MARKER, { flag: 'wx' });
    await preparePostgresAssistantRows({
      client: admin,
      directory: destination,
      applicationRole: runtime.application.user,
    });
    fs.unlinkSync(gate);
    options = await initializePostgresOwner({
      storageBackend: 'postgres',
      dataDir: destination,
      notificationSchema: 19,
      postgresRevisionProfile: 3,
      postgres: runtime.application,
      processRole: 'web',
    });
    database = createPlatformDatabase(directory, {
      notificationSchema: 19,
      databaseOwner: options.databaseOwner,
      sharedCabinetWrites: true,
    });
    const context = {
      ...database,
      organizationTimeZone: () => 'Europe/Moscow',
      billing: { hasServiceConnection: () => false, isServiceEnabled: () => false },
    };
    const store = createAssistantStore({
      ...context,
      directory,
      backend: options.assistantStateBackend,
    });
    const policy = createAssistantPolicy(context, store);
    const legacy = createAssistantPolicy(context, { ...store, readScope: undefined });
    const current = {
      accountId: f.owner.accountId,
      organizationId: f.owner.organizationId,
      role: 'owner',
      globalAdmin: false,
    };
    const revision = store.readPolicy().revision;
    const inspect = (reader, samples) => {
      const durations = [],
        before = options.databaseOwner.stats().calls;
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        assert.equal(reader.requireScope(current, revision).scope.enabled, true);
        durations.push(performance.now() - start);
      }
      durations.sort((a, b) => a - b);
      return {
        samples,
        dispatches: options.databaseOwner.stats().calls - before,
        medianMs: durations[Math.floor(samples / 2)],
        p95Ms: durations[Math.floor(samples * 0.95)],
      };
    };
    inspect(legacy, 2);
    inspect(policy, 2);
    const before = inspect(legacy, 30),
      after = inspect(policy, 30);
    t.diagnostic(
      JSON.stringify({
        synthetic: true,
        actualPostgres: true,
        measurement: 'fresh access guard; no billing SQL/provider/network',
        before,
        after,
      }),
    );
    assert.equal(
      after.dispatches,
      before.dispatches - 60,
      'one bundled SELECT must replace three SELECTs per fresh guard',
    );
    assert.deepEqual(
      policy.requireScope(current, revision),
      legacy.requireScope(current, revision),
    );
    cabinet = createStorage(path.join(destination, 'tenants', current.organizationId), {
      databaseOwner: options.databaseOwner,
      databaseRoot: destination,
      photoOrganizationId: current.organizationId,
    });
    const c = {
      current: { ...current, sessionId: 'synthetic-session' },
      assertCurrent() {},
      platform: {
        organizationTimeZone: context.organizationTimeZone,
        workspaceMembers: () => [
          {
            accountId: current.accountId,
            displayName: 'Synthetic owner',
            role: 'owner',
            status: 'active',
          },
        ],
      },
      tenantStore: () => cabinet,
    };
    const api = createAssistant(context, {
      directory,
      stateBackend: 'rows-v1',
      fetchImpl: async () => {
        throw Error('No external provider expected');
      },
    });
    const measured = async (name, operation) => {
      const count = options.databaseOwner.stats().calls,
        start = performance.now();
      const result = await operation();
      t.diagnostic(
        JSON.stringify({
          synthetic: true,
          name,
          patients: 1500,
          ms: performance.now() - start,
          dispatches: options.databaseOwner.stats().calls - count,
          excludes: 'HTTP/session authentication, actual speech/model, network',
        }),
      );
      return result;
    };
    for (const phase of ['first', 'repeat']) {
      const calendar = await measured('calendar-' + phase, () =>
        api.turn(c, { policyVersion: revision, text: 'Открой календарь на завтра' }),
      );
      assert.equal(calendar.action.type, 'calendar');
      const found = await measured('correlated-client-' + phase, () =>
        resolveClient(c, 'Анну Семёнову'),
      );
      assert.equal(found.matches.length, 1);
      const card = await measured('client-card-' + phase, () =>
        api.turn(c, { policyVersion: revision, text: 'Открой карточку Анны Семёновой' }),
      );
      assert.equal(card.action.type, 'clientCard');
    }
    const booking = await measured('booking-initial', () =>
      api.turn(c, { policyVersion: revision, text: 'Запиши клиента' }),
    );
    assert.ok(booking.dialogue);
    const answer = await measured('booking-client-answer', () =>
      api.turn(c, {
        policyVersion: revision,
        dialogueId: booking.dialogue.id,
        dialogueVersion: booking.dialogue.version,
        text: 'Анна Семёнова',
      }),
    );
    assert.ok(answer.dialogue);
    database.transaction(() =>
      database.db
        .prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
        .run('revoked', current.organizationId, current.accountId),
    );
    assert.throws(() => policy.requireScope(current, revision), { status: 403 });
    database.transaction(() =>
      database.db
        .prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?')
        .run('active', current.organizationId, current.accountId),
    );
    assert.equal(policy.requireScope(current, revision).scope.enabled, true);
    database.transaction(() =>
      database.db.prepare('UPDATE accounts SET global_admin=1 WHERE id=?').run(current.accountId),
    );
    assert.throws(() => policy.requireScope(current, revision), { status: 403 });
    database.transaction(() =>
      database.db.prepare('UPDATE accounts SET global_admin=0 WHERE id=?').run(current.accountId),
    );
    database.transaction(() =>
      database.db
        .prepare('UPDATE assistant_grants SET enabled=0 WHERE organization_id=? AND account_id=?')
        .run(current.organizationId, current.accountId),
    );
    assert.throws(() => policy.requireScope(current, revision), { status: 403 });
  },
);
