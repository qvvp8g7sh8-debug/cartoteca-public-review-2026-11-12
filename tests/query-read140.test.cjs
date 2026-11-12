const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPatientRecords } = require('../src/server/infrastructure/cabinet-records.cjs');
const {
  createQueryDiagnostics,
} = require('../src/server/infrastructure/native-query-diagnostics140.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');

test('canonical appointment batches preserve caller order and duplicate independence across fixed 200-row chunks', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE patients(id TEXT PRIMARY KEY,value BLOB); CREATE TABLE cabinet_patient_records(kind TEXT,id TEXT,patient_id TEXT,position INTEGER,value BLOB);',
    );
    let selects = 0,
      decoded = 0;
    const records = createPatientRecords({
      db,
      schemaVersion: 2,
      encode: (x) => Buffer.from(JSON.stringify(x)),
      decode: (x) => {
        decoded++;
        return JSON.parse(Buffer.from(x).toString());
      },
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith('SELECT p.id patient_id')) return statement;
        return {
          all(...args) {
            selects++;
            return statement.all(...args);
          },
        };
      },
    });
    const ids = [];
    for (let n = 0; n < 402; n++) {
      const id = 'p' + n;
      ids.push(id);
      db.prepare('INSERT INTO patients VALUES(?,?)').run(
        id,
        Buffer.from('unreadable synthetic profile'),
      );
      db.prepare('INSERT INTO cabinet_patient_records VALUES(?,?,?,?,?)').run(
        'visit',
        'v' + n,
        id,
        0,
        Buffer.from('unreadable synthetic visit'),
      );
      if (n % 2)
        db.prepare('INSERT INTO cabinet_patient_records VALUES(?,?,?,?,?)').run(
          'appointment',
          'a' + n,
          id,
          0,
          Buffer.from(
            JSON.stringify({
              id: 'a' + n,
              time: '10:00',
              status: 'cancelled',
              staffId: 'owner',
              custom: { value: 1 },
            }),
          ),
        );
    }
    const requested = [...ids.reverse(), 'absent', 'p1'];
    const selected = records.selectedAppointments(requested);
    assert.deepEqual(
      selected.map((p) => p.id),
      requested.filter((id) => id !== 'absent'),
    );
    assert.equal(selects, 3);
    assert.equal(decoded, 201);
    assert.deepEqual(
      selected.find((p) => p.id === 'p0'),
      { id: 'p0', appointments: [] },
    );
    const duplicates = selected.filter((p) => p.id === 'p1');
    duplicates[0].appointments[0].custom.value = 2;
    assert.equal(duplicates[1].appointments[0].custom.value, 1);
    assert.equal(duplicates[1].appointments[0].status, 'cancelled');
    assert.deepEqual(records.selectedAppointments([]), []);
    assert.equal(selects, 3);
  } finally {
    db.close();
  }
});

