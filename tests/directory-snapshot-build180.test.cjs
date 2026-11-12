const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fixture,
  current,
  epoch,
  storeId,
  platformStoreId,
  accountId,
  organizationId,
} = require('./helpers/directory-snapshot180-fixture.cjs');
const { compact } = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectorySnapshotCache180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-cache180.cjs');
const {
  stageDirectorySnapshot180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-build180.cjs');
function buildFixture() {
  const f = fixture(),
    hooks = [],
    trace = [],
    budget = createReadCacheBudget({ maxBytes: 1024 * 1024 }),
    cache = createDirectorySnapshotCache180({ budget });
  const rows = f.rows.map((value) => ({
    bucket: 'summary',
    id: value.id,
    value: f.crypto.encode(value),
  }));
  const source = {
    rows: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.value.byteLength + 128, 0),
  };
  let stamp = 'source-C1';
  const operation = {
    epoch,
    scope: { kind: 'cabinet', storeId },
    platform: { kind: 'platform', storeId: platformStoreId },
    cabinetCatalog: {},
    directory164: true,
    capturedVersions165: () => stamp,
    async requireDirectorySnapshotMemory180() {
      trace.push('full384');
    },
    async probe(sources) {
      trace.push('probe');
      assert.equal(sources[0].where, 's.audience=$2');
      return { sourceBounds: new Map([['cabinet:cabinet_summaries', source]]) };
    },
    async selectView(kind) {
      trace.push('select');
      assert.equal(kind, 'directory');
      return rows;
    },
    assertActive() {
      trace.push('active');
    },
    afterCommit165(hook) {
      hooks.push(hook);
    },
  };
  const input = {
    operation,
    prepared: {
      hash: f.crypto.hash,
      decode(value) {
        trace.push('decode');
        return f.crypto.decode(value);
      },
    },
    current,
    url: f.url('q=Legacy'),
    context: {
      token: 'synthetic180-cookie',
      req: {
        headers: {
          'x-cartoteca-account-id': accountId,
          'x-cartoteca-organization-id': organizationId,
        },
      },
    },
    value: {
      directory: f.rows.map(compact),
      proofs: rows.map((row) => [row.id, f.crypto.hash(row.value)]),
      revision: f.revision,
    },
    audience: '*',
    timeZone: f.timeZone,
    cache,
  };
  return {
    f,
    input,
    hooks,
    rows,
    source,
    trace,
    cache,
    setStamp: (value) => {
      stamp = value;
    },
    close() {
      cache.clear();
      budget.clear();
      f.close();
    },
  };
}
test('180 cold builder reserves full384 before SQL/decode and publishes only its captured stamp after ACK hook', async () => {
  const b = buildFixture();
  try {
    assert.equal(await stageDirectorySnapshot180(b.input), true);
    assert.deepEqual(b.trace.slice(0, 3), ['full384', 'probe', 'select']);
    assert.equal(b.cache.stats().entries, 0);
    assert.equal(b.hooks.length, 1);
    b.setStamp('source-C2');
    b.hooks[0]();
    assert.equal(b.cache.hasStamp180(b.f.key, 'source-C1'), true);
    assert.equal(
      b.cache.render(b.f.key, 'source-C2', {
        audience: '*',
        current,
        url: b.input.url,
        cursorCrypto: b.f.crypto,
      }),
      null,
      'never relabel old RR with a newer stamp',
    );
    assert.equal(
      JSON.parse(
        b.cache.render(b.f.key, 'source-C1', {
          audience: '*',
          current,
          url: b.input.url,
          cursorCrypto: b.f.crypto,
        }),
      ).directory.length,
      1,
    );
  } finally {
    b.close();
  }
});
test('180 cold builder declines oversize full sources before SELECT or any full-summary decode', async () => {
  for (const [name, value] of [
    ['rows', 2049],
    ['bytes', 2 * 1024 * 1024 + 1],
  ]) {
    const b = buildFixture();
    b.source[name] = value;
    try {
      assert.equal(await stageDirectorySnapshot180(b.input), false);
      assert.deepEqual(b.trace, ['full384', 'probe']);
      assert.equal(b.hooks.length, 0);
    } finally {
      b.close();
    }
  }
});
test('180 cold builder rejects duplicate/missing/foreign/full-summary proof mismatch without publication', async () => {
  for (const mutate of [
    (b) => b.rows.push(b.rows[0]),
    (b) => b.rows.pop(),
    (b) => {
      b.rows[0] = { ...b.rows[0], id: 'foreign180' };
    },
    (b) => {
      b.rows[0].value = b.f.crypto.encode({ ...b.f.rows[0], name: 'Changed after projection' });
    },
  ]) {
    const b = buildFixture();
    mutate(b);
    try {
      await assert.rejects(stageDirectorySnapshot180(b.input), { status: 503 });
      assert.equal(b.hooks.length, 0);
      assert.equal(b.cache.stats().entries, 0);
    } finally {
      b.close();
    }
  }
});
