const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreparedWrites } = require('../src/server/infrastructure/cabinet-prepared-write.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');

const patient = () => ({ id: 'p', name: 'Synthetic', visits: [], appointments: [] });
function values() {
  const before = { revision: 2, patients: [patient()], services: [] },
    next = structuredClone(before),
    changed = { patients: ['p'], services: [] };
  next.patients[0].notes = 'Synthetic edit';
  return { before, next, changed };
}
const build = ({ next }) => new Map([[JSON.stringify(next.patients[0]), Buffer.from('cipher')]]);

test('prepared tickets are opaque, immutable, bound to exact input and single use', () => {
  const f = values(),
    original = Buffer.from('cipher');
  const prepared = createPreparedWrites({
    prepare: (snapshot) => {
      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(snapshot.next.patients[0]));
      assert.notEqual(snapshot.before, f.before);
      return new Map([[JSON.stringify(snapshot.next.patients[0]), original]]);
    },
  });
  const token = prepared.prepare(f.before, f.next, f.changed);
  assert.deepEqual(Object.keys(token), []);
  assert.ok(Object.isFrozen(token));
  original.fill(0);
  const plan = prepared.take(
    token,
    structuredClone(f.before),
    structuredClone(f.next),
    structuredClone(f.changed),
  );
  assert.equal(plan.get(JSON.stringify(f.next.patients[0])).toString(), 'cipher');
  assert.equal(prepared.take(token, f.before, f.next, f.changed), null);
});

test('foreign, forged and discarded tickets cannot supply ciphertext', () => {
  const f = values(),
    a = createPreparedWrites({ prepare: build }),
    b = createPreparedWrites({ prepare: build });
  const token = a.prepare(f.before, f.next, f.changed);
  for (const invalid of [{}, null, undefined, 1, 'token'])
    assert.equal(a.take(invalid, f.before, f.next, f.changed), null);
  assert.equal(b.take(token, f.before, f.next, f.changed), null);
  assert.ok(a.take(token, f.before, f.next, f.changed));
  const cancelled = a.prepare(f.before, f.next, f.changed);
  a.discard(cancelled);
  a.discard(cancelled);
  assert.equal(a.take(cancelled, f.before, f.next, f.changed), null);
});

test('every revision, before, next and changed-ID mismatch consumes and invalidates the ticket', () => {
  const changes = [
    (f) => f.before.revision++,
    (f) => f.next.revision++,
    (f) => {
      f.before.patients[0].phone = '+79990000001';
    },
    (f) => {
      f.next.patients[0].notes = 'Another value';
    },
    (f) => {
      f.changed.patients.push('another');
    },
  ];
  for (const alter of changes) {
    const f = values(),
      original = structuredClone(f),
      prepared = createPreparedWrites({ prepare: build });
    const token = prepared.prepare(f.before, f.next, f.changed);
    alter(f);
    assert.equal(prepared.take(token, f.before, f.next, f.changed), null);
    assert.equal(prepared.take(token, original.before, original.next, original.changed), null);
  }
});

test('new photo payloads are not prepared, existing references still require exact equality', () => {
  const f = values();
  let calls = 0;
  const prepared = createPreparedWrites({
    prepare: (snapshot) => {
      calls++;
      return build(snapshot);
    },
  });
  f.next.patients[0].visits.push({
    id: 'v',
    photos: [{ data: 'data:image/png;base64,c3ludGhldGlj' }],
  });
  assert.equal(prepared.prepare(f.before, f.next, f.changed), null);
  assert.equal(calls, 0);
  f.next.patients[0].visits[0].photos[0].data = '/api/photos/' + 'a'.repeat(32);
  const token = prepared.prepare(f.before, f.next, f.changed);
  assert.ok(token);
  f.next.patients[0].visits[0].photos[0].data = '/api/photos/' + 'b'.repeat(32);
  assert.equal(prepared.take(token, f.before, f.next, f.changed), null);
});

