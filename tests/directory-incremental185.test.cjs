const test = require('node:test');
const assert = require('node:assert/strict');
const { incremental185 } = require('./helpers/directory-incremental185-fixture.cjs');
const {
  createDirectorySnapshotIndex180,
  directorySnapshotIndexInfo180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');

function charge(b) {
  const full = createDirectorySnapshotIndex180(b.f.rows, { revision: 0, timeZone: b.f.timeZone });
  assert.equal(
    b.info().charge,
    directorySnapshotIndexInfo180(full).charge + 72 * b.records.size + 512,
    'all reused strings/date arrays and new proof metadata fully charged',
  );
}
test('185 one-row current change decodes/stringifies only changed projection+summary and preserves page/order', async () => {
  const b = incremental185();
  const stringify = JSON.stringify,
    descriptors = Object.getOwnPropertyDescriptors;
  const compare = Object.getOwnPropertyDescriptor(Intl.Collator.prototype, 'compare');
  let jsons = 0,
    shapes = 0,
    comparisons = 0;
  JSON.stringify = function (value, ...rest) {
    if (value?.id && Array.isArray(value.appointments) && Number.isInteger(value.visitCount))
      jsons++;
    return stringify.call(this, value, ...rest);
  };
  Object.getOwnPropertyDescriptors = function (value) {
    if (value?.id && Array.isArray(value.appointments) && Number.isInteger(value.visitCount))
      shapes++;
    return descriptors(value);
  };
  Object.defineProperty(Intl.Collator.prototype, 'compare', {
    ...compare,
    get() {
      const original = compare.get.call(this);
      return (...args) => {
        comparisons++;
        return original(...args);
      };
    },
  });
  try {
    assert.equal((await b.read()).status, 200);
    b.commit();
    assert.equal(b.counts.projection, b.records.size);
    assert.equal(b.counts.full, b.records.size);
    const id = b.f.rows[0].id;
    b.change(id, { phone: '+79991850000' });
    b.reset();
    jsons = shapes = comparisons = 0;
    const reply = await b.read();
    assert.equal(reply.status, 200);
    assert.equal(b.counts.projection, 1);
    assert.equal(b.counts.full, 1);
    assert.equal(jsons, 1);
    assert.equal(shapes, 1);
    assert.equal(comparisons, 0);
    assert.deepEqual(b.trace, ['initial', 'index', '384', 'all-probe', 'all-select']);
    assert.equal(b.views.stats().entries, 0);
    b.commit();
    charge(b);
    assert.deepEqual(reply.body, b.expected());
    b.change(id, { firstName: 'ААА', lastName: 'Synthetic changed185' });
    b.reset();
    comparisons = 0;
    const renamed = await b.read('sort=last&limit=100');
    assert.equal(b.counts.projection, 1);
    assert.equal(b.counts.full, 1);
    assert.ok(comparisons > 0);
    assert.deepEqual(renamed.body, b.expected('sort=last&limit=100'));
    b.commit();
    charge(b);
  } finally {
    JSON.stringify = stringify;
    Object.getOwnPropertyDescriptors = descriptors;
    Object.defineProperty(Intl.Collator.prototype, 'compare', compare);
    b.close();
  }
});
test('185 changed projection ciphertext is legal; current projection/full inconsistency stays503', async () => {
  const b = incremental185();
  try {
    await b.read();
    b.commit();
    const id = b.f.rows[0].id;
    b.projectionOnly(id);
    b.reset();
    assert.equal((await b.read()).status, 200);
    assert.equal(b.counts.projection, 1);
    assert.equal(b.counts.full, 1);
    b.commit();
    b.corruptFull(id);
    b.reset();
    await assert.rejects(b.read(), { status: 503, code: 'CABINET_DIRECTORY_INDEX' });
    assert.equal(b.counts.full, 0, 'fresh full HMAC mismatch rejected before clinical borrow');
  } finally {
    b.close();
  }
  const c = incremental185();
  try {
    await c.read();
    c.commit();
    c.corruptProjection(c.f.rows[0].id);
    c.reset();
    await assert.rejects(c.read(), { status: 503 });
    assert.equal(c.counts.full, 0);
  } finally {
    c.close();
  }
});
test('185 membership add/delete remains complete and current; removed rows are not retained by new representation', async () => {
  const b = incremental185();
  try {
    await b.read();
    b.commit();
    const row = { ...b.f.rows[0], id: 'new185', name: 'Synthetic new185', firstName: 'New185' };
    b.add(row);
    b.reset();
    const added = await b.read();
    assert.equal(b.counts.projection, 1);
    assert.equal(b.counts.full, 1);
    assert.deepEqual(added.body, b.expected());
    b.commit();
    charge(b);
    const removed = b.f.rows[0].id;
    b.remove(removed);
    b.reset();
    const next = await b.read();
    assert.equal(b.counts.projection, 0);
    assert.equal(b.counts.full, 0);
    assert.ok(!next.body.directory.some((r) => r.id === removed));
    assert.deepEqual(next.body, b.expected());
    b.commit();
    charge(b);
  } finally {
    b.close();
  }
});
test('185 detached proofs cannot alias retained data; TTL/eviction/replacement/timezone forbid old clinical borrow', async () => {
  for (const mode of ['evict', 'replace', 'expire', 'timezone', 'budget']) {
    const b = incremental185();
    try {
      await b.read();
      b.commit();
      const metadata = b.cache.proofs185(b.f.key, b.f.timeZone);
      assert.ok(metadata);
      assert.deepEqual(Object.keys(metadata.token), []);
      assert.deepEqual(Object.keys(metadata).sort(), ['hashes', 'ids', 'token']);
      metadata.hashes.fill(0);
      metadata.ids[0] = 'mutated-copy185';
      const untouched = b.cache.proofs185(b.f.key, b.f.timeZone);
      assert.notEqual(untouched.ids[0], 'mutated-copy185');
      assert.ok(untouched.hashes.some((n) => n !== 0));
      b.nextStamp();
      b.reset();
      if (mode === 'timezone') b.f.timeZone = 'UTC';
      else
        b.afterSQL(() => {
          if (mode === 'expire') b.advance(1001);
          else if (mode === 'replace') b.replaceEntry();
          else if (mode === 'budget') b.budget.retain({}, b.budget.stats().maxBytes, () => {}, {});
          else b.cache.clear();
        });
      assert.equal((await b.read()).status, 200);
      assert.equal(b.counts.full, b.records.size, mode + ' must decode fresh rows');
      if (mode === 'timezone') assert.equal(b.counts.projection, b.records.size);
      b.commit();
      charge(b);
      assert.equal(b.cache.stats().entries, 1);
      assert.equal(b.budget.stats().entries, 1);
      assert.ok(b.budget.stats().bytes >= b.info().charge);
    } finally {
      b.close();
    }
  }
});
test('185 complete fresh source count and actual full-row membership cannot be hidden by retained hashes', async () => {
  for (const mode of ['count', 'duplicate', 'missing', 'foreign']) {
    const b = incremental185();
    try {
      await b.read();
      b.commit();
      b.nextStamp();
      b.reset();
      if (mode === 'count') b.boundRows(b.records.size + 1);
      else
        b.afterSQL((rows) => {
          if (mode === 'duplicate') rows.push(rows[0]);
          else if (mode === 'missing') rows.pop();
          else rows[0] = { ...rows[0], id: 'foreign185' };
        });
      await assert.rejects(b.read(), { status: 503, code: 'CABINET_DIRECTORY_INDEX' });
      assert.equal(b.counts.full, 0);
      assert.equal(b.views.stats().entries, 0);
      assert.equal(b.cache.hasStamp180(b.f.key, b.input.operation.capturedVersions165()), false);
    } finally {
      b.close();
    }
  }
});
test('185 pending producer never publishes without ACK; unsupported current row falls back without retaining old graph', async () => {
  const b = incremental185();
  try {
    await b.read();
    b.commit();
    const id = b.f.rows[0].id;
    b.change(id, { phone: '+79991851111' });
    b.reset();
    await b.read();
    b.discard();
    assert.equal(b.cache.hasStamp180(b.f.key, b.input.operation.capturedVersions165()), false);
    b.change(id, { legacyExtra185: 'kept only by existing fallback' });
    b.reset();
    const response = await b.read();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, b.expected());
    assert.ok(b.trace.includes('selected-select'));
    assert.ok(b.views.stats().entries > 0);
  } finally {
    b.close();
  }
});
