const test = require('node:test');
const assert = require('node:assert/strict');
const batch = require('../src/server/infrastructure/postgres/readonly-read-batch140.cjs');
const scope = { kind: 'platform', storeId: 'synthetic', organizationId: 'one' };
const request = (values) => ({
  method: 'all',
  plan: { text: 'SELECT value FROM synthetic WHERE id=$1', values, effect: 'read' },
});
test('equal original and V8-cloned parameter values address the same response-local result', () => {
  const original = request([
    'Синтетика',
    'ascii',
    Buffer.from([0, 1, 255]),
    1,
    -0,
    1n,
    null,
    undefined,
    true,
    new Date('2035-01-01T00:00:00Z'),
    [1, 'nested'],
    { a: 1, b: 'two' },
  ]);
  assert.equal(batch.key(scope, original), batch.key(scope, batch.clone(original)));
  const backing = Uint8Array.from([77, 0, 1, 255, 88]);
  const view = new DataView(backing.buffer, 1, 3);
  assert.equal(
    batch.key(scope, request([view])),
    batch.key(scope, request([Buffer.from([0, 1, 255])])),
  );
  assert.equal(batch.key(scope, request([view])), batch.key(scope, batch.clone(request([view]))));
  const bytes = request([Uint8Array.from([0, 1, 255])]);
  assert.equal(batch.key(scope, bytes), batch.key(scope, request([Buffer.from([0, 1, 255])])));
});
test('method, physical scope, ordered values and parameter types cannot share a cache entry', () => {
  const baseline = batch.key(scope, request(['1', 2]));
  for (const other of [
    request([1, 2]),
    request(['1', '2']),
    request([2, '1']),
    { ...request(['1', 2]), method: 'get' },
  ])
    assert.notEqual(batch.key(scope, other), baseline);
  assert.notEqual(batch.key({ ...scope, organizationId: 'two' }, request(['1', 2])), baseline);
  assert.notEqual(batch.key({ ...scope, storeId: 'other' }, request(['1', 2])), baseline);
  assert.notEqual(batch.key(scope, request([undefined])), batch.key(scope, request([null])));
});
test('bound object property order remains distinct when PostgreSQL consumes JSON as text', () => {
  assert.notEqual(
    batch.key(scope, request([{ a: 1, b: 2 }])),
    batch.key(scope, request([{ b: 2, a: 1 }])),
  );
  const value = request([{ b: 2, a: 1 }]);
  assert.equal(batch.key(scope, value), batch.key(scope, batch.clone(value)));
});
test('fresh session authority cannot be enrolled even through qualified quoted SQL', () => {
  assert.throws(
    () =>
      batch.read({
        method: 'get',
        plan: {
          effect: 'read',
          values: [],
          text: 'SELECT * FROM "cartoteca_platform"."platform_sessions"',
        },
      }),
    { code: 'POSTGRES_READ_BATCH_AUTHORITY' },
  );
});

test('a remembered session-free SQL fact never bypasses fresh descriptor fields or changed text', () => {
  const value = request(['one']);
  batch.read(value);
  batch.key(scope, value);
  const original = value.plan.text;
  for (const change of [
    () => (value.plan.effect = 'write'),
    () => (value.method = 'run'),
    () => (value.plan.steps = []),
    () => (value.plan.control = 'BEGIN'),
    () => (value.extra = true),
  ]) {
    const saved = batch.clone(value);
    change();
    assert.throws(() => batch.read(value), { code: 'POSTGRES_READ_BATCH_INVALID' });
    for (const key of Object.keys(value)) delete value[key];
    Object.assign(value, saved);
  }
  for (const text of [
    'SELECT * FROM platform_sessions',
    'SELECT * FROM "cartoteca_platform"."platform_sessions"',
  ]) {
    value.plan.text = text;
    for (let n = 0; n < 2; n++)
      assert.throws(() => batch.read(value), { code: 'POSTGRES_READ_BATCH_AUTHORITY' });
  }
  value.plan.text = original;
  value.plan.values = ['different'];
  assert.equal(batch.read(value), value);
  assert.notEqual(batch.key(scope, value), batch.key(scope, request(['one'])));
  assert.notEqual(batch.key(scope, value), batch.key({ ...scope, storeId: 'foreign' }, value));
});
