const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectoryResponseCache165,
} = require('../src/server/infrastructure/postgres/directory-response-cache165.cjs');
const zone = { timeZone: 'Europe/Moscow', explicitToday: false };
const body = (name) => Buffer.from(JSON.stringify({ directory: [{ id: name, name }] }));
const key = (role, extra = {}) =>
  JSON.stringify({
    organizationId: 'synthetic-org',
    accountId: 'synthetic-' + role,
    session: 'synthetic-session-' + role,
    role,
    url: '/api/cabinet/directory?q=synthetic',
    epoch: 'synthetic-epoch',
    ...extra,
  });

test('165 directory response bytes require the full caller key and a fresh non-null stamp', () => {
  const budget = createReadCacheBudget({ maxBytes: 100000 }),
    cache = createDirectoryResponseCache165({ budget });
  for (const role of ['owner', 'salon_admin', 'cosmetologist'])
    assert.equal(cache.put(key(role), 'one', body(role), zone), true);
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    assert.equal(cache.has(key(role)), true);
    assert.equal(JSON.parse(cache.get(key(role), 'one').json).directory[0].name, role);
  }
  for (const change of [
    { organizationId: 'other' },
    { session: 'other' },
    { accountId: 'other' },
    { url: '/api/cabinet/directory?q=other' },
    { epoch: 'other' },
  ])
    assert.equal(cache.get(key('owner', change), 'one'), null);
  assert.equal(cache.get(key('owner'), null), null);
  assert.equal(cache.has(key('owner')), false);
  assert.equal(cache.get(key('salon_admin'), 'changed'), null);
  assert.equal(cache.put('unattested', null, body('one'), zone), false);
  assert.equal(cache.put('undefined', undefined, body('one'), zone), false);
  assert.equal(cache.get('undefined', undefined), null);
  assert.equal(cache.stats().hits, 3);
  assert.equal(cache.stats().invalidated, 2);
  cache.clear();
  assert.equal(budget.stats().bytes, 0);
});

test('165 directory response TTL and organization midnight are checked without reading a body', () => {
  let time = Date.parse('2026-10-28T20:59:59.900Z');
  const cache = createDirectoryResponseCache165({
    budget: createReadCacheBudget(),
    now: () => time,
    ttlMs: 1000,
  });
  cache.put('relative', 'one', body('relative'), zone);
  cache.put('explicit', 'one', body('explicit'), { ...zone, explicitToday: true });
  cache.put('pacific', 'one', body('pacific'), { timeZone: 'America/Los_Angeles' });
  time += 100;
  assert.equal(cache.has('relative'), false, 'Moscow day changed before TTL');
  assert.ok(cache.get('explicit', 'one'));
  assert.ok(cache.get('pacific', 'one'), 'host UTC or Moscow day cannot expire another zone');
  time += 900;
  assert.equal(cache.has('explicit'), false, 'exact TTL boundary expires');
  assert.equal(cache.get('pacific', 'one'), null);
  assert.deepEqual(cache.stats(), { hits: 2, misses: 1, invalidated: 3, rejected: 0, entries: 0 });
});

test('165 directory response refuses a cold implicit day that expired before publication', () => {
  let calls = 0;
  const cache = createDirectoryResponseCache165({
    budget: createReadCacheBudget(),
    now: () => {
      calls++;
      return Date.parse('2026-10-28T21:00:00.001Z');
    },
  });
  assert.equal(
    cache.put('old-day', 'one', body('yesterday'), {
      ...zone,
      renderedDay: '2026-10-28',
    }),
    false,
  );
  assert.equal(calls, 1, 'publication checks use one clock snapshot');
  assert.equal(cache.stats().entries, 0);
  assert.equal(
    cache.put('same-day', 'one', body('today'), {
      ...zone,
      renderedDay: '2026-10-29',
    }),
    true,
  );
  assert.equal(calls, 2);
  assert.equal(
    cache.put('fixed-day', 'one', body('fixed'), {
      ...zone,
      explicitToday: true,
      renderedDay: '2026-10-28',
    }),
    true,
    'an explicit query date remains valid across midnight',
  );
  assert.equal(calls, 3);
  assert.deepEqual(cache.stats(), {
    hits: 0,
    misses: 0,
    invalidated: 0,
    rejected: 1,
    entries: 2,
  });
});

test('165 directory response rejects oversized bytes before string copy and owns independent small bytes', () => {
  const cache = createDirectoryResponseCache165({ budget: createReadCacheBudget() });
  const tooLarge = Buffer.alloc(65537);
  tooLarge.toString = () => {
    throw Error('oversized string copy');
  };
  assert.equal(cache.put('large', 'one', tooLarge, zone), false);
  assert.equal(cache.has('large'), false);
  const source = body('Клиент'),
    expected = source.toString();
  assert.equal(cache.put('small', 'one', source, zone), true);
  source.fill(0);
  const hit = cache.get('small', 'one');
  assert.equal(hit.json, expected);
  hit.json = 'changed';
  assert.equal(cache.get('small', 'one').json, expected);
  const owned = new ArrayBuffer(2);
  Buffer.from(owned).write('{}');
  assert.equal(cache.put('array', 'one', owned, zone), true);
  Buffer.from(owned).fill(0);
  assert.deepEqual(cache.get('array', 'one'), { json: '{}' });
  assert.equal(cache.put('boundary', 'one', Buffer.alloc(65536, ' '), zone), true);
  assert.equal(cache.put('string', 'one', '{}', zone), false);
  assert.equal(cache.stats().rejected, 2);
});

test('165 directory response entries share byte LRU, entry LRU and owner cleanup', () => {
  const budget = createReadCacheBudget({ maxBytes: 5000 }),
    cache = createDirectoryResponseCache165({ budget, maxEntries: 2 });
  cache.put('a', 'one', body('a'), zone);
  cache.put('b', 'one', body('b'), zone);
  cache.get('a', 'one');
  cache.put('c', 'one', body('c'), zone);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  const other = {},
    otherOwner = {};
  assert.equal(
    budget.retain(other, 4400, () => {}, otherOwner),
    true,
  );
  assert.equal(cache.stats().entries, 0, 'another shared-budget owner evicts cached responses');
  assert.equal(cache.put('too-budgeted', 'one', Buffer.alloc(3000), zone), false);
  budget.remove(other);
  cache.put('d', 'one', body('d'), zone);
  budget.retain(other, 100, () => {}, otherOwner);
  cache.clear();
  assert.equal(cache.stats().entries, 0);
  assert.equal(budget.stats().entries, 1, 'clear releases only this cache owner');
});

test('165 directory response configuration cannot grow the fixed response envelope', () => {
  const budget = createReadCacheBudget();
  for (const options of [
    { maxBodyBytes: 65537 },
    { maxEntries: 129 },
    { ttlMs: 60001 },
    { maxBodyBytes: 0 },
    { maxEntries: 0 },
    { now: 1 },
  ])
    assert.throws(() => createDirectoryResponseCache165({ budget, ...options }), /bounds/);
  const cache = createDirectoryResponseCache165({ budget, maxBodyBytes: 16 });
  assert.equal(cache.put('small-cap', 'one', Buffer.alloc(17), zone), false);
});
