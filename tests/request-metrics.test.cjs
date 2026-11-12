const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestMetrics } = require('../src/server/infrastructure/request-metrics.cjs');
const { EventEmitter } = require('node:events');
const { trySharedMutation } = require('../src/server/modules/cabinet/shared-mutation.cjs');
function response() {
  return Object.assign(new EventEmitter(), {
    setHeader() {},
    statusCode: 500,
    writableFinished: true,
  });
}

test('shared admission failure records its wait once and later tenant failure is not misclassified', async () => {
  for (const acquired of [false, true]) {
    const metrics = createRequestMetrics({ enabled: true, intervalMs: 0 });
    const error = Object.assign(Error('Synthetic private rejection'), { status: 503 });
    try {
      const sample = metrics.track({}, response());
      const context = {
        platform: {
          organizationTimeZone: () => 'UTC',
          withSharedCabinetCommit: async callback => {
            if (!acquired) throw error;
            return callback();
          },
        },
        current: { organizationId: 'synthetic' },
        recordTiming: sample.phase,
        recordStage: sample.stage,
      };
      const state = { patients: [] };
      await assert.rejects(trySharedMutation(context, {
        initial: state, next: state, receiptBody: {},
        storage: { transaction() { throw error; } },
      }), value => value === error);
      const phases = metrics.snapshot().phases;
      assert.equal(phases.length, 1);
      assert.equal(phases[0].route, 'save-shared-lock-wait');
      assert.equal(phases[0].count, 1);
      assert.equal(phases[0].errors, Number(!acquired));
      assert.ok(phases[0].totalMs >= 0);
      assert.doesNotMatch(JSON.stringify(phases), /Synthetic|private|synthetic/);
    } finally { metrics.close(); }
  }
});

test('shared coordination has static aggregate phase and failure labels', () => {
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0 });
  try {
    for (const stage of [
      'save-shared-lock',
      'save-shared-revalidation',
      'save-shared-write',
      'save-shared-commit',
    ]) {
      const res = response(),
        sample = metrics.track({}, res);
      sample.stage(stage);
      sample.failure(Object.assign(Error('private synthetic payload'), { code: 'EIO' }), 500);
      res.emit('finish');
    }
    for (const phase of ['save-shared-lock-wait', 'save-shared-cabinet-commit'])
      metrics.track({}, response()).phase(phase, 3);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.failures.length, 4);
    assert.ok(snapshot.failures.every((row) => row.stage.startsWith('save-shared-')));
    assert.deepEqual(
      snapshot.phases.map((row) => row.route),
      ['save-shared-lock-wait', 'save-shared-cabinet-commit'],
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /private synthetic payload/);
  } finally {
    metrics.close();
  }
});

test('aggregate resource snapshots stay fresh and a failed resource probe cannot break metrics', () => {
  let opens = 1,
    unavailable = false;
  const metrics = createRequestMetrics({
    resourceStats() {
      if (unavailable) throw Error('Synthetic unavailable counter');
      return { tenantPool: { opens }, readCache: { bytes: 24 }, background: { active: false } };
    },
  });
  try {
    assert.equal(metrics.snapshot().resources.tenantPool.opens, 1);
    opens++;
    assert.equal(metrics.snapshot({ reset: true }).resources.tenantPool.opens, 2);
    assert.equal(metrics.snapshot().resources.tenantPool.opens, 2);
    unavailable = true;
    assert.equal(metrics.snapshot().resources, undefined);
    unavailable = false;
    assert.equal(metrics.snapshot().resources.readCache.bytes, 24);
  } finally {
    metrics.close();
  }
});

test('request metrics count finish once, aggregate bounded labels and never retain private request data', async (t) => {
  const metrics = createRequestMetrics({
    enabled: true,
    emit() {
      throw Error('sink unavailable');
    },
  });
  const server = http.createServer((req, res) => {
    const measurement = metrics.track(req, res);
    measurement.route('GET /api/cabinet/patient');
    measurement.phase('save-lock-wait', 7);
    measurement.phase('secret-value', 100);
    res.writeHead(req.url.includes('fail') ? 503 : 200);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    metrics.close();
    await new Promise((r) => server.close(r));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/private-patient-name?email=secret@example.test', {
    headers: { Cookie: 'secret-cookie', 'X-Request-Id': 'unsafe-id' },
  });
  await r.text();
  assert.match(r.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  await (await fetch(base + '/fail')).text();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.active, 0);
  assert.equal(snapshot.routes[0].count, 2);
  assert.equal(snapshot.routes[0].errors, 1);
  assert.equal(snapshot.routes[0].aborted, 0);
  assert.equal(snapshot.phases.length, 1);
  assert.equal(snapshot.phases[0].route, 'save-lock-wait');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private-patient|unsafe-id|cookie/i);
  metrics.snapshot({ reset: true });
  assert.equal(metrics.snapshot().routes.length, 0);
});

