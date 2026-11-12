const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { setTimeout: sleep } = require('node:timers/promises');
const { fixture } = require('./helpers/assistant-state-rows-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const {
  prepareCompoundProfile,
} = require('../src/server/infrastructure/postgres/revision-operator133.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { readRuntime } = require('../src/server/infrastructure/postgres/runtime.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { createAssistantStore } = require('../src/server/modules/assistant/access/store.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');
const { createAssistantBudget } = require('../src/server/modules/assistant/access/budget.cjs');
const { createWalletStore } = require('../src/server/modules/billing/wallet-store.cjs');
const {
  preparePostgresAssistantRows,
  acquireOfflinePreparation145,
  MARKER,
} = require('../src/server/infrastructure/postgres/assistant-prepare145.cjs');
const {
  preparedPostgresProfile,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');

test(
  'actual PG accounting145: file transition, isolated purpose, queued ACL, wallet and current-state inverse',
  { timeout: 180000 },
  async (t) => {
    let runtime, admin, options, other, database;
    t.after(async () => {
      database?.closeWriter();
      database?.db.close();
      await options?.databaseOwner.close();
      await other?.databaseOwner.close();
      await admin?.end();
      await runtime?.close();
    });
    const f = await fixture(t),
      destination = path.join(f.root, 'pg-assets');
    createStorage(path.join(f.source, 'tenants', f.owner.organizationId)).close();
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
    const platformDirectory = path.join(destination, 'platform'),
      gate = path.join(destination, '.restore-in-progress');
    const original = fs.readFileSync(path.join(platformDirectory, 'assistant-state.enc'));
    fs.writeFileSync(gate, MARKER, { flag: 'wx' });
    await t.test(
      'outer rollback leaves source bytes and catalog file backend unchanged',
      async () => {
        const lock = await acquireOfflinePreparation145({ client: admin, directory: destination });
        try {
          await admin.query('BEGIN');
          const component = await preparePostgresAssistantRows({
            client: admin,
            directory: destination,
            applicationRole: runtime.application.user,
            transactionOwned: true,
          });
          assert.equal(component.proof.backend, 'rows-v1');
          await admin.query('ROLLBACK');
          assert.deepEqual(
            fs.readFileSync(path.join(platformDirectory, 'assistant-state.enc')),
            original,
          );
        } finally {
          await lock.release();
        }
        assert.equal(
          (await preparedPostgresProfile(runtime.application, destination)).assistantStateBackend,
          'file',
        );
      },
    );
    await t.test(
      'committed preparation is reconcilable and runtime automatically detects rows, no flag bypass',
      async () => {
        const result = await preparePostgresAssistantRows({
          client: admin,
          directory: destination,
          applicationRole: runtime.application.user,
        });
        assert.equal(result.backend, 'rows-v1');
        assert.equal(result.importedRevision, f.initial.revision);
        const repeat = await preparePostgresAssistantRows({
          client: admin,
          directory: destination,
          applicationRole: runtime.application.user,
        });
        assert.equal(repeat.reconciledExisting, true);
        assert.equal(fs.existsSync(gate), true);
        assert.equal(
          (await preparedPostgresProfile(runtime.application, destination)).assistantStateBackend,
          'rows-v1',
        );
      },
    );
    fs.unlinkSync(gate);
    const config = {
      storageBackend: 'postgres',
      dataDir: destination,
      notificationSchema: 19,
      postgresRevisionProfile: 3,
      postgres: runtime.application,
      processRole: 'web',
    };
    options = await initializePostgresOwner(config);
    other = await initializePostgresOwner(config);
    assert.equal(options.assistantStateBackend, 'rows-v1');
    database = createPlatformDatabase(platformDirectory, {
      notificationSchema: 19,
      databaseOwner: options.databaseOwner,
      sharedCabinetWrites: true,
    });
    let paid = false;
    const context = {
      ...database,
      billing: { hasServiceConnection: () => paid, isServiceEnabled: () => paid },
    };
    context.billing.wallet = createWalletStore(context);
    const store = createAssistantStore({
      ...context,
      directory: platformDirectory,
      backend: options.assistantStateBackend,
    });
    const policy = createAssistantPolicy(context, store),
      budget = createAssistantBudget(context, store, policy);
    const current = {
      accountId: f.owner.accountId,
      organizationId: f.owner.organizationId,
      role: 'owner',
      globalAdmin: false,
    };
    const marker = readRuntime(destination);
    other.databaseOwner.verifyProfile({
      platformStoreId: marker.platformStoreId,
      migrationId: marker.migrationId,
      markerHash: digest(marker),
      lineage: marker,
    });
    const holder = other.databaseOwner.open(database.db.scope);
    const cabinetStoreId = marker.stores.find(
      (s) => s.kind === 'cabinet' && s.organizationId === current.organizationId,
    ).storeId;
    other.databaseOwner.open({
      kind: 'cabinet',
      storeId: cabinetStoreId,
      organizationId: current.organizationId,
    });
    const month = new Date().toISOString().slice(0, 7);
    const count = () =>
      database.db.prepare('SELECT count(*) n FROM assistant_reservations').get().n;
    const reserve = () => budget.reserve(current, store.readPolicy().revision, 'llm', 0.25);
    const restore = () => {
      holder.exec('BEGIN IMMEDIATE');
      holder
        .prepare('UPDATE assistant_grants SET enabled=1 WHERE organization_id=? AND account_id=?')
        .run(current.organizationId, current.accountId);
      holder.exec('COMMIT');
    };
    await t.test(
      'clinical COMPOUND does not block reserve/outbound/settle; exact unknown charge applies once',
      async () => {
        holder.beginCompound({
          operation: 'cabinet',
          organizationId: current.organizationId,
          cabinetStoreId,
        });
        try {
          const pending = await reserve();
          await budget.markOutbound(pending);
          const before = store.month(month);
          await budget.settle(pending, null);
          const after = store.month(month);
          assert.equal(after.spentMicrorub - before.spentMicrorub, 250000);
          assert.equal(after.calls - before.calls, 1);
          assert.equal(after.uncertainCalls - before.uncertainCalls, 1);
          await budget.settle(pending, 0);
          assert.deepEqual(store.month(month), after);
          assert.equal(database.accountingQueueStats().busyAttempts, 0);
        } finally {
          holder.exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'policy revoke while queued prevents reservation and cannot reach provider',
      async () => {
        const before = count();
        holder.exec('BEGIN IMMEDIATE');
        holder
          .prepare('UPDATE assistant_grants SET enabled=0 WHERE organization_id=? AND account_id=?')
          .run(current.organizationId, current.accountId);
        const pending = reserve();
        const rejected = assert.rejects(pending, { status: 403 });
        await sleep(40);
        assert.equal(count(), before);
        assert.ok(database.accountingQueueStats().busyAttempts > 0);
        holder.exec('COMMIT');
        await rejected;
        assert.equal(count(), before);
        restore();
      },
    );
    await t.test(
      'queued outbound rechecks grant, no outbound mark after revoke; accepted zero settles exactly',
      async () => {
        const pending = await reserve();
        holder.exec('BEGIN IMMEDIATE');
        holder
          .prepare('UPDATE assistant_grants SET enabled=0 WHERE organization_id=? AND account_id=?')
          .run(current.organizationId, current.accountId);
        const marked = budget.markOutbound(pending);
        const rejected = assert.rejects(marked, { status: 403 });
        await sleep(30);
        holder.exec('COMMIT');
        await rejected;
        assert.equal(
          database.db.prepare('SELECT state FROM assistant_reservations WHERE id=?').get(pending.id)
            .state,
          'reserved',
        );
        const before = store.month(month);
        await budget.settle(pending, 0);
        assert.equal(store.month(month).spentMicrorub, before.spentMicrorub);
        restore();
      },
    );
    await t.test(
      'paid assistant uses unchanged wallet sums, no customer debit, durable unknown and idempotency',
      async () => {
        paid = true;
        holder.beginCompound({
          operation: 'cabinet',
          organizationId: current.organizationId,
          cabinetStoreId,
        });
        try {
          const pending = await reserve();
          assert.equal(pending.paid, true);
          await budget.markOutbound(pending);
          const result = await budget.settle(pending, null);
          assert.equal(result.uncertain, true);
          assert.equal(result.amountMicrorub, 250000);
          assert.equal(result.chargedMicrorub, 0);
          const master = context.billing.wallet.getWallet(null);
          assert.equal(master.providerCostMicrorub, 250000);
          const repeat = await budget.settle(pending, 0);
          assert.equal(repeat.replayed, true);
          assert.equal(context.billing.wallet.getWallet(null).providerCostMicrorub, 250000);
          assert.equal(context.billing.wallet.getWallet(current.organizationId).balanceMicrorub, 0);
        } finally {
          holder.exec('ROLLBACK');
          paid = false;
        }
      },
    );
    await t.test(
      'purpose denies grant/credit DML and rollback is atomic; exclusive backup remains a barrier',
      async () => {
        const s = {
          operation: 'reserve',
          ledger: 'pilot',
          organizationId: current.organizationId,
          accountId: current.accountId,
          membershipId: f.membershipId,
          month,
          day: new Date().toISOString().slice(0, 10),
          reservationId: null,
        };
        const before = store.day(s.day, f.membershipId);
        await assert.rejects(
          database.asyncAccountingTransaction(() => {
            database.db
              .prepare(
                'INSERT INTO assistant_usage_days VALUES(?,?,?) ON CONFLICT(day,membership_id) DO UPDATE SET requests=excluded.requests',
              )
              .run(s.day, s.membershipId, before + 1);
            database.db
              .prepare('DELETE FROM assistant_grants WHERE account_id=?')
              .run(current.accountId);
          }, s),
          { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' },
        );
        assert.equal(store.day(s.day, f.membershipId), before);
        await admin.query('SELECT pg_advisory_lock($1::bigint)', [KEYS.maintenance]);
        try {
          assert.throws(() => reserve(), { postgresCode: 'POSTGRES_BUSY' });
        } finally {
          await admin.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.maintenance]);
        }
        assert.equal(count(), 0);
      },
    );
    await t.test(
      'native reservation owner/ledger mismatch and cancellation stop before callback',
      async () => {
        const pending = await reserve();
        const scope = {
          operation: 'outbound',
          ledger: 'pilot',
          organizationId: current.organizationId,
          accountId: current.accountId,
          membershipId: f.membershipId,
          month,
          day: new Date().toISOString().slice(0, 10),
          reservationId: pending.id,
        };
        let entered = 0;
        await assert.rejects(
          database.asyncAccountingTransaction(
            () => {
              entered++;
            },
            { ...scope, accountId: require('node:crypto').randomUUID() },
          ),
          { code: 'POSTGRES_ACCOUNTING_RESERVATION_MISMATCH' },
        );
        await assert.rejects(
          database.asyncAccountingTransaction(
            () => {
              entered++;
            },
            { ...scope, ledger: 'wallet' },
          ),
          { code: 'POSTGRES_ACCOUNTING_RESERVATION_MISMATCH' },
        );
        await assert.rejects(
          database.asyncAccountingTransaction(
            () => {
              entered++;
            },
            scope,
            { cancelled: () => true },
          ),
          { status: 499 },
        );
        assert.equal(entered, 0);
        assert.equal(
          database.db.prepare('SELECT state FROM assistant_reservations WHERE id=?').get(pending.id)
            .state,
          'reserved',
        );
        await budget.settle(pending, 0);
      },
    );
    await t.test(
      'paid queued outbound rechecks fresh membership and creates no new provider debt',
      async () => {
        paid = true;
        const pending = await reserve();
        const before = context.billing.wallet.getWallet(null).providerCostMicrorub;
        try {
          holder.exec('BEGIN IMMEDIATE');
          holder
            .prepare("UPDATE accounts SET status='suspended' WHERE id=?")
            .run(current.accountId);
          const marked = budget.markOutbound(pending),
            rejected = assert.rejects(marked, { status: 403 });
          await sleep(30);
          holder.exec('COMMIT');
          await rejected;
          const detail = database.open(
            database.db.prepare('SELECT value FROM billing_reservations WHERE id=?').get(pending.id)
              .value,
          );
          assert.equal(detail.outboundAt, undefined);
          await budget.settle(pending, 0);
          assert.equal(context.billing.wallet.getWallet(null).providerCostMicrorub, before);
        } finally {
          if (holder.isTransaction) holder.exec('ROLLBACK');
          holder.exec('BEGIN IMMEDIATE');
          holder.prepare("UPDATE accounts SET status='active' WHERE id=?").run(current.accountId);
          holder.exec('COMMIT');
          paid = false;
        }
      },
    );
    database.transaction(() =>
      store.updateAdmin((state) => {
        state.policy.dictionary = 'Current rows must survive inverse';
        state.revision++;
      }),
    );
    const expectedDay = store.day(new Date().toISOString().slice(0, 10), f.membershipId);
    database.closeWriter();
    database.db.close();
    database = null;
    await options.databaseOwner.close();
    options = null;
    await other.databaseOwner.close();
    other = null;
    fs.writeFileSync(gate, MARKER, { flag: 'wx' });
    await t.test(
      'inverse exports CURRENT policy/usage/unknown costs, never stale original state',
      async () => {
        const inverse = await preparePostgresAssistantRows({
          client: admin,
          directory: destination,
          applicationRole: runtime.application.user,
          rollback: true,
        });
        assert.equal(inverse.backend, 'file');
        assert.equal(inverse.currentStateInverse, true);
        assert.equal(
          (await preparedPostgresProfile(runtime.application, destination)).assistantStateBackend,
          'file',
        );
        fs.unlinkSync(gate);
        options = await initializePostgresOwner(config);
        database = createPlatformDatabase(platformDirectory, {
          notificationSchema: 19,
          databaseOwner: options.databaseOwner,
          sharedCabinetWrites: true,
        });
        const legacy = createAssistantStore({
          ...database,
          directory: platformDirectory,
          backend: 'file',
        }).read();
        assert.ok(legacy.usage[month].spentRub > f.initial.usage[month].spentRub);
        assert.equal(legacy.grants[0].accountId, current.accountId);
        assert.equal(
          legacy.daily[new Date().toISOString().slice(0, 10) + ':' + f.membershipId],
          expectedDay,
        );
        assert.equal(legacy.policy.dictionary, 'Current rows must survive inverse');
      },
    );
  },
);
