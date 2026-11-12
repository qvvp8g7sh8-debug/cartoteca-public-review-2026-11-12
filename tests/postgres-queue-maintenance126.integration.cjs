const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { batchFixture } = require('./helpers/queue-maintenance126-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const {
  describeSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const {
  createQueueCompatibilityMaintenance,
} = require('../src/server/modules/notifications/queue-compatibility-maintenance.cjs');
const {
  createQueueMaintenanceStore,
} = require('../src/server/modules/notifications/queue-maintenance-store.cjs');
const NOW = 1000000000,
  DAY = 86400000;
test(
  'actual PostgreSQL bounded queue batches retain mixed statuses, stale CAS and full transaction rollback',
  { timeout: 120000 },
  async (t) => {
    const fixture = batchFixture(t);
    fixture.native.exec(
      "CREATE TRIGGER fail_batch BEFORE UPDATE ON staff_push_jobs WHEN NEW.id='a-069' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'synthetic later chunk failure'); END",
    );
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin);
    let owner, db;
    t.after(async () => {
      db?.close();
      await owner?.close();
      await admin.end();
      await runtime.close();
    });
    await admin.connect();
    await admin.query('BEGIN');
    const storeId = '00000000-0000-4000-8000-000000000126';
    try {
      await preparePostgresSchema(admin, {
        kind: 'platform',
        storeId,
        source: describeSqliteSchema(fixture.native),
        applicationRole: runtime.application.user,
      });
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    owner = createPostgresCoordinator({ connection: runtime.application, allowBlocking: true });
    await owner.ready();
    db = owner.open({ kind: 'platform', storeId });
    const context = { db };
    function seed(table, id, options = {}) {
      db.prepare(
        `INSERT INTO ${table}(id,status,expires_at,lease_until,lease_id,channel,next_at) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        id,
        options.status || 'pending',
        options.expires ?? NOW + DAY,
        options.lease ?? 0,
        options.leaseId ?? null,
        options.channel || 'telegram',
        NOW,
      );
    }
    const rows = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    await t.test(
      'CASE/OR/IS status groups preserve uncertainty and strict retention boundaries',
      () => {
        seed('staff_max_jobs', 'expired', { expires: NOW });
        seed('staff_max_jobs', 'unknown', {
          status: 'sending',
          lease: NOW,
          leaseId: 'old',
          expires: NOW - 8 * DAY,
        });
        seed('staff_max_jobs', 'old', { status: 'sent', expires: NOW - 7 * DAY - 1 });
        seed('staff_max_jobs', 'boundary', { status: 'sent', expires: NOW - 7 * DAY });
        const clean = createQueueCompatibilityMaintenance(context, 'staff_max_jobs');
        assert.deepEqual(
          db.transaction(() => clean.sweep(NOW)),
          { examined: 4, changed: 3 },
        );
        assert.deepEqual(
          rows('staff_max_jobs').map((row) => [row.id, row.status]),
          [
            ['boundary', 'sent'],
            ['expired', 'cancelled'],
            ['unknown', 'uncertain'],
          ],
        );
      },
    );
    await t.test('fresh replacement lease cannot be overwritten by a selected-row batch', () => {
      seed('staff_max_jobs', 'replacement', {
        status: 'sending',
        expires: NOW,
        lease: NOW,
        leaseId: 'original',
      });
      let replaced = false;
      const proxy = {
        dialect: 'postgres',
        get isTransaction() {
          return db.isTransaction;
        },
        prepare(sql) {
          const statement = db.prepare(sql);
          if (!sql.startsWith('UPDATE staff_max_jobs SET status=CASE')) return statement;
          return {
            run(...args) {
              if (!replaced) {
                replaced = true;
                db.prepare('UPDATE staff_max_jobs SET lease_id=?,lease_until=? WHERE id=?').run(
                  'replacement',
                  NOW + 1,
                  'replacement',
                );
              }
              return statement.run(...args);
            },
          };
        },
      };
      const clean = createQueueCompatibilityMaintenance({ db: proxy }, 'staff_max_jobs');
      assert.equal(
        db.transaction(() => clean.sweep(NOW)).changed,
        1,
        'only older uncertain history is retained; replacement CAS misses',
      );
      const row = db
        .prepare('SELECT status,lease_id,lease_until FROM staff_max_jobs WHERE id=?')
        .get('replacement');
      assert.deepEqual(
        { ...row },
        { status: 'sending', lease_id: 'replacement', lease_until: NOW + 1 },
      );
    });
    await t.test(
      'eight-row recovery is channel bounded and unknown sends never become retries',
      () => {
        for (let n = 0; n < 12; n++)
          seed('notification_channel_jobs', 'r-' + n, {
            status: 'reserved',
            lease: NOW,
            expires: n % 2 ? NOW : NOW + DAY,
          });
        seed('notification_channel_jobs', 'unknown', { status: 'sending', lease: NOW });
        seed('notification_channel_jobs', 'other', {
          channel: 'max',
          status: 'sending',
          lease: NOW,
        });
        const clean = createQueueCompatibilityMaintenance(context, 'notification_channel_jobs', [
          'telegram',
        ]);
        assert.deepEqual(
          db.transaction(() => clean.recover(NOW)),
          { examined: 8, changed: 8 },
        );
        assert.equal(
          db.prepare('SELECT status FROM notification_channel_jobs WHERE id=?').get('unknown')
            .status,
          'uncertain',
        );
        assert.equal(
          db.prepare('SELECT status FROM notification_channel_jobs WHERE id=?').get('other').status,
          'sending',
        );
      },
    );
    await t.test(
      'a later 64-row SQL chunk failure rolls back every earlier chunk in the same caller transaction',
      () => {
        for (let n = 0; n < 70; n++)
          seed('staff_push_jobs', 'a-' + String(n).padStart(3, '0'), { expires: NOW });
        const phase = createQueueMaintenanceStore(context).phases[13];
        assert.throws(() => db.transaction(() => phase.run(NOW, 128)));
        assert.equal(
          db.prepare("SELECT count(*) n FROM staff_push_jobs WHERE status='pending'").get().n,
          70,
        );
        assert.equal(db.isTransaction, false);
        db.transaction(() =>
          db.prepare("UPDATE staff_push_jobs SET status='sent' WHERE id=?").run('a-069'),
        );
        assert.equal(db.transaction(() => phase.run(NOW, 128)).changed, 69);
      },
    );
  },
);
