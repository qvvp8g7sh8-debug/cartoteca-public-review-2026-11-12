const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const { createMaxInbox } = require('../src/server/modules/notifications/max-inbox.cjs');
const {
  createMaxRuntimeLease,
  LEASE_MS,
} = require('../src/server/modules/notifications/max-runtime-lease.cjs');
const NOW = 1000000000;
const event = (now) => ({
  update_type: 'bot_started',
  timestamp: now,
  user: { user_id: '456', is_bot: false },
});
const busyBefore = (error) =>
  error.postgres === true &&
  error.postgresCode === 'POSTGRES_BUSY' &&
  error.code === 'ERR_SQLITE_ERROR' &&
  error.errcode === 5 &&
  error.retryableBeforeBegin === true &&
  error.transactionOpen === false &&
  error.channelPoisoned === false &&
  error.outcomeUnknown !== true;

test(
  'actual PostgreSQL MAX ownership retains CAS, rollback and pure cancellation guards',
  { timeout: 120000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      storeId = randomUUID();
    let coordinator,
      db,
      statements = 0,
      failAfterQueue = false;
    t.after(async () => {
      try {
        db?.close();
        await coordinator?.close();
      } finally {
        try {
          await admin.end();
        } finally {
          await runtime.close();
        }
      }
    });
    await admin.connect();
    await admin.query('BEGIN');
    try {
      await preparePostgresSchema(admin, {
        kind: 'platform',
        storeId,
        source: canonicalSqliteSchema({ kind: 'platform', version: 19 }),
        applicationRole: runtime.application.user,
      });
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    coordinator = createPostgresCoordinator({
      connection: runtime.application,
      allowBlocking: true,
    });
    await coordinator.ready();
    db = coordinator.open({ kind: 'platform', storeId });
    const tracked = {
      get isOpen() {
        return db.isOpen;
      },
      prepare(sql) {
        statements++;
        return db.prepare(sql);
      },
    };
    const limitKey = (kind, value) =>
      createHash('sha256')
        .update(kind + ':' + value)
        .digest('hex');
    const options = {
      db: tracked,
      seal: (value) => Buffer.from(JSON.stringify(value)),
      open: (value) => JSON.parse(Buffer.from(value).toString()),
      limitKey,
      transaction: (callback) => db.transaction(callback),
      queueTransaction: (callback) =>
        db.transaction(() => {
          const value = callback();
          if (failAfterQueue) throw Error('Synthetic post-claim transaction failure.');
          return value;
        }, 'QUEUE'),
    };
    const inbox = createMaxInbox(options);
    const revision = async () =>
      (
        await admin.query('SELECT revision FROM cartoteca_catalog.stores WHERE store_id=$1', [
          storeId,
        ])
      ).rows[0].revision;
    const snapshot = async () => ({
      revision: await revision(),
      leases: (
        await admin.query(
          'SELECT bot_hash,owner,lease_until FROM cartoteca_platform.max_runtime_leases WHERE _store_id=$1 ORDER BY bot_hash',
          [storeId],
        )
      ).rows,
      events: (
        await admin.query(
          'SELECT * FROM cartoteca_platform.max_event_inbox WHERE _store_id=$1 ORDER BY id',
          [storeId],
        )
      ).rows,
    });

    await t.test(
      'renew requires the exact unexpired owner and confirmed durable deadline',
      async () => {
        assert.equal(inbox.acquire('101', 'first', NOW), true);
        assert.equal(inbox.acquire('101', 'rival', NOW + 1), false);
        assert.equal(inbox.renew('101', 'rival', NOW + LEASE_MS, NOW + 10000), false);
        assert.equal(inbox.renew('101', 'first', NOW + LEASE_MS - 1, NOW + 10000), false);
        assert.equal(inbox.isCurrent('101', 'first', NOW + LEASE_MS, NOW + 10000), true);
        assert.equal(inbox.renew('101', 'first', NOW + LEASE_MS, NOW + 10000), true);
        assert.equal(inbox.isCurrent('101', 'first', NOW + LEASE_MS, NOW + 10000), false);
        const confirmed = NOW + 10000 + LEASE_MS;
        assert.equal(inbox.isCurrent('101', 'first', confirmed, confirmed), false);
        assert.equal(inbox.renew('101', 'first', confirmed, confirmed), false);
        assert.equal(inbox.acquire('101', 'rival', confirmed), true);
        inbox.release('101', 'first');
        assert.equal(inbox.isCurrent('101', 'rival', confirmed + LEASE_MS, confirmed + 1), true);
        assert.equal(inbox.renew('101', 'first', confirmed, confirmed + 1), false);
      },
    );

    await t.test(
      'claim checks authority before recovery; a later failure rolls every write back',
      async () => {
        inbox.accept('102', event(NOW), NOW);
        inbox.accept('103', event(NOW + 1), NOW + 1);
        const abandoned = inbox.claim('103', NOW + 1);
        assert.ok(abandoned);
        assert.equal(inbox.acquire('102', 'leader', NOW), true);
        const before = await snapshot();
        for (const authority of [
          { owner: 'rival', until: NOW + LEASE_MS },
          { owner: 'leader', until: NOW + LEASE_MS - 1 },
        ])
          assert.equal(inbox.claim('102', NOW + 1, authority), null);
        assert.equal(
          inbox.claim('102', NOW + 120002, { owner: 'leader', until: NOW + LEASE_MS }),
          null,
        );
        assert.deepEqual(
          await snapshot(),
          before,
          'rejected ownership cannot recover another bot or bump revision',
        );
        assert.equal(inbox.acquire('102', 'leader', NOW + 120002), true);
        const confirmed = { owner: 'leader', until: NOW + 120002 + LEASE_MS };
        const rollbackBefore = await snapshot();
        failAfterQueue = true;
        try {
          assert.throws(() => inbox.claim('102', NOW + 120002, confirmed), /Synthetic post-claim/);
        } finally {
          failAfterQueue = false;
        }
        assert.equal(db.isTransaction, false);
        assert.deepEqual(
          await snapshot(),
          rollbackBefore,
          'recovery, attempt, claim and revision share rollback',
        );
        const claimed = inbox.claim('102', NOW + 120002, confirmed);
        assert.equal(claimed.status, 'processing');
        assert.equal(claimed.attempt, 1);
        assert.equal(inbox.finish({ ...claimed, lease_id: 'stale' }, 'done'), false);
        assert.equal(inbox.finish(claimed, 'done'), true);
      },
    );

    await t.test(
      'negative work hints and repeated cancellation guards do not write or advance revision',
      async () => {
        let wall = NOW,
          mono = 0;
        const lease = createMaxRuntimeLease({
          inbox,
          botId: '104',
          owner: 'pure',
          clock: () => wall,
          monotonicClock: () => mono,
        });
        const proof = lease.ensure();
        assert.equal(typeof proof, 'function');
        const before = await revision(),
          calls = statements;
        for (let n = 0; n < 1000; n++) {
          assert.equal(proof(), true);
          assert.deepEqual(proof.authority(), { owner: 'pure', until: NOW + LEASE_MS });
        }
        wall += 9999;
        mono += 9999;
        assert.equal(typeof lease.ensure(), 'function');
        assert.equal(statements, calls, 'local guards and early admission have no SQL calls');
        assert.equal(inbox.hasPendingWork('104', wall), false);
        assert.equal(proof.verify(), true);
        assert.equal(
          await revision(),
          before,
          'fresh owner read and empty work hint remain read only',
        );
        wall++;
        mono++;
        assert.equal(typeof lease.ensure(), 'function');
        assert.notEqual(await revision(), before, 'only due confirmed renewal writes durable TTL');
        assert.equal(inbox.isCurrent('104', 'pure', wall + LEASE_MS, wall), true);
        lease.release();
        assert.equal(proof(), false);
      },
    );

    await t.test(
      'work hint observes due boundaries and expired claims without claiming them',
      async () => {
        assert.equal(inbox.hasPendingWork('105', NOW), false);
        inbox.accept('105', event(NOW + 100), NOW + 100);
        assert.equal(inbox.hasPendingWork('105', NOW + 99), false);
        assert.equal(inbox.hasPendingWork('105', NOW + 100), true);
        const row = inbox.claim('105', NOW + 100),
          before = await revision();
        assert.equal(inbox.hasPendingWork('105', row.lease_until - 1), false);
        assert.equal(inbox.hasPendingWork('105', row.lease_until), true);
        assert.equal(inbox.hasPendingWork('999', row.lease_until), false);
        assert.equal(await revision(), before);
        assert.equal(
          db.prepare('SELECT status,attempt FROM max_event_inbox WHERE id=?').get(row.id).attempt,
          1,
        );
      },
    );

    await t.test(
      'QUEUE overlaps a clinical shared policy fence; exclusive policy still denies',
      async () => {
        await admin.query('SELECT pg_advisory_lock_shared($1::bigint)', [KEYS.policy]);
        try {
          assert.equal(inbox.acquire('106', 'queue', NOW), true);
          assert.equal(inbox.renew('106', 'queue', NOW + LEASE_MS, NOW + 10000), true);
          assert.throws(
            () =>
              db
                .prepare('UPDATE max_runtime_leases SET lease_until=? WHERE bot_hash=?')
                .run(NOW + 99999, limitKey('max-inbox-bot', '106')),
            busyBefore,
          );
          assert.equal(db.isTransaction, false);
          assert.equal(inbox.isCurrent('106', 'queue', NOW + 10000 + LEASE_MS, NOW + 10000), true);
          inbox.release('106', 'queue');
        } finally {
          await admin.query('SELECT pg_advisory_unlock_shared($1::bigint)', [KEYS.policy]);
        }
        await admin.query('SELECT pg_advisory_lock($1::bigint)', [KEYS.policy]);
        try {
          assert.throws(() => inbox.acquire('106', 'queue', NOW), busyBefore);
        } finally {
          await admin.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.policy]);
        }
        assert.equal(inbox.acquire('106', 'queue', NOW), true);
      },
    );

    await t.test(
      'real maintenance BUSY preserves only original proof lifetime and never extends local authority',
      async () => {
        let wall = NOW,
          mono = 0;
        const lease = createMaxRuntimeLease({
          inbox,
          botId: '107',
          owner: 'busy',
          clock: () => wall,
          monotonicClock: () => mono,
        });
        const proof = lease.ensure(),
          before = await snapshot();
        assert.equal(proof(), true);
        await admin.query('SELECT pg_advisory_lock($1::bigint)', [KEYS.maintenance]);
        try {
          const unowned = createMaxRuntimeLease({
            inbox,
            botId: '108',
            owner: 'denied',
            clock: () => wall,
            monotonicClock: () => mono,
          });
          assert.equal(unowned.ensure(), null, 'BUSY cannot establish ownership');
          wall += 10000;
          mono += 10000;
          assert.equal(
            typeof lease.ensure(),
            'function',
            'verified clean before-BEGIN BUSY retains existing proof',
          );
          assert.equal(proof(), true);
          wall = NOW + LEASE_MS - 1;
          mono = LEASE_MS - 1;
          assert.equal(typeof lease.ensure(), 'function');
          assert.deepEqual(
            await snapshot(),
            before,
            'failed renewal did not change TTL, inbox or revision',
          );
          wall++;
          mono++;
          assert.equal(proof(), false);
          assert.equal(lease.ensure(), null, 'BUSY at original deadline fails closed');
        } finally {
          await admin.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.maintenance]);
        }
        assert.equal(inbox.acquire('107', 'replacement', wall), true);
        assert.equal(proof(), false);
        assert.equal(lease.ensure(), null, 'retry delay cannot revive an old proof');
      },
    );
  },
);
