const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, current } = require('./helpers/directory-snapshot180-fixture.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectorySnapshotCache180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-cache180.cjs');
test('180 private snapshot metadata hints cannot authorize stale/foreign/mutated output', () => {
  const f = fixture();
  let now = 100;
  const budget = createReadCacheBudget({ maxBytes: 1024 * 1024 });
  const cache = createDirectorySnapshotCache180({ budget, now: () => now, ttlMs: 100 });
  const item = { key: f.key, claim: f.claim, stamp: 'C1', audience: '*', index: f.snapshot };
  const input = { audience: '*', current, url: f.url('q=Legacy'), cursorCrypto: f.crypto };
  try {
    assert.equal(
      cache.publish({ ...item, index: {} }),
      false,
      'unbranded graphs are not trusted entries',
    );
    assert.equal(cache.publish(item), true);
    assert.equal(cache.hasClaim180(f.claim), true);
    assert.equal(cache.stats().hits, 0);
    assert.equal(cache.render(f.key, 'C2', input), null);
    assert.equal(cache.render(f.key, 'C1', { ...input, audience: 'a'.repeat(64) }), null);
    const value = cache.render(f.key, 'C1', input);
    assert.equal(JSON.parse(value).directory.length, 1);
    now += 101;
    assert.equal(cache.hasStamp180(f.key, 'C1'), true, 'stamp is only a hint before TTL check');
    assert.equal(cache.render(f.key, 'C1', input), null);
    assert.equal(cache.hasClaim180(f.claim), false);
    assert.equal(budget.stats().bytes, 0);
  } finally {
    cache.clear();
    f.close();
  }
});
test('180 snapshot budget/row eviction overwrite and clear release every claim and retained byte', () => {
  const f = fixture(),
    budget = createReadCacheBudget({ maxBytes: 1024 * 1024 });
  const cache = createDirectorySnapshotCache180({ budget, maxRows: 6 });
  const item = { key: f.key, claim: f.claim, stamp: 'C1', audience: '*', index: f.snapshot };
  try {
    assert.equal(cache.publish(item), true);
    assert.equal(cache.publish({ ...item, key: 'other-key', claim: 'other-claim' }), true);
    assert.equal(cache.hasClaim180(f.claim), false);
    assert.equal(cache.stats().rows, 6);
    cache.publish({ ...item, key: 'other-key', claim: 'replacement', stamp: 'C2' });
    assert.equal(cache.hasClaim180('other-claim'), false);
    budget.clear();
    assert.equal(cache.hasClaim180('replacement'), false);
    assert.equal(cache.stats().entries, 0);
    cache.publish(item);
    cache.clear();
    assert.equal(cache.stats().rows, 0);
    assert.equal(budget.stats().bytes, 0);
  } finally {
    cache.clear();
    f.close();
  }
});
