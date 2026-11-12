const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { fixture } = require('./helpers/assistant-state-rows-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { assistantContext } = require('../src/server/infrastructure/backup/assistant-state.cjs');
const { createAssistantRowStore } = require('../src/server/modules/assistant/access/row-store.cjs');
const links = require('../src/server/infrastructure/booking-public-links-schema.cjs');
const budget = require('../src/server/infrastructure/booking-read-budget-store.cjs');
function prepare(source, name, action) {
  const marker = path.join(source, '.restore-in-progress');
  fs.writeFileSync(marker, name, { flag: 'wx', mode: 0o600 });
  try {
    action();
  } finally {
    fs.unlinkSync(marker);
  }
}
test(
  'actual PostgreSQL components preserve assistant accounting, read limits, public links, billing and notification lease CAS',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, 19);
    prepare(f.source, 'assistant-state-rows-preparation-v1', () =>
      require('../src/server/migrations/001-assistant-state-rows.cjs').migrateAssistantStateRows(
        f.platformDirectory,
      ),
    );
    prepare(f.source, 'booking-read-budget-preparation-v1', () =>
      require('../src/server/migrations/001-booking-read-budget.cjs').migrateBookingReadBudget(
        f.platformDirectory,
      ),
    );
    const source = createPlatformDatabase(f.platformDirectory, {
      notificationSchema: 19,
      sharedCabinetWrites: true,
      isolatedReadBudgets: true,
    });
    try {
      source.db.exec(links.schema);
      source.db
        .prepare('INSERT INTO booking_public_links VALUES(?,?,?,?)')
        .run('abcdefgh', f.owner.organizationId, '', Date.now());
    } finally {
      source.closeWriter();
      source.db.close();
    }
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin);
    await admin.connect();
    const destination = path.join(runtime.root, 'assets');
    let owner, database, store;
    try {
      await migratePostgresData({
        source: f.source,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        offline: true,
        dryRun: false,
      });
      await t.test(
        'technical startup discovers prepared rows and isolated budget without manual feature flags',
        async () => {
          const detected =
            await require('../src/server/infrastructure/postgres/prepared-profile.cjs').preparedPostgresProfile(
              runtime.application,
              destination,
            );
          assert.deepEqual(detected, {
            bookingLinksVersion: 1,
            notificationSchema: 19,
            isolatedReadBudgets: true,
            assistantStateBackend: 'rows-v1',
            sharedCabinetWrites: true,
          });
        },
      );
      const options = await initializePostgresOwner({
        dataDir: destination,
        storageBackend: 'postgres',
        postgres: runtime.application,
      });
      owner = options.databaseOwner;
      database = createPlatformDatabase(path.join(destination, 'platform'), {
        notificationSchema: 19,
        databaseOwner: owner,
        sharedCabinetWrites: true,
        isolatedReadBudgets: true,
      });
      await t.test(
        'assistant encrypted row state and money remain exact, reserve/outbound/settle is atomic',
        async () => {
          const context = {
            ...assistantContext(database.db, database.key, path.join(destination, 'platform')),
            asyncTransaction: database.asyncTransaction,
            readSnapshot: database.readSnapshot,
          };
          const repo = createAssistantRowStore(context, {
            directory: path.join(destination, 'platform'),
          });
          assert.deepEqual(repo.exportLegacyState(), f.initial);
          const current = { organizationId: f.owner.organizationId, accountId: f.owner.accountId };
          const assertScope = () => ({
            state: repo.readPolicy(),
            scope: { limits: repo.readPolicy().policy.limits },
            member: { ...current, membershipId: f.membershipId },
          });
          const reservation = await repo.reservePilot({
            current,
            revision: repo.readPolicy().revision,
            kind: 'llm',
            amount: 2.5,
            provider: 'demo',
            pricing: {},
            assertScope,
          });
          await repo.markOutbound(reservation, assertScope);
          const settled = await repo.settlePilot(reservation, 0.75);
          assert.equal(settled.chargedMicrorub, 750000);
          assert.equal(
            database.db
              .prepare('SELECT 1 FROM assistant_reservations WHERE id=?')
              .get(reservation.id),
            undefined,
          );
          const revision = repo.readPolicy().revision;
          database.transaction(() =>
            repo.updateAdmin((state) => {
              state.revision++;
              state.policy.dictionary = 'Synthetic PG dictionary';
            }),
          );
          assert.equal(repo.readPolicy().revision, revision + 1);
          assert.equal(repo.readPolicy().policy.dictionary, 'Synthetic PG dictionary');
        },
      );
      await t.test('public booking link component validates actual stored types and bytes', () => {
        assert.deepEqual(links.validate(database.db), { version: 1 });
        assert.equal(
          database.db
            .prepare('SELECT organization_id FROM booking_public_links WHERE code=?')
            .get('abcdefgh').organization_id,
          f.owner.organizationId,
        );
      });
      await t.test('notification lease compare-and-swap rejects stale completion', () => {
        const db = database.db,
          now = Date.now(),
          id = 'synthetic-pg-job';
        db.prepare(
          "INSERT INTO staff_max_jobs(id,organization_id,account_id,event_key,value,status,next_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?)",
        ).run(
          id,
          f.owner.organizationId,
          f.owner.accountId,
          'synthetic-event',
          database.seal({ kind: 'test' }),
          now,
          now + 60000,
        );
        const claim = db.prepare(
          "UPDATE staff_max_jobs SET status='sending',attempts=attempts+1,lease_until=?,lease_id=? WHERE id=? AND status=? AND attempts=? AND lease_until=? AND lease_id IS ?",
        );
        assert.equal(claim.run(now + 30000, 'lease-one', id, 'pending', 0, 0, null).changes, 1);
        assert.equal(claim.run(now + 30000, 'lease-two', id, 'pending', 0, 0, null).changes, 0);
        const finish = db.prepare(
          "UPDATE staff_max_jobs SET status='sent',lease_until=0,lease_id=NULL WHERE id=? AND status='sending' AND lease_id=? AND lease_until=?",
        );
        assert.equal(finish.run(id, 'lease-two', now + 30000).changes, 0);
        assert.equal(finish.run(id, 'lease-one', now + 30000).changes, 1);
      });
      await t.test(
        'isolated public-read budget reuses original identity and independent transaction',
        async () => {
          const counter = budget.openBookingReadBudget(
            database.db,
            path.join(destination, 'platform'),
            true,
            { databaseOwner: owner },
          );
          assert.ok(counter);
          try {
            const key = 'booking-budget:site-read:pg-native';
            await counter.asyncTransaction(() =>
              counter.db
                .prepare('INSERT INTO login_limits VALUES(?,?,?,?)')
                .run(key, 3, 1000, 2000),
            );
            assert.equal(
              counter.db.prepare('SELECT failures FROM login_limits WHERE key=?').get(key).failures,
              3,
            );
            assert.throws(() =>
              database.db.prepare('INSERT INTO login_limits VALUES(?,?,?,?)').run(key, 0, 0, 0),
            );
            assert.equal(
              counter.db.prepare('SELECT failures FROM login_limits WHERE key=?').get(key).failures,
              3,
            );
          } finally {
            counter.close();
          }
        },
      );
      database.closeWriter();
      database.db.close();
      database = null;
      await t.test(
        'whole prepared application starts with rows, budget and public-link components and payments remain off',
        () => {
          store = createPlatformStore(path.join(destination, 'platform'), {
            notificationSchema: 19,
            databaseOwner: owner,
            assistantStateBackend: 'rows-v1',
            sharedCabinetWrites: true,
            isolatedReadBudgets: true,
            paymentNetworkEnabled: false,
          });
          assert.equal(store.billing.payments.publicConfig().ready, false);
          assert.equal(store.billing.packages.catalog().length, 0);
        },
      );
    } finally {
      store?.close();
      if (database) {
        database.closeWriter();
        database.db.close();
      }
      await owner?.close();
      await admin.end();
      await runtime.close();
    }
  },
);