test('legacy cabinet keeps the same canonical appointment projection without schema changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-query140-legacy-'));
  let storage;
  try {
    storage = createStorage(root);
    storage.write({
      revision: 0,
      services: [],
      patients: [
        {
          id: 'one',
          name: 'Synthetic',
          visits: [],
          appointments: [
            {
              id: 'a',
              date: '2035-01-01',
              time: '10:00',
              duration: 30,
              service: 'Synthetic',
              status: 'cancelled',
            },
          ],
        },
      ],
    });
    assert.deepEqual(
      storage.readSelectedAppointments(['one', 'absent', 'one']),
      storage
        .readSelected(['one', 'absent', 'one'])
        .patients.map(({ id, appointments }) => ({ id, appointments })),
    );
    assert.deepEqual(storage.readSelectedAppointments([]), []);
    assert.equal(storage.db.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    storage?.close();
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith('cartoteca-query140-legacy-')
    )
      throw Error('Unexpected synthetic assets.');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('query diagnostics retain ten fixed technical dimensions and snapshots cannot mutate counters', () => {
  let calls = 10;
  const metrics = createQueryDiagnostics(
    { stats: () => ({ calls }) },
    {
      stats: () => ({
        hits: 2,
        misses: 1,
        opens: 1,
        openErrors: 0,
        evictions: 0,
        closes: 0,
        closeErrors: 0,
        openMs: 0.5,
        closeMs: 0,
        connections: 1,
        omittedPrivateField: 'PRIVATE',
      }),
    },
  );
  const observation = metrics.begin();
  observation.route('/api/cabinet/patient');
  observation.phase('authMs', () => {
    calls++;
  });
  observation.projectionStart();
  observation.phase('serializeMs', () => {});
  observation.projection(5);
  calls += 3;
  observation.finish(503);
  observation.finish(200);
  const snapshot = metrics.stats();
  assert.equal(Object.keys(snapshot.routes).length, 10);
  assert.equal(Object.keys(snapshot.pool).length, 10);
  assert.equal(snapshot.routes.patient.count, 1);
  assert.equal(snapshot.routes.patient.errors, 1);
  assert.equal(snapshot.routes.patient.rpcCalls, 4);
  assert.ok(snapshot.routes.patient.totalMs >= 0);
  snapshot.routes.patient.count = 99;
  assert.equal(metrics.stats().routes.patient.count, 1);
  for (const pathname of ['__proto__', '/api/cabinet/patient?id=PRIVATE']) {
    const rejected = metrics.begin();
    rejected.route(pathname);
    rejected.finish(400);
  }
  assert.equal(metrics.stats().routes.patient.count, 1);
  assert.equal(JSON.stringify(metrics.stats()).includes('PRIVATE'), false);
});

const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
function memoFixture() {
  const calls = [],
    state = {
      ready: true,
      poisoned: false,
      closed: false,
      exited: false,
      error: null,
      snapshot: '1:10:',
    };
  const transport = {
    ready: async () => {},
    stats: () => ({
      ready: state.ready,
      poisoned: state.poisoned,
      closed: state.closed,
      exited: state.exited,
    }),
    close: async () => {
      state.ready = false;
    },
    closeSync() {
      state.ready = false;
    },
    request(command) {
      calls.push(command);
      if (state.error) throw state.error;
      if (!state.ready || state.poisoned || state.closed || state.exited)
        throw Object.assign(Error('Synthetic closed channel'), {
          code: 'POSTGRES_WORKER_FAILED',
          transactionOpen: false,
        });
      if (command.op === 'snapshotVersion') return state.snapshot;
      if (command.op === 'execute') return { rows: [], fields: [], rowCount: 0 };
      return null;
    },
  };
  const owner = createPostgresCoordinator({
    allowBlocking: true,
    transport,
    revisionProfile: 3,
    catalog: { version: 2, tables: {} },
    compile: (sql) => ({ text: sql, values: [], effect: 'read' }),
  });
  const p = owner.open({ kind: 'platform', storeId: 'synthetic-platform' });
  const c = owner.open({
    kind: 'cabinet',
    storeId: 'synthetic-cabinet',
    organizationId: 'synthetic-organization',
  });
  return {
    owner,
    p,
    c,
    calls,
    state,
    snapshots: () => calls.filter((c) => c.op === 'snapshotVersion').length,
  };
}

test('READONLY memo crosses only scopes in its physical root; released nested reads keep the token', () => {
  const f = memoFixture();
  f.p.exec('BEGIN READONLY');
  assert.equal(f.p.snapshotVersion(), '1:10:');
  f.c.exec('BEGIN READONLY');
  assert.equal(f.c.snapshotVersion(), '1:10:');
  f.c.exec('COMMIT');
  assert.equal(f.p.snapshotVersion(), '1:10:');
  assert.equal(f.snapshots(), 1);
  f.p.exec('COMMIT');
  f.state.snapshot = '1:11:';
  assert.equal(f.p.snapshotVersion(), '1:11:');
  assert.equal(f.snapshots(), 2);
  f.owner.closeSync();
});
test('memo is absent outside READONLY, including DEFERRED, IMMEDIATE and nested READONLY under a writer', () => {
  for (const mode of [null, 'DEFERRED', 'IMMEDIATE']) {
    const f = memoFixture();
    if (mode) f.p.exec('BEGIN ' + mode);
    f.p.snapshotVersion();
    f.p.snapshotVersion();
    assert.equal(f.snapshots(), 2);
    if (mode === 'IMMEDIATE') {
      f.c.exec('BEGIN READONLY');
      f.c.snapshotVersion();
      f.c.snapshotVersion();
      f.c.exec('COMMIT');
      assert.equal(f.snapshots(), 4);
    }
    if (mode) f.p.exec('ROLLBACK');
    f.owner.closeSync();
  }
});
test('nested rollback invalidates the memo and scope clocks, while root rollback cannot leak to a new root', () => {
  const f = memoFixture();
  f.p.exec('BEGIN READONLY');
  f.p.snapshotVersion();
  f.c.exec('BEGIN READONLY');
  const prior = f.c.localMutationClock;
  f.c.exec('ROLLBACK');
  assert.ok(f.c.localMutationClock > prior);
  f.p.snapshotVersion();
  assert.equal(f.snapshots(), 2);
  f.p.exec('ROLLBACK');
  f.state.snapshot = '1:12:';
  f.p.exec('BEGIN READONLY');
  assert.equal(f.p.snapshotVersion(), '1:12:');
  assert.equal(f.snapshots(), 3);
  f.p.exec('ROLLBACK');
  f.owner.closeSync();
});
test('native SQL, cursor and savepoint errors cannot be hidden by a memoized token', () => {
  for (const phase of ['execute', 'cursorOpen', 'savepoint', 'release']) {
    const f = memoFixture();
    f.p.exec('BEGIN READONLY');
    f.p.snapshotVersion();
    if (phase === 'release') f.c.exec('BEGIN READONLY');
    f.state.error = Object.assign(Error('Synthetic SQL cancellation'), {
      code: '57014',
      transactionOpen: true,
    });
    const operation =
      phase === 'execute'
        ? () => f.p.prepare('SELECT 1 AS value').get()
        : phase === 'cursorOpen'
          ? () => f.p.prepare('SELECT 1 AS value').iterate().next()
          : phase === 'savepoint'
            ? () => f.c.exec('BEGIN READONLY')
            : () => f.c.exec('COMMIT');
    assert.throws(operation, { code: '57014' });
    assert.throws(() => f.p.snapshotVersion(), { code: '57014' }, phase);
    f.state.error = null;
    f.owner.closeSync();
  }
});
test('not-ready, poisoned, closed or exited native channel cannot serve a cached READONLY token', () => {
  for (const flag of ['ready', 'poisoned', 'closed', 'exited']) {
    const f = memoFixture();
    f.p.exec('BEGIN READONLY');
    f.p.snapshotVersion();
    f.state[flag] = flag !== 'ready';
    assert.throws(() => f.p.snapshotVersion(), { code: 'POSTGRES_WORKER_FAILED' }, flag);
    f.owner.closeSync();
  }
});
test('transactionOpen false clears every frame and a repaired channel starts a fresh physical root', () => {
  const f = memoFixture();
  f.p.exec('BEGIN READONLY');
  f.p.snapshotVersion();
  f.state.error = Object.assign(Error('Synthetic lost transaction'), {
    code: 'POSTGRES_BUSY',
    transactionOpen: false,
  });
  assert.throws(() => f.p.prepare('SELECT 1 AS value').get());
  assert.equal(f.p.isTransaction, false);
  f.state.error = null;
  f.state.snapshot = '1:14:';
  f.p.exec('BEGIN READONLY');
  assert.equal(f.p.snapshotVersion(), '1:14:');
  f.p.exec('COMMIT');
  f.owner.closeSync();
});
test('closed logical handles and closed coordinator reject a token before any cache hit', () => {
  const f = memoFixture();
  f.p.exec('BEGIN READONLY');
  f.p.snapshotVersion();
  f.c.close();
  assert.throws(() => f.c.snapshotVersion(), { code: 'POSTGRES_CLOSED' });
  f.owner.closeSync();
  assert.throws(() => f.p.snapshotVersion(), { code: 'POSTGRES_CLOSED' });
});
