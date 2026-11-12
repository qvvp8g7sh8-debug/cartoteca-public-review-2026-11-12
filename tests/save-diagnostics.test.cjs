const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('../storage.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { routes } = require('../src/server/application/routes.cjs');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-save-diagnostics-'));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^cartoteca-save-diagnostics-/);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  return { dir, close: (fn) => closers.push(fn) };
}
function fixture(t) {
  const { dir, close } = temporary(t);
  const database = createPlatformDatabase(path.join(dir, 'platform'));
  close(() => database.db.close());
  const storage = createStorage(path.join(dir, 'tenant'));
  close(() => storage.close());
  const current = { role: 'owner', accountId: 'synthetic-owner', organizationId: 'synthetic-org' };
  const platform = {
    notificationChannels: { enabled: () => false },
    withWriteLock: database.transaction,
    session: () => current,
    subscription: () => ({ status: 'active', limits: { patients: 20000, photos: 20000 } }),
    organizationTimeZone: () => 'Europe/Moscow',
    workspaceIdentities: () => [],
    workSchedules: { assertChanges() {} },
    assertServiceGroups() {},
    assertServiceCatalog() {},
    assertWorkspace() {},
    appointmentConfirmations: { invalidateChanges() {} },
  };
  const stages = [],
    timings = [];
  const context = {
    current,
    platform,
    tenantStore: () => storage,
    token: 'synthetic-token',
    assertCurrent() {},
    recordStage: (name) => stages.push(name),
    recordTiming: (name, ms, failed = false) => timings.push({ name, ms, failed }),
  };
  return {
    dir,
    database,
    storage,
    platform,
    context,
    stages,
    timings,
    body: { revision: 0, patients: [], services: [] },
  };
}

test('SQLite platform contention records the failed wait and preserves the original busy error', async (t) => {
  const f = fixture(t);
  const blocker = new DatabaseSync(path.join(f.dir, 'platform', 'platform.sqlite'));
  // Short timeout on this synthetic connection only; production remains 5000 ms.
  f.database.db.exec('PRAGMA busy_timeout=30');
  blocker.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(saveMutation(f.context, f.body), (error) => {
      assert.equal(error.code, 'ERR_SQLITE_ERROR');
      assert.equal(error.errcode & 255, 5);
      assert.equal(error.status, undefined);
      return true;
    });
    assert.equal(f.stages.at(-1), 'save-platform-lock');
    const waits = f.timings.filter((row) => row.name === 'save-lock-wait');
    assert.equal(waits.length, 1);
    assert.equal(waits[0].failed, true);
    assert.ok(waits[0].ms >= 15);
    assert.equal(
      f.timings.some((row) => row.name === 'save-transaction'),
      false,
    );
    assert.equal(f.storage.get('revision', 0), 0);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});

test('SQLite cabinet contention is distinguished from platform wait without committing or retrying', async (t) => {
  const f = fixture(t),
    blocker = new DatabaseSync(path.join(f.dir, 'tenant', 'cabinet.sqlite'));
  f.storage.db.exec('PRAGMA busy_timeout=30');
  blocker.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(saveMutation(f.context, f.body), { code: 'ERR_SQLITE_ERROR' });
    assert.equal(f.stages.at(-1), 'save-cabinet-lock');
    assert.equal(f.timings.find((row) => row.name === 'save-lock-wait').failed, false);
    assert.equal(f.timings.find((row) => row.name === 'save-cabinet-lock-wait').failed, true);
    assert.equal(f.timings.filter((row) => row.name === 'save-transaction').length, 1);
    assert.equal(f.storage.get('revision', 0), 0);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});

