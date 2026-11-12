const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');

function fixture(handler = () => null) {
  const calls = [];
  const state = { poisoned: false, closed: false };
  const transport = {
    ready: async () => {},
    stats: () => ({ ...state, ready: !state.closed }),
    close: async () => {
      state.closed = true;
    },
    closeSync: () => {
      state.closed = true;
    },
    request(command) {
      calls.push(command);
      const value = handler(command, calls);
      return value === undefined ? null : value;
    },
  };
  const owner = createPostgresCoordinator({
    allowBlocking: true,
    transport,
    catalog: { tables: {} },
    compile: (sql, scope, args) => ({
      text: sql,
      values: args,
      effect: /^SELECT/.test(sql) ? 'read' : 'write',
      returningId: /^INSERT/.test(sql) ? 'id' : undefined,
    }),
  });
  return { owner, calls };
}
const platform = { kind: 'platform', storeId: 'platform-synthetic' };
const cabinet = { kind: 'cabinet', storeId: '00000000-0000-4000-8000-000000000001' };

test('blocking PostgreSQL facade requires an explicit isolated owner capability', () => {
  assert.throws(() => createPostgresCoordinator({}), { code: 'POSTGRES_ISOLATED_OWNER_REQUIRED' });
});

test('logical stores share the outer connection transaction and tenant savepoint in strict order', () => {
  const f = fixture();
  const p = f.owner.open(platform),
    c = f.owner.open(cabinet);
  p.exec('BEGIN IMMEDIATE');
  assert.equal(p.isTransaction, true);
  assert.equal(c.isTransaction, false);
  c.exec('BEGIN IMMEDIATE');
  assert.equal(c.isTransaction, true);
  assert.throws(() => p.exec('COMMIT'), { code: 'POSTGRES_TRANSACTION_ORDER' });
  c.exec('COMMIT');
  p.exec('COMMIT');
  assert.deepEqual(
    f.calls.map((call) => call.op),
    ['begin', 'savepoint', 'release', 'commit'],
  );
  assert.equal(p.isTransaction, false);
  assert.equal(c.isTransaction, false);
});

test('shared cabinet commit denies platform writes while permitting tenant writes', () => {
  const f = fixture((command) =>
    command.op === 'execute' ? { rows: [], fields: [], rowCount: 1 } : undefined,
  );
  const p = f.owner.open(platform),
    c = f.owner.open(cabinet);
  p.sharedCommit(() => {
    assert.throws(() => p.prepare('UPDATE private_rows SET value=?').run('synthetic'), {
      code: 'POSTGRES_QUERY_ONLY',
    });
    c.transaction(() =>
      assert.equal(
        c.prepare('UPDATE patients SET value=?').run(Buffer.from('synthetic')).changes,
        1,
      ),
    );
  });
  assert.equal(f.calls[0].mode, 'SHARED');
  assert.equal(f.calls.filter((call) => call.op === 'execute').length, 1);
  assert.equal(f.calls.find((call) => call.op === 'execute').scope.kind, 'cabinet');
});

test('callback error rolls back tenant savepoint then outer transaction without replay', () => {
  const f = fixture();
  const p = f.owner.open(platform),
    c = f.owner.open(cabinet);
  const marker = Error('synthetic failure');
  assert.throws(
    () =>
      p.transaction(() =>
        c.transaction(() => {
          throw marker;
        }),
      ),
    (error) => error === marker,
  );
  assert.deepEqual(
    f.calls.map((call) => call.op),
    ['begin', 'savepoint', 'rollbackTo', 'release', 'rollback'],
  );
});

test('thenable transaction callbacks are rejected and rolled back synchronously', () => {
  const f = fixture(),
    p = f.owner.open(platform);
  assert.throws(() => p.transaction(() => Promise.resolve(1)), {
    code: 'POSTGRES_ASYNC_TRANSACTION',
  });
  assert.deepEqual(
    f.calls.map((call) => call.op),
    ['begin', 'rollback'],
  );
});

test('integer values retain exactness, hidden store columns stay hidden, opt-in BigInt is exact', () => {
  const f = fixture(() => ({
    rows: [
      {
        id: 9007199254740993n,
        _store_id: 'never-expose',
        _rowid: 1n,
        value: Buffer.from('cipher'),
      },
    ],
    fields: [
      { name: 'id', dataTypeID: 20 },
      { name: '_store_id', dataTypeID: 25 },
      { name: '_rowid', dataTypeID: 20 },
      { name: 'value', dataTypeID: 17 },
    ],
    rowCount: 1,
  }));
  const statement = f.owner.open(cabinet).prepare('SELECT * FROM patients');
  assert.throws(() => statement.get(), { code: 'POSTGRES_INTEGER_RANGE' });
  const row = statement.setReadBigInts(true).get();
  assert.equal(row.id, 9007199254740993n);
  assert.equal(row.value.toString(), 'cipher');
  assert.deepEqual(Object.keys(row), ['id', 'value']);
});

test('iterate requests true cursor pages and closes the server cursor on early return', () => {
  let page = 0;
  const f = fixture((command) => {
    if (command.op === 'cursorOpen') return { cursor: 'synthetic_cursor' };
    if (command.op === 'cursorNext')
      return {
        rows: page++ ? [] : [{ id: 1n }, { id: 2n }],
        fields: [{ name: 'id', dataTypeID: 20 }],
        rowCount: 2,
      };
  });
  for (const row of f.owner.open(cabinet).prepare('SELECT id FROM patients').iterate()) {
    assert.equal(row.id, 1);
    break;
  }
  assert.deepEqual(
    f.calls.map((call) => call.op),
    ['cursorOpen', 'cursorNext', 'cursorClose'],
  );
});

