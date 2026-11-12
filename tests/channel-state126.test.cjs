const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createNotificationChannelState,
} = require('../src/server/modules/notifications/channel-state.cjs');
const KEY = 'notification-channel-state-v1';
function fixture(t, dialect = 'postgres') {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec('CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL)');
  const counts = { external: 0, local: 0, row: 0 };
  let revision = 0;
  const seal = (value) => Buffer.from(JSON.stringify(value)),
    open = (value) => JSON.parse(Buffer.from(value).toString());
  const db = {
    dialect,
    get isTransaction() {
      return raw.isTransaction;
    },
    prepare(sql) {
      if (/^PRAGMA data_version$/i.test(sql))
        return {
          get() {
            counts.external++;
            return dialect === 'postgres' ? { data_version: revision } : raw.prepare(sql).get();
          },
        };
      if (/^SELECT total_changes\(\) AS n$/i.test(sql))
        return {
          get() {
            counts.local++;
            return dialect === 'postgres' ? { n: revision } : raw.prepare(sql).get();
          },
        };
      const statement = raw.prepare(sql);
      return {
        get(...args) {
          if (sql === 'SELECT value FROM telegram_runtime WHERE key=?') counts.row++;
          return statement.get(...args);
        },
        all: (...args) => statement.all(...args),
        run: (...args) => statement.run(...args),
      };
    },
  };
  const transaction = (work) => {
    const before = raw.prepare('SELECT total_changes() n').get().n;
    raw.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      raw.exec('COMMIT');
      if (raw.prepare('SELECT total_changes() n').get().n !== before) revision++;
      return result;
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }
  };
  const write = (value) =>
    raw.prepare('INSERT OR REPLACE INTO telegram_runtime VALUES(?,?)').run(KEY, seal(value));
  const read = () =>
    open(raw.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(KEY).value);
  const reset = () => {
    counts.external = counts.local = counts.row = 0;
  };
  const state = createNotificationChannelState(
    { db, seal, open, transaction },
    { telegram: true, max: true, push: true },
  );
  return { raw, db, state, counts, transaction, write, read, reset };
}

test('PG channel checks inside a transaction read the fresh row each time without either version RPC', (t) => {
  const f = fixture(t);
  assert.equal(f.state.enabled('telegram'), true);
  f.reset();
  f.transaction(() => {
    assert.equal(f.state.enabled('telegram'), true);
    assert.equal(f.state.version('telegram'), '');
    const next = f.read();
    next.telegram = { enabled: false, version: 'synthetic-new-epoch' };
    f.write(next);
    assert.equal(f.state.enabled('telegram'), false);
    assert.equal(f.state.version('telegram'), 'synthetic-new-epoch');
    assert.deepEqual(f.counts, { external: 0, local: 0, row: 4 });
  });
  f.reset();
  assert.equal(f.state.enabled('telegram'), false);
  assert.deepEqual(f.counts, { external: 1, local: 0, row: 1 });
});

test('rollback cannot publish a transactional channel row into the outside committed cache', (t) => {
  const f = fixture(t);
  assert.equal(f.state.enabled('telegram'), true);
  assert.equal(f.state.version('telegram'), '');
  assert.throws(
    () =>
      f.transaction(() => {
        const next = f.read();
        next.telegram = { enabled: false, version: 'synthetic-rollback' };
        f.write(next);
        assert.equal(f.state.enabled('telegram'), false);
        assert.equal(f.state.version('telegram'), 'synthetic-rollback');
        throw Error('Synthetic rollback');
      }),
    /Synthetic rollback/,
  );
  f.reset();
  assert.equal(f.state.enabled('telegram'), true);
  assert.equal(f.state.version('telegram'), '');
  assert.deepEqual(
    f.counts,
    { external: 2, local: 0, row: 0 },
    'unchanged committed revision can reuse only its original committed row',
  );
});

test('a new outside committed revision invalidates the channel row with one PG version RPC', (t) => {
  const f = fixture(t);
  assert.equal(f.state.enabled('max'), true);
  f.reset();
  assert.equal(f.state.enabled('max'), true);
  assert.deepEqual(f.counts, { external: 1, local: 0, row: 0 });
  f.transaction(() => {
    const next = f.read();
    next.max = { enabled: false, version: 'synthetic-external' };
    f.write(next);
  });
  f.reset();
  assert.equal(f.state.enabled('max'), false);
  assert.deepEqual(f.counts, { external: 1, local: 0, row: 1 });
  f.reset();
  assert.equal(f.state.version('max'), 'synthetic-external');
  assert.deepEqual(f.counts, { external: 1, local: 0, row: 0 });
});

test('SQLite outside checks retain the external/local counter pair and transaction checks remain fresh', (t) => {
  const f = fixture(t, 'sqlite');
  assert.equal(f.state.enabled('push'), true);
  f.reset();
  assert.equal(f.state.enabled('push'), true);
  assert.deepEqual(f.counts, { external: 1, local: 1, row: 0 });
  f.reset();
  f.transaction(() => {
    assert.equal(f.state.enabled('push'), true);
    const next = f.read();
    next.push = { enabled: false, version: 'synthetic-sqlite' };
    f.write(next);
    assert.equal(f.state.enabled('push'), false);
    assert.deepEqual(f.counts, { external: 0, local: 0, row: 2 });
  });
  f.reset();
  assert.equal(f.state.enabled('push'), false);
  assert.deepEqual(f.counts, { external: 1, local: 1, row: 1 });
});
