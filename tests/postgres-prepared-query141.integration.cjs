const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');

test(
  'native prepared SQL preserves fresh bindings, statement recovery and RR abort',
  { timeout: 90000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin);
    let transport;
    t.after(async () => {
      try {
        await transport?.close();
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
      'CREATE TABLE pipeline141(id bigint PRIMARY KEY, value bytea); GRANT SELECT,INSERT,UPDATE,DELETE ON pipeline141 TO cartoteca_app',
    );
    transport = createTransport({ connection: runtime.application, timeoutMs: 5000 });
    await transport.ready();
    const scope = { kind: 'platform', storeId: 'synthetic141' };
    const run = (text, values = [], effect = 'read') =>
      transport.request(
        {
          op: 'execute',
          scope,
          plan: { text, values, effect },
          method: 'all',
          mutating: effect === 'write',
        },
        { mutating: effect === 'write' },
      );
    const insert = 'INSERT INTO pipeline141(id,value) VALUES($1,$2)';
    const read = 'SELECT id,value FROM pipeline141 WHERE id=$1';
    transport.request({ op: 'begin', scope, mode: 'IMMEDIATE' });
    for (let i = 0; i < 8; i++) {
      const id = 9007199254740993n + BigInt(i),
        value = i % 2 ? null : Buffer.from('value-' + i);
      run(insert, [id, value], 'write');
      assert.deepEqual(run(read, [id]).rows, [{ id, value }]);
    }
    assert.throws(() => run(insert, [9007199254740993n, Buffer.from('duplicate')], 'write'), {
      code: '23505',
      transactionOpen: true,
    });
    assert.equal(run('SELECT COUNT(*) AS n FROM pipeline141').rows[0].n, 8n);
    // The final step can fail before PostgreSQL receives any SQL. Its earlier
    // successful write must still roll back to the statement savepoint.
    assert.throws(
      () =>
        transport.request(
          {
            op: 'execute',
            scope,
            method: 'all',
            mutating: true,
            plan: {
              steps: [
                { text: insert, values: [99n, Buffer.from('must roll back')], effect: 'write' },
                { text: '', values: [], effect: 'read' },
              ],
            },
          },
          { mutating: true },
        ),
      { code: 'POSTGRES_PLAN_INVALID', channelPoisoned: false },
    );
    assert.deepEqual(run(read, [99n]).rows, []);
    assert.equal(run('SELECT COUNT(*) AS n FROM pipeline141').rows[0].n, 8n);
    const prepared = run(
      "SELECT name,generic_plans,custom_plans FROM pg_prepared_statements WHERE name LIKE 'ct_query_%'",
    ).rows;
    assert.ok(prepared.length >= 2);
    assert.ok(prepared.some((row) => row.generic_plans + row.custom_plans >= 7n));
    transport.request({ op: 'rollback', scope });
    assert.equal((await admin.query('SELECT COUNT(*) AS n FROM pipeline141')).rows[0].n, '0');
    transport.request({ op: 'begin', scope, mode: 'READONLY' });
    assert.throws(() => run('SELECT 1/0 AS bad'), { code: '22012' });
    assert.throws(() => run(read, [1n]), { code: '25P02' });
    transport.request({ op: 'rollback', scope });
    assert.deepEqual(run(read, [1n]).rows, []);
    assert.equal(transport.stats().poisoned, false);
  },
);
