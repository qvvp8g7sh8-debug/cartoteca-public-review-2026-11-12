const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { compile } = require('../../src/server/infrastructure/postgres/dialect.cjs');
const {
  describeSqliteSchema,
} = require('../../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const tables = [
  'telegram_jobs',
  'staff_push_jobs',
  'staff_notification_jobs',
  'staff_max_jobs',
  'notification_channel_jobs',
];
function batchFixture(t, postgres = true) {
  const native = new DatabaseSync(':memory:');
  t.after(() => native.close());
  for (const table of tables)
    native.exec(
      `CREATE TABLE ${table}(id TEXT PRIMARY KEY,status TEXT NOT NULL,expires_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,lease_id TEXT,channel TEXT,next_at INTEGER NOT NULL)`,
    );
  native.exec('CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value TEXT)');
  const catalog = describeSqliteSchema(native),
    calls = [];
  const scope = { kind: 'platform', storeId: 'synthetic-maintenance126' };
  let hook;
  const db = {
    dialect: postgres ? 'postgres' : 'sqlite',
    get isTransaction() {
      return native.isTransaction;
    },
    prepare(sql) {
      const statement = native.prepare(sql),
        wrapper = {};
      for (const method of ['get', 'all', 'run'])
        wrapper[method] = (...args) => {
          const plan = postgres ? compile(sql, scope, args, method, catalog) : null;
          calls.push({ sql, args, method, plan });
          hook?.({ sql, args, method });
          return statement[method](...args);
        };
      return wrapper;
    },
  };
  function transaction(work) {
    native.exec('BEGIN');
    try {
      const result = work();
      native.exec('COMMIT');
      return result;
    } catch (error) {
      native.exec('ROLLBACK');
      throw error;
    }
  }
  function seed(table, id, options = {}) {
    native
      .prepare(
        `INSERT INTO ${table}(id,status,expires_at,lease_until,lease_id,channel,next_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        options.status || 'pending',
        options.expires ?? 2000000000,
        options.lease ?? 0,
        options.leaseId ?? null,
        options.channel || 'telegram',
        options.due ?? 1000000000,
      );
  }
  const rows = (table) =>
    native
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all()
      .map((row) => ({ ...row }));
  const writes = () =>
    calls.filter(({ method, sql }) => method === 'run' && /^(UPDATE|DELETE)/.test(sql));
  function assertCompiled() {
    for (const { plan, args } of calls) {
      assert.ok(plan?.text);
      assert.ok(['read', 'write'].includes(plan.effect));
      assert.equal(plan.values.length, args.length);
      assert.equal(plan.text.includes('?'), false);
    }
  }
  return {
    db,
    native,
    transaction,
    seed,
    rows,
    calls,
    writes,
    assertCompiled,
    before: (value) => {
      hook = value;
    },
  };
}
module.exports = { batchFixture };
