const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectoryResponseCache165,
} = require('../src/server/infrastructure/postgres/directory-response-cache165.cjs');
const zone = { timeZone: 'Europe/Moscow', explicitToday: true };
const body = (value) => Buffer.from(JSON.stringify({ directory: [{ name: value }] }));
const put = (cache, key, claim, stamp = 'v1', extra = {}) =>
  cache.put(key, stamp, body(key), { ...zone, claimKey170: claim, ...extra });

test('170 candidate hints expose only metadata and cannot promote a body before authority', (t) => {
  const budget = createReadCacheBudget({ maxBytes: 100000 });
  let touches = 0;
  const touch = budget.touch;
  budget.touch = (token) => {
    touches++;
    return touch(token);
  };
  const cache = createDirectoryResponseCache165({ budget, maxEntries: 2 });
  put(cache, 'oldest', 'claim-oldest');
  put(cache, 'newer', 'claim-newer');
  const before = cache.stats(),
    accounting = budget.stats();
  const parse = t.mock.method(JSON, 'parse', () => {
    throw Error('candidate cannot parse a body');
  });
  try {
    for (let i = 0; i < 10; i++) assert.equal(cache.hasClaim170('claim-oldest'), true);
    assert.equal(typeof cache.hasClaim170('claim-newer'), 'boolean');
    assert.equal(cache.hasClaim170('missing'), false);
    assert.deepEqual(cache.stats(), before);
    assert.deepEqual(budget.stats(), accounting);
    assert.equal(touches, 0);
  } finally {
    parse.mock.restore();
  }
  put(cache, 'third', 'claim-third');
  assert.equal(cache.hasClaim170('claim-oldest'), false, 'candidate hint did not renew entry LRU');
  assert.equal(cache.hasClaim170('claim-newer'), true);
  const bytes = cache.get('newer', 'v1');
  assert.equal(JSON.parse(bytes.json).directory[0].name, 'newer');
  assert.equal(touches, 1);
  assert.deepEqual(Object.keys(cache.stats()).sort(), [
    'entries',
    'hits',
    'invalidated',
    'misses',
    'rejected',
  ]);
});

test('170 legacy generic bytes never create a hint and metadata is charged to the existing budget', () => {
  const budget = createReadCacheBudget({ maxBytes: 1800 });
  const cache = createDirectoryResponseCache165({ budget });
  assert.equal(cache.put('legacy', 'v1', Buffer.alloc(10, ' '), zone), true);
  assert.equal(cache.hasClaim170('legacy'), false);
  assert.equal(cache.hasClaim170(undefined), false);
  assert.equal(cache.hasClaim170(null), false);
  const baseline = budget.stats().bytes;
  assert.equal(put(cache, 'a', 'short'), true);
  const charged = budget.stats().bytes - baseline;
  assert.ok(charged >= 384 + 'short'.length * 2);
  cache.clear();
  assert.equal(put(cache, 'oversized-claim-charge', 'x'.repeat(600)), false);
  assert.equal(cache.hasClaim170('x'.repeat(600)), false);
  assert.equal(cache.stats().entries, 0);
  assert.equal(budget.stats().bytes, 0);
});

test('170 every overwrite and rejected replacement unlinks the old candidate', () => {
  const cache = createDirectoryResponseCache165({ budget: createReadCacheBudget() });
  put(cache, 'key', 'before');
  put(cache, 'key', 'after');
  assert.equal(cache.hasClaim170('before'), false);
  assert.equal(cache.hasClaim170('after'), true);
  assert.equal(put(cache, 'key', 'null-stamp', null), false);
  assert.equal(cache.hasClaim170('after'), false);
  assert.equal(cache.hasClaim170('null-stamp'), false);
  put(cache, 'key', 'valid');
  assert.equal(put(cache, 'key', ''), false);
  assert.equal(cache.hasClaim170('valid'), false);
  assert.equal(cache.hasClaim170(''), false);
  assert.equal(put(cache, 'key', 'x'.repeat(2049)), false);
  const tooLarge = new Proxy(new Uint8Array(65537), {
    get(target, key) {
      if (key === 'byteLength') return 65537;
      if (key === 'buffer') throw Error('body copy before capacity admission');
      return Reflect.get(target, key, target);
    },
  });
  assert.equal(cache.put('large', 'v1', tooLarge, { ...zone, claimKey170: 'large-claim' }), false);
  assert.equal(cache.hasClaim170('large-claim'), false);
  assert.equal(cache.stats().entries, 0);
});

test('170 final exact key and stamp own the body; a shared hint grants no cross-binding body', () => {
  const cache = createDirectoryResponseCache165({ budget: createReadCacheBudget() });
  put(cache, 'same-actor-old-role', 'one-cookie');
  put(cache, 'same-actor-new-role', 'one-cookie', 'v2');
  assert.equal(cache.hasClaim170('one-cookie'), true);
  assert.equal(cache.get('other-session', 'v2'), null);
  assert.equal(cache.get('same-actor-old-role', 'v2'), null);
  assert.equal(cache.hasClaim170('one-cookie'), true, 'valid sibling still has its candidate link');
  assert.equal(cache.get('same-actor-new-role', null), null);
  assert.equal(cache.hasClaim170('one-cookie'), false);
  put(cache, 'key', 'claim');
  assert.equal(cache.get('key', undefined), null);
  assert.equal(cache.hasClaim170('claim'), false);
});