test('save diagnostics retain stage order, successful lock timings and no await inside either lock', async (t) => {
  const f = fixture(t),
    expected = [
      'save-platform-lock',
      'save-cabinet-lock',
      'save-revalidation',
      'save-write',
      'save-receipt',
      'save-cabinet-commit',
      'save-trusted-commit',
      'save-platform-commit',
      'save-response',
    ];
  const result = await saveMutation(f.context, f.body);
  assert.equal(result.revision, 1);
  assert.deepEqual(f.stages.slice(-expected.length), expected);
  for (const name of ['save-lock-wait', 'save-cabinet-lock-wait', 'save-transaction']) {
    const rows = f.timings.filter((row) => row.name === name);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].failed, false);
    assert.ok(rows[0].ms >= 0);
  }
  assert.equal(f.database.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(f.storage.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(f.database.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});

for (const target of ['cabinet', 'platform'])
  test(`failed ${target} commit keeps its stage and the actual durable receipt outcome without retry`, async (t) => {
    const f = fixture(t);
    const id = 'synthetic-failed-commit-0001';
    f.context.req = { headers: { 'x-cartoteca-operation': id } };
    const db = target === 'cabinet' ? f.storage.db : f.database.db;
    const exec = db.exec.bind(db);
    let armed = false,
      failures = 0,
      writes = 0;
    const stage = f.context.recordStage,
      write = f.storage.write;
    f.context.recordStage = (name) => {
      stage(name);
      if (name === `save-${target}-commit`) armed = true;
    };
    f.storage.write = (...args) => {
      writes++;
      return write(...args);
    };
    t.mock.method(db, 'exec', (sql) => {
      if (sql === 'COMMIT' && armed) {
        armed = false;
        failures++;
        throw Object.assign(Error('Synthetic commit failure, no retry'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 10,
        });
      }
      return exec(sql);
    });
    await assert.rejects(saveMutation(f.context, f.body), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 10,
    });
    assert.equal(f.stages.at(-1), `save-${target}-commit`);
    assert.equal(writes, 1);
    assert.equal(failures, 1);
    const { readReceipt } = require('../src/server/infrastructure/mutation-receipts.cjs');
    const receipt = readReceipt(f.storage, f.context.current, id);
    if (target === 'cabinet') {
      assert.equal(f.storage.get('revision', 0), 0);
      assert.equal(receipt, null);
      assert.deepEqual(f.storage.get('mutation-operation-index', []), []);
      assert.equal(f.timings.find((row) => row.name === 'save-transaction').failed, true);
    } else {
      assert.equal(f.storage.get('revision'), 1);
      assert.equal(receipt.saved.revision, 1);
      assert.equal(f.timings.find((row) => row.name === 'save-transaction').failed, false);
    }
    assert.equal(f.storage.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  });

test('HTTP boundary reports sanitized SQL stage/code while preserving the generic 500 response', async (t) => {
  const { dir, close } = temporary(t);
  const route = {
    method: 'GET',
    path: '/api/synthetic-diagnostics',
    access: 'public',
    async handle(context) {
      context.recordStage('save-platform-lock');
      throw Object.assign(Error('Synthetic private SQL and patient name'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 5,
      });
    },
  };
  routes.push(route);
  close(() => routes.splice(routes.indexOf(route), 1));
  const server = createMultiServer({
    dataDir: dir,
    origin: '',
    production: false,
    processRole: 'web',
    sendMail: null,
    telegramBot: null,
    supportDelivery: {},
    metricsEnabled: true,
    metricsIntervalMs: 0,
  });
  close(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const reply = await fetch('http://127.0.0.1:' + server.address().port + route.path);
  assert.equal(reply.status, 500);
  assert.deepEqual(await reply.json(), { error: 'Не удалось выполнить операцию.' });
  const report = server.requestMetrics.snapshot();
  assert.deepEqual(report.failures, [
    {
      route: 'GET ' + route.path,
      stage: 'save-platform-lock',
      status: 500,
      code: 'ERR_SQLITE_ERROR',
      sqliteCode: 5,
      count: 1,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /private|patient name|SQL and|synthetic-token|stack/);
});
