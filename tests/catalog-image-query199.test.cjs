const test = require('node:test');
const assert = require('node:assert/strict');
const { variants199 } = require('../src/server/infrastructure/postgres/catalog-image-sql199.cjs');
const {
  wrapCatalogImageQuery199,
} = require('../src/server/infrastructure/postgres/catalog-image-query199.cjs');
const {
  primeCatalogImage199,
} = require('../src/server/infrastructure/postgres/catalog-image-prime199.cjs');
const epoch = '11111111-2222-4333-8444-555555555555';
const capability = () => ({
  version: 1,
  epoch,
  digest: 'a'.repeat(64),
  variants: { metadata169: true, directory196: true, patient197: true },
});
function plan(variant) {
  const v = variants199[variant],
    n = v.argTypes.split(',').length - 2;
  return {
    text: `SELECT * FROM ${v.oldFunction}(${Array.from({ length: n }, (_, i) => '$' + (i + 1)).join(',')})`,
    values: Array.from({ length: n }, (_, i) => 'arg' + i),
    expected: Object.freeze({ original: true }),
  };
}
test('verified alias selection preserves every original argument and response expectation', () => {
  for (const variant of Object.keys(variants199)) {
    const original = plan(variant),
      before = [...original.values];
    const converted = wrapCatalogImageQuery199(() => original, capability(), variant)({});
    assert.match(
      converted.text,
      new RegExp('^SELECT \\* FROM ' + variants199[variant].functionName.replaceAll('.', '\\.')),
    );
    assert.deepEqual(converted.values, [...before, epoch, 'a'.repeat(64)]);
    assert.deepEqual(original.values, before);
    assert.equal(converted.expected, original.expected);
    assert.notEqual(converted.values, original.values);
  }
});
test('absent or disabled components retain the exact legacy builder; unsupported plans remain unsupported', () => {
  const builder = () => plan('metadata169');
  assert.equal(wrapCatalogImageQuery199(builder, null, 'metadata169'), builder);
  const c = capability();
  c.variants.metadata169 = false;
  assert.equal(wrapCatalogImageQuery199(builder, c, 'metadata169'), builder);
  const unsupported = { unsupported: 'explicit-binding' };
  assert.equal(
    wrapCatalogImageQuery199(() => unsupported, capability(), 'metadata169')({}),
    unsupported,
  );
});
test('unverified selectors, tokens, altered SQL and wrong argument counts fail before forwarding', () => {
  for (const c of [
    { ...capability(), epoch: 'bad' },
    { ...capability(), digest: 'bad' },
    { ...capability(), version: 2 },
    { ...capability(), variants: {} },
  ])
    assert.throws(() => wrapCatalogImageQuery199(() => plan('metadata169'), c, 'metadata169'), {
      status: 503,
    });
  assert.throws(() => wrapCatalogImageQuery199(() => ({}), capability(), '__proto__'), {
    status: 503,
  });
  for (const p of [
    { ...plan('metadata169'), text: plan('metadata169').text + ';SELECT 1' },
    { ...plan('metadata169'), values: [] },
    plan('patient197'),
  ])
    assert.throws(() => wrapCatalogImageQuery199(() => p, capability(), 'metadata169')({}), {
      status: 503,
    });
});
test('the private verified generation is captured once and cannot be replaced by caller input', () => {
  const c = capability(),
    builder = wrapCatalogImageQuery199(() => plan('metadata169'), c, 'metadata169');
  c.epoch = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  c.digest = 'b'.repeat(64);
  const p = builder({ epoch: c.epoch, digest: c.digest, functionName: 'other' });
  assert.deepEqual(p.values.slice(-2), [epoch, 'a'.repeat(64)]);
});
function fixture(badBody = false) {
  const calls = [],
    received = {},
    marker = {
      stores: [{ kind: 'cabinet', storeId: epoch, organizationId: epoch, schemaVersion: 2 }],
    };
  const queries = Object.fromEntries(
    Object.keys(variants199).map((v) => [
      v,
      (input) => {
        received[v] = input;
        return { text: v, values: [] };
      },
    ]),
  );
  const sql = async (text) => {
    calls.push(text);
    if (text.includes('pg_try_advisory_lock_shared')) return { rows: [{ held: true }] };
    if (text === 'metadata169' || text === 'directory196')
      return { rows: [{ id: null, account_value: null, session_value: null, fence_locked: true }] };
    if (text === 'patient197')
      return {
        rows: [
          {
            section197: badBody ? 'body197' : 'guard197',
            payload197: { reason: 'dependency', locked: true, released: true },
            cipher197: badBody ? Buffer.from('synthetic') : null,
            account197: null,
            session197: null,
          },
        ],
      };
    return { rows: [] };
  };
  return { calls, received, marker, queries, sql };
}
test('startup compiles metadata and capsule plans with absent random authority and no clinical caches', async () => {
  const f = fixture();
  await primeCatalogImage199({ ...f, capability: capability() });
  assert.deepEqual(f.calls.slice(0, 2), ['metadata169', 'directory196']);
  assert.match(f.calls[2], /pg_try_advisory_lock_shared/);
  assert.deepEqual(f.calls.slice(3), [
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'patient197',
    'COMMIT',
  ]);
  assert.equal(f.received.metadata169.claimedAccountId, f.received.patient197.current.accountId);
  assert.notEqual(f.received.patient197.current.accountId, epoch);
  assert.notEqual(f.received.patient197.current.sessionId, epoch);
  assert.equal(f.received.patient197.selection.kind, 'card');
  assert.equal(f.received.patient197.scope.organizationId, epoch);
});
test('unexpected clinical output during startup is rejected and its read-only transaction rolls back', async () => {
  const f = fixture(true);
  await assert.rejects(primeCatalogImage199({ ...f, capability: capability() }), { status: 503 });
  assert.equal(f.calls.at(-1), 'ROLLBACK');
  assert.ok(!f.calls.includes('COMMIT'));
});
test('no component, no cabinet or a metadata-only component primes no capsule or patient', async () => {
  for (const mode of ['absent', 'empty', 'metadata']) {
    const f = fixture(),
      c = capability();
    if (mode === 'empty') f.marker.stores = [];
    if (mode === 'metadata')
      c.variants = { metadata169: true, directory196: false, patient197: false };
    await primeCatalogImage199({ ...f, capability: mode === 'absent' ? null : c });
    assert.deepEqual(f.calls, mode === 'metadata' ? ['metadata169'] : []);
  }
});
