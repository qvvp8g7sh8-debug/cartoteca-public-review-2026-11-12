const {
  fixture,
  current,
  epoch,
  storeId,
  platformStoreId,
  accountId,
  organizationId,
} = require('./directory-snapshot180-fixture.cjs');
const {
  compact,
  READY_KEY,
  encodeProjection,
} = require('../../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { createReadCacheBudget } = require('../../src/server/infrastructure/read-cache-budget.cjs');
const { createReadViewCache } = require('../../src/server/infrastructure/read-view-cache152.cjs');
const {
  createDirectorySnapshotCache180,
} = require('../../src/server/infrastructure/postgres/directory-snapshot-cache180.cjs');
const {
  directorySnapshotIndexInfo180,
} = require('../../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');
const {
  readDirectory164,
} = require('../../src/server/infrastructure/postgres/read-directory164.cjs');
const { directoryPage } = require('../../src/server/modules/cabinet/directory.cjs');

function incremental185() {
  const f = fixture(),
    records = new Map(),
    trace = [],
    counts = { projection: 0, full: 0, meta: 0 };
  let boundRows = null;
  let revision = f.revision,
    stamp = 1,
    now = Date.now(),
    hooks = [],
    afterSQL = null,
    lastIndex = null;
  const budget = createReadCacheBudget({ maxBytes: 8 * 1024 * 1024 });
  const views = createReadViewCache({ budget });
  const cache = createDirectorySnapshotCache180({ budget, now: () => now, ttlMs: 1000 });
  const publish = cache.publish;
  cache.publish = (data) => {
    lastIndex = data.index;
    return publish(data);
  };
  function put(summary) {
    const cipher = f.crypto.encode(summary);
    records.set(summary.id, {
      summary,
      cipher,
      projection: encodeProjection(summary, '*', cipher, f.crypto),
    });
  }
  for (const row of f.rows) put(row);
  function sync() {
    f.rows.splice(0, f.rows.length, ...[...records.values()].map((r) => r.summary));
    revision++;
    stamp++;
  }
  const operation = {
    directory164: true,
    epoch,
    scope: { kind: 'cabinet', storeId },
    platform: { kind: 'platform', storeId: platformStoreId },
    cabinetCatalog: {},
    platformCatalog: {},
    snapshot: 'physical185',
    capturedVersions165: () => 'C185-' + stamp,
    async requireDirectorySnapshotMemory180() {
      trace.push('384');
    },
    async probe(sources) {
      if (sources.length > 1) {
        trace.push('initial');
        return { clinicalWitness: 'witness185-' + stamp };
      }
      trace.push(sources[0].values.length === 2 ? 'selected-probe' : 'all-probe');
      return {
        sourceBounds: new Map([
          [
            'cabinet:cabinet_summaries',
            {
              rows: boundRows ?? records.size,
              bytes: [...records.values()].reduce((n, r) => n + r.cipher.byteLength + 128, 0),
            },
          ],
        ]),
      };
    },
    async selectDirectory164(kind, selection) {
      if (kind === 'full') {
        trace.push('selected-select');
        return [...records.values()]
          .filter((r) => selection.ids.includes(r.summary.id))
          .map((r) => ({ id: r.summary.id, value: r.cipher }));
      }
      trace.push('index');
      return [...records.values()]
        .map((r) => ({ kind: 'projection', id: r.summary.id, value: r.projection }))
        .concat(
          [
            [READY_KEY, { version: 1 }],
            ['revision', revision],
            ['initialized', true],
          ].map(([id, value]) => ({ kind: 'meta', id, value: f.crypto.encode(value) })),
        );
    },
    async selectView(kind) {
      trace.push('all-select');
      const rows = [...records.values()].map((r) => ({
        bucket: 'summary',
        id: r.summary.id,
        value: r.cipher,
      }));
      afterSQL?.(rows);
      afterSQL = null;
      return rows;
    },
    afterCommit165(hook) {
      hooks.push(hook);
    },
    assertActive() {},
  };
  const prepared = {
    ...f.crypto,
    decode(value) {
      const decoded = f.crypto.decode(value);
      if (decoded && typeof decoded === 'object' && decoded.sourceHash) counts.projection++;
      else if (
        decoded &&
        typeof decoded === 'object' &&
        Array.isArray(decoded.appointments) &&
        decoded.id
      )
        counts.full++;
      else counts.meta++;
      return decoded;
    },
    directory: 'synthetic185-' + Math.random(),
    platform: { async prefetchProjectionAsync() {}, organizationTimeZone: () => f.timeZone },
  };
  const input = {
    operation,
    prepared,
    current,
    url: f.url('limit=100'),
    views,
    cacheKey: 'cache185',
    readCacheBudget: budget,
    snapshots180: cache,
    context: {
      token: 'synthetic185',
      req: {
        headers: {
          'x-cartoteca-account-id': accountId,
          'x-cartoteca-organization-id': organizationId,
        },
      },
      res: {},
      json: (_res, status, body) => ({ status, body }),
    },
  };
  return {
    f,
    input,
    cache,
    budget,
    views,
    counts,
    trace,
    records,
    reset() {
      for (const k in counts) counts[k] = 0;
      trace.length = 0;
      hooks = [];
    },
    async read(query = 'limit=100') {
      input.url = f.url(query);
      return readDirectory164(input);
    },
    commit() {
      for (const hook of hooks) hook();
      hooks = [];
    },
    discard() {
      hooks = [];
    },
    change(id, change) {
      const old = records.get(id).summary;
      put({ ...old, ...change });
      sync();
    },
    projectionOnly(id) {
      const row = records.get(id);
      row.projection = encodeProjection(row.summary, '*', row.cipher, f.crypto);
      sync();
    },
    add(summary) {
      put(summary);
      sync();
    },
    remove(id) {
      records.delete(id);
      sync();
    },
    corruptFull(id) {
      const row = records.get(id);
      row.cipher = f.crypto.encode({ ...row.summary, name: 'Synthetic corrupt185' });
      sync();
    },
    corruptProjection(id) {
      const row = records.get(id);
      row.projection = f.crypto.encode({
        version: 1,
        id,
        audience: '*',
        sourceHash: '0'.repeat(64),
        row: compact(row.summary),
      });
      sync();
    },
    advance(ms) {
      now += ms;
    },
    afterSQL(fn) {
      afterSQL = fn;
    },
    boundRows(value) {
      boundRows = value;
    },
    nextStamp() {
      stamp++;
      revision++;
    },
    replaceEntry() {
      publish({
        key: f.key,
        stamp: 'replacement185',
        claim: f.claim,
        audience: '*',
        index: lastIndex,
      });
    },
    info() {
      return directorySnapshotIndexInfo180(lastIndex);
    },
    expected(query = 'limit=100') {
      const page = directoryPage(
        f.storage,
        current,
        f.url(query),
        {
          revision,
          directory: f.rows.map(compact),
        },
        f.timeZone,
      );
      page.directory = page.directory.map((row) => records.get(row.id).summary);
      return page;
    },
    close() {
      cache.clear();
      views.clear();
      budget.clear();
      f.close();
    },
  };
}
module.exports = { incremental185 };