test('busy BEGIN maps legacy acquisition error without executing a callback', () => {
  const f = fixture(() => {
    throw Object.assign(Error('busy'), {
      code: 'POSTGRES_BUSY',
      retryableBeforeBegin: true,
      transactionOpen: false,
    });
  });
  const p = f.owner.open(platform);
  let callbacks = 0;
  assert.throws(
    () => p.transaction(() => callbacks++),
    (error) =>
      error.code === 'ERR_SQLITE_ERROR' &&
      error.errcode === 5 &&
      error.status === 503 &&
      error.retryableBeforeBegin,
  );
  assert.equal(callbacks, 0);
  assert.equal(p.isTransaction, false);
});

test('unknown commit is never repeated or followed by an automatic mutation retry', () => {
  const f = fixture((command) => {
    if (command.op === 'commit')
      throw Object.assign(Error('unknown'), {
        code: 'POSTGRES_CONNECTION_FAILED',
        outcomeUnknown: true,
      });
  });
  let callbacks = 0;
  assert.throws(() => f.owner.open(platform).transaction(() => callbacks++), {
    outcomeUnknown: true,
  });
  assert.equal(callbacks, 1);
  assert.equal(f.calls.filter((call) => call.op === 'commit').length, 1);
});

test('logical query_only and busy_timeout do not pretend to change PostgreSQL locking capabilities', () => {
  const f = fixture(),
    p = f.owner.open(platform),
    c = f.owner.open(cabinet);
  p.exec('PRAGMA busy_timeout=0');
  p.exec('PRAGMA query_only=ON');
  assert.deepEqual(p.prepare('PRAGMA busy_timeout').get(), { timeout: 0 });
  assert.deepEqual(p.prepare('PRAGMA query_only').get(), { query_only: 1 });
  assert.equal(c.prepare('PRAGMA query_only').get().query_only, 0);
  assert.throws(() => p.prepare('DELETE FROM accounts').run(), { code: 'POSTGRES_QUERY_ONLY' });
  assert.equal(f.calls.length, 0);
});

test('PostgreSQL numeric aggregates preserve integer counts and finite fractional values', () => {
  const f = fixture(() => ({
    rows: [{ total: '42', average: '1.5' }],
    fields: [
      { name: 'total', dataTypeID: 1700 },
      { name: 'average', dataTypeID: 1700 },
    ],
    rowCount: 1,
  }));
  const statement = f.owner
    .open(cabinet)
    .prepare('SELECT SUM(bytes) AS total,AVG(bytes) AS average FROM photos');
  assert.deepEqual(statement.get(), { total: 42, average: 1.5 });
  assert.deepEqual(statement.setReadBigInts(true).get(), { total: 42n, average: 1.5 });
});

test('boolean SQL expressions preserve SQLite integer result types', () => {
  const f = fixture(() => ({
    rows: [{ found: true, missing: false }],
    fields: [
      { name: 'found', dataTypeID: 16 },
      { name: 'missing', dataTypeID: 16 },
    ],
    rowCount: 1,
  }));
  const statement = f.owner
    .open(cabinet)
    .prepare('SELECT EXISTS(SELECT 1 FROM patients) AS found,1 IS NULL AS missing');
  assert.deepEqual(statement.get(), { found: 1, missing: 0 });
  assert.deepEqual(statement.setReadBigInts(true).get(), { found: 1n, missing: 0n });
});

test('asset lineage verification is closed, exact and cached only for the entire immutable profile tuple', () => {
  const original = {
    platformStoreId: '00000000-0000-4000-8000-000000000101',
    migrationId: '00000000-0000-4000-8000-000000000102',
    markerHash: 'a'.repeat(64),
  };
  let allowed = true;
  const f = fixture((command) => (command.op === 'verifyProfile' ? allowed : undefined));
  assert.equal(f.owner.verifyProfile(original), true);
  assert.equal(f.owner.verifyProfile({ ...original }), true);
  assert.equal(f.calls.length, 1, 'only the exact previously verified tuple may use the cache');
  assert.deepEqual(f.calls[0], {
    op: 'verifyProfile',
    scope: { kind: 'platform', storeId: original.platformStoreId },
    migrationId: original.migrationId,
    markerHash: original.markerHash,
    mutating: false,
  });
  allowed = false;
  for (const changed of [
    { ...original, markerHash: 'b'.repeat(64) },
    { ...original, migrationId: '00000000-0000-4000-8000-000000000103' },
    { ...original, platformStoreId: '00000000-0000-4000-8000-000000000104' },
  ])
    assert.throws(() => f.owner.verifyProfile(changed), {
      code: 'POSTGRES_ASSET_LINEAGE_MISMATCH',
      status: 503,
    });
  const calls = f.calls.length;
  assert.throws(() => f.owner.verifyProfile({ ...original, markerHash: 'not-a-hash' }), {
    code: 'POSTGRES_ASSET_LINEAGE_MISMATCH',
  });
  assert.equal(f.calls.length, calls, 'invalid profile never reaches SQL transport');
  assert.equal(
    f.owner.verifyProfile(original),
    true,
    'failed alternative cannot replace the valid cached tuple',
  );
  f.owner.closeSync();
  assert.throws(() => f.owner.verifyProfile(original), { code: 'POSTGRES_CLOSED' });
});
