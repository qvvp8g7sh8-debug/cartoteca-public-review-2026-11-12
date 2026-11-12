const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createTenantPool } = require('../src/server/infrastructure/tenant-pool.cjs');

function fixture(options = {}) {
  const opened = [],
    closed = [];
  const pool = createTenantPool({
    limit: 1,
    ...options,
    open(id) {
      opened.push(id);
      return {
        id,
        close() {
          closed.push(id);
        },
      };
    },
  });
  return { pool, opened, closed };
}
function capacity(error) {
  assert.equal(error.status, 503);
  assert.equal(error.code, 'TENANT_POOL_CAPACITY');
  assert.equal(error.retryAfter, 1);
  // The pool cannot classify earlier work in a caller that touches multiple stores.
  assert.equal(error.outcomeUnknown, undefined);
  return true;
}

test('new tenant admission stops before open; active tenants remain usable', (t) => {
  const { pool, opened, closed } = fixture();
  t.after(() => pool.close());
  const first = pool.lease(),
    second = pool.lease(),
    refused = pool.lease();
  const a = first.get('private-first'),
    b = second.get('private-second');
  assert.throws(() => refused.get('private-third'), capacity);
  assert.deepEqual(opened, ['private-first', 'private-second']);
  assert.deepEqual(closed, []);
  assert.equal(first.get('private-first'), a);
  assert.equal(second.get('private-second'), b);
  assert.equal(pool.get('private-first'), a);
  assert.equal(pool.stats().connections, 2);
  assert.equal(pool.stats().maxConnections, 2);
  assert.equal(pool.stats().refused, 1);
  assert.equal(pool.stats().openErrors, 0);
  assert.doesNotMatch(JSON.stringify(pool.stats()), /private-first|private-second|private-third/);
  refused.release();
  first.release();
  assert.deepEqual(closed, ['private-first']);
  const retry = pool.lease();
  assert.equal(retry.get('private-third').id, 'private-third');
  assert.equal(pool.stats().connections, 2);
  assert.equal(pool.stats().pinned, 2);
  first.release();
  second.release();
  retry.release();
  assert.ok(pool.stats().connections <= pool.stats().limit);
  assert.equal(new Set(closed).size, closed.length);
});

test('multiple leases on the same tenant retain one connection until the last release', (t) => {
  const { pool, closed } = fixture({ maxConnections: 1 });
  t.after(() => pool.close());
  const a = pool.lease(),
    b = pool.lease();
  assert.equal(a.get('same'), b.get('same'));
  a.release();
  assert.throws(() => pool.get('next'), capacity);
  assert.equal(b.get('same').id, 'same');
  assert.deepEqual(closed, []);
  b.release();
  assert.equal(pool.get('next').id, 'next');
  assert.deepEqual(closed, ['same']);
});

test('default pool has a finite 128-connection bound, without evicting active stores', (t) => {
  const { pool, opened, closed } = fixture({ limit: 64 });
  t.after(() => pool.close());
  const leases = Array.from({ length: 128 }, (_, i) => {
    const lease = pool.lease();
    lease.get('synthetic-' + i);
    return lease;
  });
  assert.throws(() => pool.get('over-limit'), capacity);
  assert.equal(opened.length, 128);
  assert.equal(closed.length, 0);
  assert.equal(pool.stats().peakConnections, 128);
  assert.equal(pool.stats().overBudget, 64);
  for (const lease of leases) lease.release();
  assert.equal(pool.stats().connections, 64);
  assert.equal(pool.stats().pinned, 0);
});

test('invalid hard limits are rejected and a closed pool cannot admit new stores', () => {
  for (const maxConnections of [0, 1, 2049, NaN, Infinity, 2.5, '4']) {
    assert.throws(() => fixture({ limit: 2, maxConnections }), /connection limit/);
  }
  const { pool, opened } = fixture({ limit: 1024 });
  assert.equal(pool.stats().maxConnections, 2048);
  pool.close();
  assert.throws(() => pool.get('closed'), /closed/);
  assert.deepEqual(opened, []);
});

test('failed native opens do not consume a slot or displace a pinned tenant', (t) => {
  let attempts = 0;
  const pool = createTenantPool({
    limit: 1,
    open(id) {
      attempts++;
      if (id === 'failed') throw Error('Synthetic native open failure');
      return { close() {} };
    },
  });
  t.after(() => pool.close());
  const lease = pool.lease();
  const existing = lease.get('active');
  assert.throws(() => pool.get('failed'), /Synthetic native open failure/);
  assert.equal(pool.stats().connections, 1);
  assert.equal(lease.get('active'), existing);
  assert.equal(pool.get('next') != null, true);
  assert.equal(attempts, 3);
  assert.equal(pool.stats().openErrors, 1);
  assert.equal(pool.stats().refused, 0);
  lease.release();
});

test('real SQLite leases survive capacity refusal and can finish writes before retry', (t) => {
  const databases = [];
  const pool = createTenantPool({
    limit: 1,
    open() {
      const db = new DatabaseSync(':memory:');
      databases.push(db);
      db.exec('CREATE TABLE receipts(id INTEGER PRIMARY KEY)');
      return {
        db,
        close() {
          db.close();
        },
      };
    },
  });
  t.after(() => pool.close());
  const first = pool.lease(),
    second = pool.lease();
  const a = first.get('a'),
    b = second.get('b');
  assert.throws(() => pool.get('c'), capacity);
  assert.equal(databases.length, 2);
  a.db.prepare('INSERT INTO receipts VALUES(1)').run();
  b.db.prepare('INSERT INTO receipts VALUES(2)').run();
  assert.equal(a.db.prepare('SELECT count(*) AS n FROM receipts').get().n, 1);
  assert.equal(b.db.prepare('SELECT count(*) AS n FROM receipts').get().n, 1);
  assert.equal(a.db.isOpen, true);
  assert.equal(b.db.isOpen, true);
  first.release();
  assert.equal(a.db.isOpen, false);
  const c = pool.get('c');
  assert.equal(c.db.isOpen, true);
  assert.equal(b.db.isOpen, true);
  assert.equal(databases.length, 3);
  second.release();
});
