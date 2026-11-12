const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const {
  prepareRevisionProfile,
} = require('../src/server/infrastructure/postgres/revision-operator132.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const { createMaxInbox } = require('../src/server/modules/notifications/max-inbox.cjs');
const busyBefore = (error) =>
  error.code === 'ERR_SQLITE_ERROR' &&
  error.postgresCode === 'POSTGRES_BUSY' &&
  error.retryableBeforeBegin === true &&
  error.transactionOpen === false &&
  !error.outcomeUnknown &&
  !error.channelPoisoned;

test(
  'native domain queues preserve whole-queue ownership and exclude legacy, policy and maintenance writers',
  { timeout: 120000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      owners = [],
      handles = [],
      raw = [];
    const platform = { kind: 'platform', storeId: randomUUID() };
    t.after(async () => {
      try {
        for (const db of handles) if (db.isTransaction) db.exec('ROLLBACK');
        for (const owner of owners) await owner.close();
        for (const transport of raw) await transport.close();
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
        ...platform,
        source: canonicalSqliteSchema({ kind: 'platform', version: 19 }),
        applicationRole: runtime.application.user,
      });
      await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
      await prepareRevisionProfile(admin, runtime.application.user, { target: 2 });
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    async function open() {
      const owner = createPostgresCoordinator({
        connection: runtime.application,
        allowBlocking: true,
        revisionProfile: 2,
      });
      owners.push(owner);
      await owner.ready();
      const db = owner.open(platform);
      handles.push(db);
      return db;
    }
    const first = await open(),
      second = await open(),
      third = await open();

    await t.test(
      'different queue domains mutate and commit while a sibling transaction stays open',
      () => {
        first.beginQueue('max-inbox');
        first
          .prepare('INSERT INTO max_runtime_leases VALUES(?,?,?)')
          .run('synthetic-bot', 'owner', 1000);
        second.beginQueue('staff-max');
        second
          .prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)')
          .run('staff-selftest-v1:max:synthetic', Buffer.from('synthetic'));
        second.exec('COMMIT');
        assert.equal(first.isTransaction, true);
        first.exec('COMMIT');
        assert.equal(
          third
            .prepare('SELECT owner FROM max_runtime_leases WHERE bot_hash=?')
            .get('synthetic-bot').owner,
          'owner',
        );
      },
    );
    await t.test('same domain and generic writer are refused cleanly before BEGIN', () => {
      first.beginQueue('max-inbox');
      assert.throws(() => second.beginQueue('max-inbox'), busyBefore);
      assert.throws(() => second.exec('BEGIN QUEUE'), busyBefore);
      assert.throws(() => second.exec('BEGIN IMMEDIATE'), busyBefore);
      first.exec('ROLLBACK');
      second.exec('BEGIN QUEUE');
      assert.throws(() => first.beginQueue('staff-max'), busyBefore);
      second.exec('ROLLBACK');
    });
    await t.test(
      'exclusive policy and maintenance fences still deny domain admission',
      async () => {
        for (const key of [KEYS.policy, KEYS.maintenance]) {
          await admin.query('SELECT pg_advisory_lock($1::bigint)', [key]);
          try {
            assert.throws(() => first.beginQueue('push'), busyBefore);
          } finally {
            await admin.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
          }
        }
      },
    );
    await t.test(
      'non-CAS MAX claim retains a single winner and rollback permits a fresh claim',
      () => {
        const inbox = (db) =>
          createMaxInbox({
            db,
            seal: (value) => Buffer.from(JSON.stringify(value)),
            open: (value) => JSON.parse(Buffer.from(value).toString()),
            limitKey: (kind, value) =>
              createHash('sha256')
                .update(kind + ':' + value)
                .digest('hex'),
            transaction: (callback) => db.transaction(callback),
            queueTransaction(callback, domain) {
              if (db.isTransaction) return callback();
              db.beginQueue(domain);
              try {
                const result = callback();
                db.exec('COMMIT');
                return result;
              } catch (error) {
                if (db.isTransaction) db.exec('ROLLBACK');
                throw error;
              }
            },
          });
        const a = inbox(first),
          b = inbox(second),
          now = 1000000000;
        a.accept(
          '123',
          { update_type: 'bot_started', timestamp: now, user: { user_id: '456', is_bot: false } },
          now,
        );
        first.beginQueue('max-inbox');
        const claimed = a.claim('123', now);
        assert.ok(claimed);
        assert.throws(() => b.claim('123', now), busyBefore);
        first.exec('ROLLBACK');
        const winner = b.claim('123', now);
        assert.equal(winner.id, claimed.id);
        assert.equal(winner.attempt, 1);
        assert.equal(a.claim('123', now), null);
        assert.equal(
          a.finish(claimed, 'done'),
          false,
          'rolled back lease cannot overwrite its successor',
        );
        assert.equal(b.finish(winner, 'done'), true);
        assert.equal(
          a.accept(
            '123',
            { update_type: 'bot_started', timestamp: now, user: { user_id: '456', is_bot: false } },
            now,
          ).repeated,
          true,
        );
      },
    );
    await t.test(
      'worker independently rejects a forged foreign-table or runtime-key mutation',
      async () => {
        const transport = createTransport({ connection: runtime.application });
        raw.push(transport);
        await transport.ready();
        const inspected = transport.request({ op: 'inspect', scope: platform });
        assert.equal(inspected.revisionProfile, 2);
        transport.request({
          op: 'begin',
          scope: platform,
          mode: 'QUEUE',
          queueDomain: 'max-inbox',
        });
        try {
          for (const plan of [
            {
              text: 'DELETE FROM cartoteca_platform.staff_max_jobs WHERE id=$1',
              values: ['synthetic'],
              effect: 'write',
            },
            {
              text: 'DELETE FROM cartoteca_platform.telegram_runtime WHERE key=$1',
              values: ['application-process-roles'],
              effect: 'write',
            },
          ])
            assert.throws(
              () =>
                transport.request(
                  { op: 'execute', scope: platform, method: 'run', plan, mutating: true },
                  { mutating: true },
                ),
              { code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN' },
            );
        } finally {
          transport.request({ op: 'rollback', scope: platform });
        }
      },
    );
  },
);