test('failure diagnostics retain bounded stage/code/status only, count once and reset', () => {
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0 });
  try {
    const res = response(),
      sample = metrics.track({}, res);
    sample.route('PATCH /api/cabinet/changes');
    sample.stage('save-platform-lock');
    const error = Object.assign(Error('Synthetic private name SELECT secret SQL'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 517,
      token: 'do-not-retain',
      patientId: 'private-id',
    });
    sample.failure(error, 500);
    sample.failure(error, 500);
    sample.phase('save-lock-wait', 5010, true);
    res.emit('finish');
    let snapshot = metrics.snapshot();
    assert.deepEqual(snapshot.failures, [
      {
        route: 'PATCH /api/cabinet/changes',
        stage: 'save-platform-lock',
        status: 500,
        code: 'ERR_SQLITE_ERROR',
        sqliteCode: 517,
        count: 1,
      },
    ]);
    assert.equal(snapshot.phases[0].errors, 1);
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /secret|private|SELECT|do-not-retain|patientId|token|stack/,
    );
    const other = response(),
      unknown = metrics.track({}, other);
    unknown.stage('private stage');
    unknown.failure({ code: 'private code', name: 'private name' }, 123456);
    other.emit('finish');
    snapshot = metrics.snapshot({ reset: true });
    assert.equal(snapshot.failures[1].stage, 'unclassified');
    assert.equal(snapshot.failures[1].code, 'OTHER');
    assert.equal(snapshot.failures[1].status, 500);
    assert.equal(metrics.snapshot().failures.length, 0);
    assert.equal(metrics.snapshot().failureOverflow, 0);
  } finally {
    metrics.close();
  }
});

test('failure diagnostics limit cardinality and tolerate unusual error getters', () => {
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0 });
  try {
    for (let i = 0; i < 150; i++) {
      const res = response(),
        sample = metrics.track({}, res);
      sample.failure(new TypeError('private'), 400 + i);
      res.emit('finish');
    }
    assert.equal(metrics.snapshot().failures.length, 128);
    assert.equal(metrics.snapshot().failureOverflow, 22);
    const res = response(),
      sample = metrics.track({}, res);
    assert.doesNotThrow(() =>
      sample.failure(
        {
          get code() {
            throw Error('private');
          },
        },
        500,
      ),
    );
    res.emit('finish');
  } finally {
    metrics.close();
  }
});

test('sanitizer reads stateful error getters once and never exports a second untrusted value', () => {
  const { safeFailure } = require('../src/server/infrastructure/request-diagnostics.cjs');
  const reads = {},
    error = {};
  for (const [field, allowed] of Object.entries({
    code: 'ERR_SQLITE_ERROR',
    name: 'TypeError',
    status: 500,
    errcode: 5,
  }))
    Object.defineProperty(error, field, {
      get() {
        reads[field] = (reads[field] || 0) + 1;
        return reads[field] === 1 ? allowed : 'private-secret';
      },
    });
  assert.deepEqual(safeFailure(error, 500), {
    status: 500,
    code: 'ERR_SQLITE_ERROR',
    sqliteCode: 5,
  });
  assert.deepEqual(reads, { code: 1, name: 1, status: 1, errcode: 1 });
});

test('phase total time stays finite, ignores invalid timings and resets with its window', () => {
  const metrics = createRequestMetrics({ enabled: true, intervalMs: 0 });
  try {
    const res = response(),
      sample = metrics.track({}, res);
    sample.phase('save-lock-wait', 7);
    sample.phase('save-lock-wait', 13);
    for (const invalid of [NaN, Infinity, -Infinity, -1]) sample.phase('save-lock-wait', invalid);
    let phase = metrics.snapshot().phases[0];
    assert.equal(phase.count, 2);
    assert.equal(phase.totalMs, 20);
    assert.equal(phase.maxMs, 13);
    sample.phase('save-transaction', Number.MAX_VALUE);
    sample.phase('save-transaction', Number.MAX_VALUE);
    phase = metrics.snapshot().phases.find((row) => row.route === 'save-transaction');
    assert.ok(Number.isFinite(phase.totalMs));
    assert.equal(phase.totalMs, Number.MAX_SAFE_INTEGER);
    res.emit('finish');
    metrics.snapshot({ reset: true });
    assert.equal(metrics.snapshot().phases.length, 0);
  } finally {
    metrics.close();
  }
});

test('zero emission interval preserves an explicit window while default still emits and resets', (t) => {
  const scheduled = [],
    emitted = [];
  t.mock.method(global, 'setInterval', (callback, interval) => {
    scheduled.push({ callback, interval });
    return { unref() {} };
  });
  t.mock.method(global, 'clearInterval', () => {});
  const manual = createRequestMetrics({
    enabled: true,
    intervalMs: 0,
    emit: (value) => emitted.push(value),
  });
  try {
    assert.equal(scheduled.length, 0);
    for (let i = 0; i < 2; i++) {
      const res = response();
      manual.track({}, res).phase('save-lock-wait', 5);
      res.emit('finish');
      assert.equal(manual.snapshot().routes[0].count, i + 1);
    }
    assert.equal(emitted.length, 0);
    assert.equal(manual.snapshot({ reset: true }).routes[0].count, 2);
    assert.equal(manual.snapshot().routes.length, 0);
  } finally {
    manual.close();
  }
  const automatic = createRequestMetrics({ enabled: true, emit: (value) => emitted.push(value) });
  try {
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].interval, 60000);
    const res = response();
    automatic.track({}, res);
    res.emit('finish');
    scheduled[0].callback();
    assert.equal(JSON.parse(emitted[0]).routes[0].count, 1);
    assert.equal(automatic.snapshot().routes.length, 0);
  } finally {
    automatic.close();
  }
});
