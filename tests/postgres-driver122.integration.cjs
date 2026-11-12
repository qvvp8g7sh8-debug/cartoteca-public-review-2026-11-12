const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const platform = { kind: 'platform', storeId: 'synthetic-platform' };
const tenant = (last) => ({
  kind: 'cabinet',
  storeId: '00000000-0000-4000-8000-' + String(last).padStart(12, '0'),
});
function plan(text, values = [], effect = 'read') {
  return { text, values, effect };
}

test(
  'actual PostgreSQL worker transactions, native cursor pages, fair tenant locks and assistant ownership',
  { timeout: 90000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin);
    const transports = [];
    t.after(async () => {
      try {
        for (const transport of transports) await transport.close();
      } finally {
        try {
          await admin.end();
        } finally {
          await runtime.close();
        }
      }
    });
    await admin.connect();
    await admin.query(
      'CREATE TABLE transport122(id bigint PRIMARY KEY,value bytea); GRANT SELECT,INSERT,UPDATE,DELETE ON transport122 TO cartoteca_app',
    );
    async function open() {
      const transport = createTransport({ connection: runtime.application, timeoutMs: 5000 });
      transports.push(transport);
      await transport.ready();
      return transport;
    }
    const first = await open(),
      second = await open();
    const execute = (transport, scope, text, values = [], effect = 'read') =>
      transport.request(
        {
          op: 'execute',
          scope,
          plan: plan(text, values, effect),
          method: 'all',
          mutating: effect === 'write',
        },
        { mutating: effect === 'write' },
      );

    await t.test('binary values and int8 stay exact across the real async pg socket worker', () => {
      const bytes = Buffer.from('synthetic ciphertext');
      execute(
        first,
        platform,
        'INSERT INTO transport122(id,value) VALUES($1,$2)',
        [9007199254740993n, bytes],
        'write',
      );
      const result = execute(first, platform, 'SELECT id,value FROM transport122');
      assert.equal(result.rows[0].id, 9007199254740993n);
      assert.deepEqual(result.rows[0].value, bytes);
      execute(first, platform, 'DELETE FROM transport122', [], 'write');
    });

    await t.test(
      'a caught constraint failure rolls back only its statement, and outer rollback removes all writes',
      async () => {
        first.request({ op: 'begin', scope: platform, mode: 'IMMEDIATE' });
        execute(
          first,
          platform,
          'INSERT INTO transport122(id,value) VALUES($1,$2)',
          [1, Buffer.from('one')],
          'write',
        );
        assert.throws(
          () =>
            execute(
              first,
              platform,
              'INSERT INTO transport122(id,value) VALUES($1,$2)',
              [1, Buffer.from('duplicate')],
              'write',
            ),
          { code: '23505', transactionOpen: true },
        );
        execute(
          first,
          platform,
          'INSERT INTO transport122(id,value) VALUES($1,$2)',
          [2, Buffer.from('two')],
          'write',
        );
        assert.equal(
          execute(first, platform, 'SELECT COUNT(*) AS n FROM transport122').rows[0].n,
          2n,
        );
        first.request({ op: 'rollback', scope: platform });
        assert.equal((await admin.query('SELECT COUNT(*) AS n FROM transport122')).rows[0].n, '0');
      },
    );

    await t.test(
      'different tenant saves can hold their locks concurrently while same-tenant and ACL writers are refused',
      () => {
        first.request({ op: 'begin', scope: platform, mode: 'SHARED' });
        second.request({ op: 'begin', scope: platform, mode: 'SHARED' });
        try {
          first.request({ op: 'savepoint', scope: tenant(1), name: 'ct_sp_1', mode: 'IMMEDIATE' });
          assert.throws(
            () =>
              second.request({
                op: 'savepoint',
                scope: tenant(1),
                name: 'ct_sp_1',
                mode: 'IMMEDIATE',
              }),
            (error) => error.code === 'POSTGRES_BUSY' && !error.retryableBeforeBegin,
          );
          second.request({ op: 'savepoint', scope: tenant(2), name: 'ct_sp_2', mode: 'IMMEDIATE' });
          assert.throws(
            () =>
              execute(
                second,
                platform,
                'INSERT INTO transport122(id,value) VALUES(1,NULL)',
                [],
                'write',
              ),
            { code: 'POSTGRES_QUERY_ONLY' },
          );
          first.request({ op: 'release', scope: tenant(1), name: 'ct_sp_1' });
          second.request({ op: 'release', scope: tenant(2), name: 'ct_sp_2' });
        } finally {
          first.request({ op: 'rollback', scope: platform });
          second.request({ op: 'rollback', scope: platform });
        }
        first.request({ op: 'begin', scope: platform, mode: 'DEFERRED' });
        try {
          assert.throws(() => second.request({ op: 'begin', scope: platform, mode: 'IMMEDIATE' }), {
            code: 'POSTGRES_BUSY',
            retryableBeforeBegin: true,
            transactionOpen: false,
          });
        } finally {
          first.request({ op: 'rollback', scope: platform });
        }
      },
    );

    await t.test(
      'native held cursor fetches pages and explicitly closes without an all-result facade',
      () => {
        const scope = tenant(3);
        const { cursor } = first.request({
          op: 'cursorOpen',
          scope,
          plan: plan('SELECT n::bigint AS id FROM generate_series(1,5) AS n'),
        });
        const page1 = first.request({ op: 'cursorNext', scope, cursor, size: 2 });
        const page2 = first.request({ op: 'cursorNext', scope, cursor, size: 2 });
        assert.deepEqual(
          page1.rows.map((row) => row.id),
          [1n, 2n],
        );
        assert.deepEqual(
          page2.rows.map((row) => row.id),
          [3n, 4n],
        );
        first.request({ op: 'cursorClose', scope, cursor });
        assert.throws(() => first.request({ op: 'cursorNext', scope, cursor, size: 2 }), {
          code: 'POSTGRES_CURSOR_SCOPE',
        });
      },
    );

    await t.test(
      'assistant authority is a dedicated physical session lock and loses ownership on connection death',
      async () => {
        const owner1 = createPostgresCoordinator({
          allowBlocking: true,
          connection: runtime.application,
        });
        const owner2 = createPostgresCoordinator({
          allowBlocking: true,
          connection: runtime.application,
        });
        try {
          await Promise.all([owner1.ready(), owner2.ready()]);
          const lock1 = owner1.acquireExecutorAuthority(platform.storeId);
          assert.equal(lock1.verifyOwnedSync(), true);
          assert.throws(() => owner2.acquireExecutorAuthority(platform.storeId), {
            code: 'POSTGRES_AUTHORITY_BUSY',
          });
          lock1.close();
          const lock2 = owner2.acquireExecutorAuthority(platform.storeId);
          assert.equal(lock2.verifyOwnedSync(), true);
          await admin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='cartoteca-assistant-authority' AND datname=current_database()",
          );
          assert.equal(lock2.verifyOwnedSync(), false);
          assert.throws(() => lock2.assertOwned(), { code: 'POSTGRES_AUTHORITY_LOST' });
          lock2.close();
          assert.equal(
            owner2.stats().poisoned,
            false,
            'losing assistant ownership does not replace the healthy SQL connection',
          );
        } finally {
          await Promise.all([owner1.close(), owner2.close()]);
        }
      },
    );

    await t.test(
      'healthy synchronous shutdown receives the SQL-client end ACK before physical worker exit',
      async () => {
        first.closeSync();
        await first.close();
        assert.equal(first.stats().closed, true);
        assert.equal(first.stats().exited, true);
      },
    );
  },
);
