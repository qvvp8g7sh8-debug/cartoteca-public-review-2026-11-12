const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const { createPreparedStatements } = require('../src/server/infrastructure/prepared-statements.cjs');
const { createTenantPool } = require('../src/server/infrastructure/tenant-pool.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');

test('shared read budget bounds different tenants and evicts least recently used entries', () => {
  const budget = createReadCacheBudget({ maxBytes: 10 });
  const a = {}, b = {}, c = {}, evicted = [];
  budget.retain(a, 4, () => evicted.push('a'), 'first');
  budget.retain(b, 4, () => evicted.push('b'), 'second');
  budget.touch(a);
  assert.equal(budget.retain(c, 5, () => evicted.push('c'), 'second'), true);
  assert.deepEqual(evicted, ['b']);
  assert.equal(budget.stats().bytes, 9);
  assert.equal(budget.retain({}, 11, () => {}, 'third'), false);
  budget.releaseOwner('first');
  assert.deepEqual(evicted, ['b', 'a']);
  budget.clear();
  assert.deepEqual(evicted, ['b', 'a', 'c']);
  assert.equal(budget.stats().bytes, 0);
  assert.ok(budget.stats().peakBytes <= 10);
  assert.equal(createReadCacheBudget({ maxBytes: 0 }).retain({}, 0, () => {}), false);
});

test('prepared statements reuse only their connection and observe current rows and rollback', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)');
    const statements = createPreparedStatements(db, { limit: 2 });
    const select = statements.prepare('SELECT value FROM sample WHERE id=?');
    assert.equal(statements.prepare('SELECT value FROM sample WHERE id=?'), select);
    db.prepare('INSERT INTO sample VALUES(?,?)').run(1, 'first');
    assert.equal(select.get(1).value, 'first');
    db.exec("BEGIN; UPDATE sample SET value='second'");
    assert.equal(select.get(1).value, 'second');
    db.exec('ROLLBACK');
    assert.equal(select.get(1).value, 'first');
    statements.prepare('SELECT 1'); statements.prepare('SELECT 2');
    assert.notEqual(statements.prepare('SELECT value FROM sample WHERE id=?'), select);
    assert.equal(statements.stats().entries, 2);
    statements.clear(); assert.equal(statements.stats().entries, 0);
  } finally { db.close(); }
});

test('pool records churn, idle eviction and failed opens without evicting pinned stores', () => {
  let clock = 0;
  const closed = [];
  const pool = createTenantPool({ limit: 2, idleMs: 1000, now: () => clock,
    open(id) { if (id === 'failure') throw Error('synthetic'); return { close() { closed.push(id); } }; } });
  try {
    const lease = pool.lease(); lease.get('a'); pool.get('b'); pool.get('b');
    clock = 2000; pool.sweep();
    assert.deepEqual(closed, ['b']);
    assert.equal(pool.stats().pinned, 1);
    assert.throws(() => pool.get('failure'), /synthetic/);
    assert.equal(pool.stats().openErrors, 1);
    lease.release(); clock = 3001; pool.sweep();
    assert.deepEqual(closed, ['b', 'a']);
    assert.equal(pool.stats().connections, 0);
    assert.equal(pool.stats().hits, 1);
    assert.equal(pool.stats().opens, 2);
  } finally { pool.close(); }
  assert.throws(() => pool.get('a'), /closed/);
});

test('directory caches share a byte budget and closing a tenant releases only its entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-resource-cache-'));
  const budget = createReadCacheBudget({ maxBytes: 100000 });
  const stores = ['a', 'b'].map((id) => createStorage(path.join(root, id), { readCacheBudget: budget }));
  t.after(() => { for (const store of stores) if (store.db.isOpen) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = new URL('http://test/?today=2030-01-01');
  const users = stores.map((_, i) => ({ organizationId: String(i), accountId: String(i), role: 'owner' }));
  for (const [i, store] of stores.entries()) {
    store.write({ revision: 0, patients: [{ id: 'p', name: 'Synthetic ' + i, phone: '', visits: [], appointments: [] }], services: [] });
    assert.equal(directoryPage(store, users[i], url).total, 1);
  }
  const before = budget.stats().bytes;
  assert.equal(budget.stats().entries, 6, 'base, sort and view bytes are charged for both tenants');
  stores[0].close();
  assert.equal(budget.stats().entries, 3, 'closing one tenant releases its base and derived byte entries');
  assert.ok(budget.stats().bytes < before);
  assert.equal(directoryPage(stores[1], users[1], url).directory[0].name, 'Synthetic 1');
});

test('pool keeps bounded close phase distributions, no tenant labels and independent snapshots', () => {
  let failClose = true;
  const pool = createTenantPool({ limit: 1, open() { return { close(observe) {
    observe('cleanup', 0.5, false);
    observe('database', failClose ? 1500 : 5, failClose);
    observe('private-tenant', 1, false);
    if (failClose) throw Error('Synthetic close failure');
  } }; } });
  try {
    pool.get('private-tenant');
    assert.throws(() => pool.get('second'), /Synthetic close failure/);
    assert.equal(pool.stats().connections, 1);
    failClose = false;
    pool.get('second');
    const snapshot = pool.stats();
    assert.equal(snapshot.closes, 1);
    assert.equal(snapshot.closeErrors, 1);
    assert.deepEqual(snapshot.closePhases.cleanup, {
      count: 2, errors: 0, totalMs: 1, maxMs: 0.5, buckets: [2, 0, 0, 0, 0, 0, 0, 0],
    });
    assert.deepEqual(snapshot.closePhases.database, {
      count: 2, errors: 1, totalMs: 1505, maxMs: 1500, buckets: [0, 1, 0, 0, 0, 0, 0, 1],
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /private-tenant/);
    snapshot.closeBoundsMs[0] = -1;
    snapshot.closePhases.database.buckets[0] = 900;
    snapshot.closePhases.database.count = 900;
    assert.equal(pool.stats().closeBoundsMs[0], 1);
    assert.equal(pool.stats().closePhases.database.count, 2);
    assert.equal(pool.stats().closePhases.database.buckets[0], 0);
  } finally { pool.close(); }
});

test('real storage reports cleanup and database close independently and ignores failing diagnostics', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-resource-close-'));
  const budget = createReadCacheBudget(), store = createStorage(root, { readCacheBudget: budget });
  t.after(() => { if (store.db.isOpen) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.readServices();
  const timings = [];
  store.close((name, elapsed, failed) => {
    timings.push({ name, elapsed, failed, open: store.db.isOpen,
      statements: store.statementStats().entries, entries: budget.stats().entries });
    throw Error('Synthetic observer failure');
  });
  assert.deepEqual(timings.map(row => [row.name, row.failed]), [['cleanup', false], ['database', false]]);
  assert.ok(timings.every(row => Number.isFinite(row.elapsed) && row.elapsed >= 0));
  assert.equal(timings[0].open, true);
  assert.equal(timings[0].statements, 0);
  assert.equal(timings[0].entries, 0);
  assert.equal(store.db.isOpen, false);
});
