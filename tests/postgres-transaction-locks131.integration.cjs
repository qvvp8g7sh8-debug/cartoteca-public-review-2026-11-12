const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const { runLockBatch } = require('../src/server/infrastructure/postgres/transaction-locks.cjs');
const {
  KEYS,
  advisoryKey,
  lockPlan,
} = require('../src/server/infrastructure/postgres/lock-intents.cjs');

test(
  'actual PostgreSQL ordered batches preserve prefix admission, handoff and fail-closed contention',
  { timeout: 90000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime(),
      owner = new Client(runtime.application),
      rival = new Client(runtime.admin),
      transport = createTransport({ connection: runtime.application, timeoutMs: 5000 }),
      platform = { kind: 'platform', storeId: 'synthetic-batch131-platform' },
      guards = lockPlan(platform, 'IMMEDIATE');
    t.after(async () => {
      await transport.close();
      await owner.end();
      await rival.end();
      await runtime.close();
    });
    await owner.connect();
    await rival.connect();
    await transport.ready();
    const exclusive = async (key) =>
      (await rival.query('SELECT pg_try_advisory_lock($1::bigint) AS owned', [key])).rows[0].owned;
    const unlock = async (key) =>
      (await rival.query('SELECT pg_advisory_unlock($1::bigint) AS released', [key])).rows[0]
        .released;

    await t.test(
      'a blocked middle guard acquires only the confirmed prefix and never the later writer',
      async () => {
        assert.equal(await exclusive(KEYS.policy), true);
        try {
          const locked = await runLockBatch(owner, guards, 'session');
          assert.deepEqual(locked, [true, false, false]);
          assert.equal(await exclusive(KEYS.maintenance), false);
          assert.equal(
            await exclusive(KEYS.writer),
            true,
            'later writer must not be attempted after policy false',
          );
          assert.equal(await unlock(KEYS.writer), true);
          assert.deepEqual(await runLockBatch(owner, [guards[0]], 'release'), [true]);
          assert.equal(await exclusive(KEYS.maintenance), true);
          assert.equal(await unlock(KEYS.maintenance), true);
        } finally {
          await owner.query('SELECT pg_advisory_unlock_all()');
          await rival.query('SELECT pg_advisory_unlock_all()');
        }
      },
    );

    await t.test(
      'transaction handoff retains every guard after reverse session unlock until COMMIT',
      async () => {
        assert.deepEqual(await runLockBatch(owner, guards, 'session'), [true, true, true]);
        await owner.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        try {
          assert.deepEqual(await runLockBatch(owner, guards, 'transaction'), [true, true, true]);
          assert.deepEqual(await runLockBatch(owner, [...guards].reverse(), 'release'), [
            true,
            true,
            true,
          ]);
          for (const guard of guards) assert.equal(await exclusive(guard.key), false);
          await owner.query('COMMIT');
          for (const guard of guards) {
            assert.equal(await exclusive(guard.key), true);
            assert.equal(await unlock(guard.key), true);
          }
        } finally {
          await owner.query('ROLLBACK');
          await owner.query('SELECT pg_advisory_unlock_all()');
          await rival.query('SELECT pg_advisory_unlock_all()');
        }
      },
    );

    await t.test(
      'unlock batches continue past a missing middle lock and release all remaining known guards',
      async () => {
        const three = [1, 2, 3].map((index) => ({
          key: advisoryKey('synthetic-batch131-' + index),
          shared: false,
        }));
        assert.deepEqual(await runLockBatch(owner, [three[0], three[2]], 'session'), [true, true]);
        assert.deepEqual(await runLockBatch(owner, [...three].reverse(), 'release'), [
          true,
          false,
          true,
        ]);
        for (const guard of three) {
          assert.equal(await exclusive(guard.key), true);
          assert.equal(await unlock(guard.key), true);
        }
      },
    );

    await t.test(
      'worker reports clean pre-BEGIN contention only after the full confirmed prefix is released',
      async () => {
        assert.equal(await exclusive(KEYS.writer), true);
        try {
          assert.throws(
            () => transport.request({ op: 'begin', scope: platform, mode: 'IMMEDIATE' }),
            (error) =>
              error.code === 'POSTGRES_BUSY' &&
              error.retryableBeforeBegin === true &&
              error.transactionOpen === false &&
              !error.channelPoisoned &&
              !error.outcomeUnknown,
          );
          for (const key of [KEYS.maintenance, KEYS.policy]) {
            assert.equal(
              await exclusive(key),
              true,
              'worker must not retain a session prefix after BUSY',
            );
            assert.equal(await unlock(key), true);
          }
        } finally {
          await rival.query('SELECT pg_advisory_unlock_all()');
        }
        transport.request({ op: 'begin', scope: platform, mode: 'IMMEDIATE' });
        assert.equal(await exclusive(KEYS.writer), false);
        transport.request({ op: 'rollback', scope: platform });
        assert.equal(await exclusive(KEYS.writer), true);
        assert.equal(await unlock(KEYS.writer), true);
      },
    );

    await t.test(
      'read-only admission retains the maintenance fence and bypasses unrelated writer/policy guards',
      async () => {
        assert.equal(await exclusive(KEYS.policy), true);
        assert.equal(await exclusive(KEYS.writer), true);
        try {
          transport.request({ op: 'begin', scope: platform, mode: 'READONLY' });
          assert.equal(await exclusive(KEYS.maintenance), false);
          transport.request({ op: 'commit', scope: platform });
        } finally {
          await rival.query('SELECT pg_advisory_unlock_all()');
        }
        assert.equal(await exclusive(KEYS.maintenance), true);
        try {
          assert.throws(
            () => transport.request({ op: 'begin', scope: platform, mode: 'READONLY' }),
            (error) =>
              error.code === 'POSTGRES_BUSY' &&
              error.retryableBeforeBegin === true &&
              error.transactionOpen === false &&
              !error.channelPoisoned,
          );
        } finally {
          await rival.query('SELECT pg_advisory_unlock_all()');
        }
      },
    );
  },
);
