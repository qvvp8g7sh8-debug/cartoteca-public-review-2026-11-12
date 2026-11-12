const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectoryResponseCache165,
} = require('../src/server/infrastructure/postgres/directory-response-cache165.cjs');
const body = Buffer.from('{"directory":[]}');
const zone = { timeZone: 'Europe/Moscow', explicitToday: true };

test('171 source stamp is a metadata-only hint without clock, coercion, JSON or successful-hit effects', (t) => {
  let clockReads = 0,
    touches = 0,
    forbidClock = false;
  const budget = createReadCacheBudget();
  const touch = budget.touch;
  budget.touch = (token) => {
    touches++;
    return touch(token);
  };
  const cache = createDirectoryResponseCache165({
    budget,
    now: () => {
      clockReads++;
      if (forbidClock) throw Error('hint must not check current TTL/day');
      return 1000;
    },
  });
  cache.put('key', 'v1', body, { ...zone, claimKey170: 'claim' });
  const accounting = budget.stats(),
    stats = cache.stats(),
    beforeReads = clockReads;
  forbidClock = true;
  const parse = t.mock.method(JSON, 'parse', () => {
    throw Error('hint must not parse JSON');
  });
  try {
    assert.equal(cache.hasStamp171('key', 'v1'), true);
    assert.equal(cache.hasStamp171('key', 'wrong'), false);
    assert.equal(cache.hasStamp171('missing', 'v1'), false);
    for (const stamp of [null, undefined, '', 0, false])
      assert.equal(cache.hasStamp171('key', stamp), false);
    const hostileKey = new Proxy(
      {},
      {
        get() {
          throw Error('key getter must not run');
        },
      },
    );
    const hostileStamp = new Proxy(
      {},
      {
        get() {
          throw Error('stamp getter must not run');
        },
      },
    );
    assert.equal(cache.hasStamp171(hostileKey, 'v1'), false);
    assert.equal(cache.hasStamp171('key', hostileStamp), false);
    assert.equal(clockReads, beforeReads);
    assert.equal(touches, 0);
    assert.deepEqual(budget.stats(), accounting);
    assert.deepEqual(cache.stats(), stats);
  } finally {
    parse.mock.restore();
    forbidClock = false;
  }
  assert.deepEqual(cache.get('key', 'v1'), { json: body.toString() });
  assert.equal(touches, 1);
});

test('171 a false stamp hint does not evict; overwrite and external eviction remain visible', () => {
  const budget = createReadCacheBudget({ maxBytes: 5000 });
  const cache = createDirectoryResponseCache165({ budget });
  cache.put('key', 'v1', body, { ...zone, claimKey170: 'before' });
  const before = cache.stats();
  assert.equal(cache.hasStamp171('key', 'v2'), false);
  assert.equal(cache.hasStamp171('key', null), false);
  assert.deepEqual(cache.stats(), before);
  assert.equal(
    cache.hasStamp171('key', 'v1'),
    true,
    'wrong hint did not remove a useful retained entry',
  );
  cache.put('key', 'v2', body, { ...zone, claimKey170: 'after' });
  assert.equal(cache.hasStamp171('key', 'v1'), false);
  assert.equal(cache.hasStamp171('key', 'v2'), true);
  assert.equal(cache.hasClaim170('before'), false);
  assert.equal(cache.hasClaim170('after'), true);
  budget.retain({}, 4900, () => {}, {});
  assert.equal(cache.hasStamp171('key', 'v2'), false);
  assert.equal(cache.hasClaim170('after'), false);
});

test('171 repeated hints renew neither entry LRU nor shared-budget LRU', () => {
  const budget = createReadCacheBudget({ maxBytes: 10000 });
  const cache = createDirectoryResponseCache165({ budget, maxEntries: 2 });
  cache.put('a', 'v1', body, zone);
  cache.put('b', 'v1', body, zone);
  for (let i = 0; i < 100; i++) assert.equal(cache.hasStamp171('a', 'v1'), true);
  cache.put('c', 'v1', body, zone);
  assert.equal(cache.hasStamp171('a', 'v1'), false, 'hint must not promote entry LRU');
  assert.equal(cache.hasStamp171('b', 'v1'), true);
  budget.retain({}, 9300, () => {}, {});
  assert.equal(cache.hasStamp171('b', 'v1'), false, 'hint must not promote byte LRU');
  assert.equal(cache.stats().hits, 0);
  assert.equal(cache.stats().misses, 0);
});

test('171 expired TTL or organization midnight can leave a true hint but final get denies', () => {
  let time = Date.parse('2026-10-28T20:59:59.900Z');
  const cache = createDirectoryResponseCache165({
    budget: createReadCacheBudget(),
    now: () => time,
    ttlMs: 1000,
  });
  cache.put('relative', 'v1', body, { ...zone, explicitToday: false, claimKey170: 'relative' });
  cache.put('explicit', 'v1', body, { ...zone, claimKey170: 'explicit' });
  time += 100;
  assert.equal(
    cache.hasStamp171('relative', 'v1'),
    true,
    'hint deliberately ignores organization midnight',
  );
  assert.equal(
    cache.get('relative', 'v1'),
    null,
    'final actual-body proof still checks organization day',
  );
  assert.equal(cache.hasStamp171('relative', 'v1'), false);
  assert.equal(cache.hasStamp171('explicit', 'v1'), true);
  assert.deepEqual(cache.get('explicit', 'v1'), { json: body.toString() });
  time += 900;
  assert.equal(
    cache.hasStamp171('explicit', 'v1'),
    true,
    'hint deliberately ignores exact TTL boundary',
  );
  assert.equal(cache.get('explicit', 'v1'), null);
  assert.equal(cache.hasStamp171('explicit', 'v1'), false);
  assert.equal(cache.hasClaim170('explicit'), false);
});
