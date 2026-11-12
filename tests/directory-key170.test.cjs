const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalDirectoryQuery170,
  fullDirectoryKey170,
  directoryClaimKey170,
} = require('../src/server/infrastructure/postgres/directory-key170.cjs');
const { parameters, directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const ids = Array.from(
  { length: 6 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const [epoch, platformStoreId, accountId, organizationId, sessionId, storeId] = ids;
const current = { accountId, organizationId, sessionId, role: 'owner' };
const url = (q) => new URL('/api/cabinet/directory?' + q, 'http://synthetic.invalid');
const claim = (value, extra = {}) =>
  directoryClaimKey170({
    epoch,
    platformStoreId,
    token: 'synthetic-cookie',
    url: value,
    headers: { 'x-cartoteca-account-id': accountId, 'x-cartoteca-organization-id': organizationId },
    ...extra,
  });
const full = (value, extra = {}) =>
  fullDirectoryKey170({ epoch, storeId, current, url: value, ...extra });

test('170 q canonicalization exactly preserves domain parameters and cursor identity', () => {
  const a = url('q=%20SYnthetic%20&today=2026-10-29&limit=1&cursor=Opaque%2BToken&x=1&x=2');
  const b = url('x=1&limit=1&q=synthetic&cursor=Opaque%2BToken&today=2026-10-29&x=2');
  assert.equal(canonicalDirectoryQuery170(a), canonicalDirectoryQuery170(b));
  assert.deepEqual(parameters(a), parameters(b));
  assert.equal(full(a), full(b));
  assert.equal(claim(a), claim(b));
  const cursor = new URL(b);
  cursor.searchParams.set('cursor', 'Opaque+Other');
  assert.notEqual(full(cursor), full(b));
  assert.notEqual(claim(cursor), claim(b));
  const duplicate = url(
    'q=SYnthetic&q=ignored&today=2026-10-29&limit=1&cursor=Opaque%2BToken&x=1&x=2',
  );
  assert.equal(full(duplicate), full(a), 'source reads only the first q');
  assert.notEqual(
    full(url('q=synthetic++name')),
    full(url('q=synthetic+name')),
    'inner spaces remain distinct',
  );
  assert.notEqual(
    full(url('q=ёж')),
    full(url('q=еж')),
    'matching variants are not cursor equivalence',
  );
  assert.notEqual(
    full(url('q=a&today=2026-10-29')),
    full(url('q=a')),
    'explicit day is not implicit today',
  );
});

test('170 malformed/unsupported hints stay effect-free while old cold keys remain available', () => {
  for (const value of [
    url('picker=1&q=a'),
    url('q=' + 'A'.repeat(161)),
    url('q=' + 'İ'.repeat(81)),
  ]) {
    assert.equal(canonicalDirectoryQuery170(value), null);
    assert.equal(claim(value), null);
    assert.equal(typeof full(value), 'string', 'ordinary cold path keeps its conservative raw key');
  }
  assert.equal(
    canonicalDirectoryQuery170(new URL('http://synthetic.invalid/api/cabinet/patient')),
    null,
  );
  assert.equal(canonicalDirectoryQuery170(null), null);
  assert.equal(
    claim(url('q=a'), {
      headers: { 'x-cartoteca-account-id': 'bad', 'x-cartoteca-organization-id': organizationId },
    }),
    null,
  );
  assert.equal(claim(url('q=a'), { token: 'x'.repeat(16385) }), null);
  assert.equal(full(url('')), full(url('q=')), 'absent and empty q have the same source params');
});

test('170 full body keys bind actual caller identity; private hints bind cookie and claimed tab', () => {
  const a = url('q=synthetic');
  for (const changed of [
    { epoch: ids[1] },
    { storeId: ids[1] },
    ...['organizationId', 'accountId', 'sessionId', 'role'].map((key) => ({
      current: { ...current, [key]: 'other' },
    })),
  ])
    assert.notEqual(full(a, changed), full(a));
  assert.notEqual(claim(a, { token: 'other-cookie' }), claim(a));
  assert.notEqual(claim(a, { platformStoreId: ids[5] }), claim(a));
  assert.notEqual(
    claim(a, {
      headers: { 'x-cartoteca-account-id': accountId, 'x-cartoteca-organization-id': ids[5] },
    }),
    claim(a),
  );
  assert.equal(claim(a).includes('synthetic-cookie'), false);
});

test('170 a cached case-equivalent first page still yields a valid real domain nextCursor', () => {
  const storage = {
    filename: 'synthetic-directory170-pagination',
    encode: (value) => Buffer.from(JSON.stringify(value)),
    decode: (value) => JSON.parse(value.toString()),
  };
  const snapshot = {
    revision: 7,
    directory: [
      { id: 'a', name: 'Synthetic Alpha', appointments: [] },
      { id: 'b', name: 'Synthetic Beta', appointments: [] },
      { id: 'c', name: 'Synthetic Gamma', appointments: [] },
    ],
  };
  const original = url('q=%20SYNTHETIC%20&limit=1&today=2026-10-29');
  const equivalent = url('q=synthetic&limit=1&today=2026-10-29');
  assert.equal(full(original), full(equivalent));
  const first = directoryPage(storage, current, original, snapshot);
  assert.equal(first.directory.length, 1);
  assert.ok(first.nextCursor);
  equivalent.searchParams.set('cursor', first.nextCursor);
  const second = directoryPage(storage, current, equivalent, snapshot);
  assert.equal(second.directory.length, 1);
  assert.notEqual(second.directory[0].id, first.directory[0].id);
  assert.notEqual(full(original), full(equivalent));
  const wrong = new URL(equivalent);
  wrong.searchParams.set('q', 'synthetic  alpha');
  assert.throws(() => directoryPage(storage, current, wrong, snapshot), { status: 400 });
});