test('shared retention budget evicts outstanding plans across tenant instances', () => {
  const f = values(),
    budget = createReadCacheBudget({ maxBytes: 1100 });
  const a = createPreparedWrites({ prepare: build, budget }),
    b = createPreparedWrites({ prepare: build, budget });
  const first = a.prepare(f.before, f.next, f.changed),
    second = b.prepare(f.before, f.next, f.changed);
  assert.ok(first);
  assert.ok(second);
  assert.equal(budget.stats().entries, 1);
  assert.ok(budget.stats().evictions > 0);
  assert.equal(a.take(first, f.before, f.next, f.changed), null);
  assert.ok(b.take(second, f.before, f.next, f.changed));
  assert.equal(budget.stats().bytes, 0);
});

test('preparation is byte-bounded and closing one owner preserves other tenant tickets', () => {
  const f = values();
  let calls = 0;
  const budget = createReadCacheBudget({ maxBytes: 10000 });
  const small = createPreparedWrites({
    maxBytes: 10,
    budget,
    prepare: () => {
      calls++;
      return new Map();
    },
  });
  assert.equal(small.prepare(f.before, f.next, f.changed), null);
  assert.equal(calls, 0);
  const largePlan = createPreparedWrites({
    maxBytes: 1000,
    budget,
    prepare: () => new Map([['x', Buffer.alloc(1001)]]),
  });
  assert.equal(largePlan.prepare(f.before, f.next, f.changed), null);
  assert.equal(budget.stats().entries, 0);
  const a = createPreparedWrites({ prepare: build, budget }),
    b = createPreparedWrites({ prepare: build, budget });
  const first = a.prepare(f.before, f.next, f.changed),
    second = b.prepare(f.before, f.next, f.changed);
  a.clear();
  assert.equal(a.take(first, f.before, f.next, f.changed), null);
  assert.ok(b.take(second, f.before, f.next, f.changed));
  assert.equal(budget.stats().bytes, 0);
});

test('malformed internal cipher plans and async builders are rejected, never retained', () => {
  const f = values(),
    budget = createReadCacheBudget();
  for (const prepare of [
    () => Promise.resolve(new Map()),
    () => ({}),
    () => new Map([['x', 'not-buffer']]),
  ]) {
    const prepared = createPreparedWrites({ prepare, budget });
    assert.throws(() => prepared.prepare(f.before, f.next, f.changed), /Invalid prepared/);
  }
  assert.equal(budget.stats().entries, 0);
});

test('private compact cipher tickets retain no second history clone and remain exact/single-use', () => {
  const f = values(),
    history = Array.from({ length: 500 }, (_, n) => ({
      id: 'v' + n,
      procedure: 'Synthetic',
      photos: [],
    }));
  f.before.patients[0].visits = history;
  f.next.patients[0].visits = history;
  let calls = 0,
    expected = f;
  const prepared = createPreparedWrites({
    copyInput: false,
    prepare(snapshot) {
      calls++;
      assert.equal(snapshot.before, expected.before);
      assert.equal(snapshot.next, expected.next);
      assert.equal(snapshot.next.patients[0].visits, expected.next.patients[0].visits);
      return build(snapshot);
    },
  });
  const token = prepared.prepare(f.before, f.next, f.changed);
  assert.equal(calls, 1);
  assert.ok(token);
  const original = structuredClone(f);
  f.next.patients[0].visits[0].procedure = 'Changed after prepare';
  assert.equal(prepared.take(token, f.before, f.next, f.changed), null);
  assert.equal(prepared.take(token, original.before, original.next, original.changed), null);
  expected = original;
  const valid = prepared.prepare(original.before, original.next, original.changed);
  assert.ok(
    prepared.take(
      valid,
      structuredClone(original.before),
      structuredClone(original.next),
      structuredClone(original.changed),
    ),
  );
});
