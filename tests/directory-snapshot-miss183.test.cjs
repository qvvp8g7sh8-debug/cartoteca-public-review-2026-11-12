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
const {
  compact,
  READY_KEY,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const { createReadViewCache } = require('../src/server/infrastructure/read-view-cache152.cjs');
const {
  createDirectorySnapshotCache180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-cache180.cjs');
const { readDirectory164 } = require('../src/server/infrastructure/postgres/read-directory164.cjs');

function setup({ change = () => {}, boundBytes = null } = {}) {
  const f = fixture(),
    trace = [],
    hooks = [];
  change(f.rows);
  const full = f.rows.map((summary) => ({ id: summary.id, value: f.crypto.encode(summary) }));
  const index = full.map((row, n) => ({
    kind: 'projection',
    id: row.id,
    value: f.crypto.encode({
      version: 1,
      id: row.id,
      audience: '*',
      sourceHash: f.crypto.hash(row.value),
      row: compact(f.rows[n]),
    }),
  }));
  index.push(
    ...[
      [READY_KEY, { version: 1 }],
      ['revision', f.revision],
      ['initialized', true],
    ].map(([id, value]) => ({ kind: 'meta', id, value: f.crypto.encode(value) })),
  );
  const budget = createReadCacheBudget({ maxBytes: 8 * 1024 * 1024 });
  const views = createReadViewCache({ budget });
  const snapshots180 = createDirectorySnapshotCache180({ budget });
  const operation = {
    directory164: true,
    epoch,
    scope: { kind: 'cabinet', storeId },
    platform: { kind: 'platform', storeId: platformStoreId },
    cabinetCatalog: {},
    platformCatalog: {},
    snapshot: 'physical183',
    capturedVersions165: () => 'C183',
    async requireDirectorySnapshotMemory180() {
      trace.push('384');
    },
    async probe(sources) {
      if (sources.length > 1) {
        trace.push('initial');
        return { clinicalWitness: 'witness183' };
      }
      const selected = sources[0].values.length === 2;
      trace.push(selected ? 'selected-probe' : 'all-probe');
      return {
        sourceBounds: new Map([
          [
            'cabinet:cabinet_summaries',
            {
              rows: full.length,
              bytes: boundBytes ?? full.reduce((n, row) => n + row.value.byteLength + 128, 0),
            },
          ],
        ]),
      };
    },
    async selectDirectory164(kind, selection) {
      trace.push(kind === 'index' ? 'index' : 'selected-select');
      return kind === 'index' ? index : full.filter((row) => selection.ids.includes(row.id));
    },
    async selectView(kind) {
      assert.equal(kind, 'directory');
      trace.push('all-select');
      return full.map((row) => ({ ...row, bucket: 'summary' }));
    },
    afterCommit165(hook) {
      hooks.push(hook);
    },
    assertActive() {},
  };
  const input = {
    operation,
    current,
    url: f.url('limit=100'),
    views,
    cacheKey: 'cache183',
    readCacheBudget: budget,
    snapshots180,
    context: {
      token: 'synthetic183',
      req: {
        headers: {
          'x-cartoteca-account-id': accountId,
          'x-cartoteca-organization-id': organizationId,
        },
      },
      res: {},
      json: (_res, status, body) => ({ status, body }),
    },
    prepared: {
      ...f.crypto,
      platform: { async prefetchProjectionAsync() {}, organizationTimeZone: () => f.timeZone },
      directory: 'synthetic183-' + Math.random(),
    },
  };
  return {
    f,
    full,
    input,
    hooks,
    trace,
    budget,
    views,
    snapshots180,
    close() {
      snapshots180.clear();
      views.clear();
      budget.clear();
      f.close();
    },
  };
}
function comparable(body, crypto) {
  return {
    ...body,
    nextCursor: body.nextCursor ? crypto.decode(Buffer.from(body.nextCursor, 'base64url')) : null,
  };
}

test('183 cold page uses complete private proof-bound index without selected SQL or legacy retention', async () => {
  for (const query of [
    '',
    'q=Legacy',
    'q=Еж&sort=last',
    'filter=appointment',
    'filter=recent',
    'filter=inactive',
    'limit=1',
  ]) {
    const b = setup();
    try {
      b.input.url = b.f.url(query);
      const reply = await readDirectory164(b.input);
      assert.equal(reply.status, 200);
      assert.deepEqual(
        comparable(reply.body, b.f.crypto),
        comparable(b.f.legacy(b.input.url), b.f.crypto),
      );
      assert.deepEqual(b.trace, ['initial', 'index', '384', 'all-probe', 'all-select']);
      assert.equal(b.views.stats().entries, 0);
      assert.equal(
        b.budget.stats().entries,
        0,
        'neither legacy base nor binary cachedRows before ACK',
      );
      assert.equal(b.snapshots180.stats().entries, 0);
      assert.equal(b.hooks.length, 1);
      b.hooks[0]();
      assert.equal(b.views.stats().entries, 0);
      assert.equal(b.snapshots180.stats().entries, 1);
      assert.equal(b.budget.stats().entries, 1, 'only charged private snapshot retained');
    } finally {
      b.close();
    }
  }
});

test('183 oversize source, unsupported full shape and >64KiB page preserve legacy response/fallback', async () => {
  for (const options of [
    { boundBytes: 2 * 1024 * 1024 + 1 },
    {
      change: (rows) => {
        rows[0].legacyExtra = 'preserved';
      },
    },
    {
      change: (rows) => {
        for (const row of rows)
          Object.assign(row, {
            name: 'n'.repeat(4096),
            firstName: 'f'.repeat(4096),
            lastName: 'l'.repeat(4096),
            phone: 'p'.repeat(4096),
          });
      },
    },
  ]) {
    const b = setup(options);
    try {
      const reply = await readDirectory164(b.input);
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, b.f.legacy(b.input.url));
      assert.ok(b.trace.includes('selected-probe'));
      assert.ok(b.trace.includes('selected-select'));
      assert.equal(
        b.trace.filter((kind) => kind === 'all-probe').length,
        1,
        'no duplicate build after fallback',
      );
      assert.equal(b.views.stats().entries, 1);
      for (const hook of b.hooks) hook();
      assert.equal(b.snapshots180.stats().entries, 0);
      if (options.boundBytes)
        assert.ok(!b.trace.includes('all-select'), 'byte bound precedes all-summary SQL');
      if (options.change && Buffer.byteLength(JSON.stringify(reply.body)) > 65536)
        assert.ok(b.views.stats().entries > 1);
    } finally {
      b.close();
    }
  }
});

test('183 corrupt full proof remains fail-closed rather than falling back or publishing', async () => {
  const b = setup();
  try {
    b.full[0].value = b.f.crypto.encode({
      ...b.f.rows[0],
      phone: 'changed without matching projection',
    });
    await assert.rejects(readDirectory164(b.input), {
      status: 503,
      code: 'CABINET_DIRECTORY_INDEX',
    });
    assert.equal(b.views.stats().entries, 0);
    assert.equal(b.hooks.length, 0);
    assert.equal(b.snapshots180.stats().entries, 0);
    assert.ok(!b.trace.includes('selected-select'));
  } finally {
    b.close();
  }
});

test('183 cursor validation keeps legacy 400/409 and cannot stage a rejected page', async () => {
  for (const stale of [false, true]) {
    const b = setup();
    try {
      let cursor = 'invalid';
      if (stale) {
        const first = b.f.legacy(b.f.url('limit=1'));
        const decoded = b.f.crypto.decode(Buffer.from(first.nextCursor, 'base64url'));
        cursor = b.f.crypto
          .encode({ ...decoded, revision: decoded.revision - 1 })
          .toString('base64url');
      }
      b.input.url = b.f.url('limit=1&cursor=' + encodeURIComponent(cursor));
      assert.throws(() => b.f.legacy(b.input.url), { status: stale ? 409 : 400 });
      await assert.rejects(readDirectory164(b.input), { status: stale ? 409 : 400 });
      assert.equal(b.views.stats().entries, 0);
      assert.equal(b.hooks.length, 0);
    } finally {
      b.close();
    }
  }
});