test('170 organization midnight, TTL and old rendered-day rejection remove all hints', () => {
  let now = Date.parse('2026-10-28T20:59:59.900Z');
  const cache = createDirectoryResponseCache165({
    budget: createReadCacheBudget(),
    now: () => now,
    ttlMs: 1000,
  });
  put(cache, 'relative', 'relative', 'v1', { explicitToday: false });
  put(cache, 'explicit', 'explicit');
  put(cache, 'pacific', 'pacific', 'v1', { timeZone: 'America/Los_Angeles', explicitToday: false });
  put(cache, 'shared-relative', 'shared', 'v1', { explicitToday: false });
  put(cache, 'shared-explicit', 'shared');
  now += 100;
  assert.equal(cache.hasClaim170('relative'), false);
  assert.equal(cache.hasClaim170('explicit'), true);
  assert.equal(cache.hasClaim170('pacific'), true);
  assert.equal(
    cache.hasClaim170('shared'),
    true,
    'expired first bucket link does not hide valid sibling',
  );
  assert.equal(cache.has('shared-relative'), false);
  assert.equal(
    put(cache, 'yesterday', 'yesterday', 'v1', { explicitToday: false, renderedDay: '2026-10-28' }),
    false,
  );
  assert.equal(cache.hasClaim170('yesterday'), false);
  now += 900;
  assert.equal(cache.hasClaim170('explicit'), false);
  assert.equal(cache.hasClaim170('pacific'), false);
  assert.equal(cache.hasClaim170('shared'), false);
  assert.equal(cache.stats().entries, 0);
});

test('170 shared-budget eviction, cache clear and external budget clear leave no orphan claims', () => {
  const budget = createReadCacheBudget({ maxBytes: 5000 });
  const cache = createDirectoryResponseCache165({ budget });
  put(cache, 'a', 'claim-a');
  put(cache, 'b', 'claim-b');
  const other = {},
    otherOwner = {};
  budget.retain(other, 4500, () => {}, otherOwner);
  assert.equal(cache.hasClaim170('claim-a'), false);
  assert.equal(cache.hasClaim170('claim-b'), false);
  assert.equal(cache.stats().entries, 0);
  budget.remove(other);
  put(cache, 'c', 'claim-c');
  budget.retain(other, 100, () => {}, otherOwner);
  cache.clear();
  assert.equal(cache.hasClaim170('claim-c'), false);
  assert.equal(budget.stats().entries, 1, 'cache close retains another owner');
  put(cache, 'd', 'claim-d');
  budget.clear();
  assert.equal(cache.hasClaim170('claim-d'), false);
  assert.equal(cache.stats().entries, 0);
  assert.equal(budget.stats().bytes, 0);
});

test('170 stale release callbacks cannot delete a replacement body or its claim', () => {
  const budget = createReadCacheBudget(),
    callbacks = [];
  const retain = budget.retain;
  budget.retain = (token, size, release, owner) => {
    callbacks.push(release);
    return retain(token, size, release, owner);
  };
  const cache = createDirectoryResponseCache165({ budget });
  put(cache, 'key', 'old', 'old');
  const oldRelease = callbacks[0];
  put(cache, 'key', 'new', 'new');
  oldRelease();
  assert.equal(cache.hasClaim170('old'), false);
  assert.equal(cache.hasClaim170('new'), true);
  assert.equal(JSON.parse(cache.get('key', 'new').json).directory[0].name, 'key');
  cache.clear();
  oldRelease();
  assert.equal(cache.stats().entries, 0);
});

test('170 bounded index grows only with admitted body entries and UTF8 ownership is independent', () => {
  const budget = createReadCacheBudget({ maxBytes: 8 * 1024 * 1024 });
  const cache = createDirectoryResponseCache165({ budget });
  for (let i = 0; i <= 128; i++) assert.equal(put(cache, 'key-' + i, 'claim-' + i), true);
  assert.equal(cache.stats().entries, 128);
  assert.equal(cache.hasClaim170('claim-0'), false);
  const before = budget.stats();
  for (let i = 0; i < 5000; i++) assert.equal(cache.hasClaim170('unknown-' + i), false);
  assert.deepEqual(budget.stats(), before);
  const input = body('Синтетический клиент 😀'),
    expected = input.toString();
  cache.put('unicode', 'v1', input, { ...zone, claimKey170: 'unicode' });
  input.fill(0);
  assert.equal(cache.hasClaim170('unicode'), true);
  assert.equal(cache.get('unicode', 'v1').json, expected);
  cache.clear();
  for (let i = 0; i <= 128; i++) assert.equal(cache.hasClaim170('claim-' + i), false);
  assert.equal(cache.hasClaim170('unicode'), false);
  assert.equal(budget.stats().bytes, 0);
});
