// Fresh uniqueness, canonical write-diff and notification snapshot regressions.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.resolve(__dirname, '..');
const { createCabinetIndexes } = require(
  path.join(ROOT, 'src/server/infrastructure/cabinet-indexes.cjs'),
);
const { createPatientRecords, patientProfile } = require(
  path.join(ROOT, 'src/server/infrastructure/cabinet-records.cjs'),
);
const encode = (value) => Buffer.from(JSON.stringify(value));
const decode = (value) => JSON.parse(Buffer.from(value).toString('utf8'));
function indices(db, calls) {
  return createCabinetIndexes({
    db,
    schemaVersion: 2,
    encode,
    decode,
    hash: (v) => v,
    prepare(sql) {
      const q = db.prepare(sql);
      return {
        get(...args) {
          calls.push({ sql, method: 'get', args });
          return q.get(...args);
        },
        all(...args) {
          calls.push({ sql, method: 'all', args });
          return q.all(...args);
        },
        run(...args) {
          return q.run(...args);
        },
      };
    },
  });
}
test('uniqueness guards retain own/foreign/move/cross-kind semantics with bounded indexed chunks', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE cabinet_record_ids(kind TEXT NOT NULL,id TEXT NOT NULL,patient_id TEXT NOT NULL,PRIMARY KEY(kind,id))',
  );
  const put = db.prepare('INSERT INTO cabinet_record_ids VALUES(?,?,?)');
  const own = { visits: [], appointments: [] };
  for (let n = 0; n < 401; n++) {
    const kind = n % 2 ? 'visit' : 'appointment';
    own[kind === 'visit' ? 'visits' : 'appointments'].push({ id: 'r' + n });
    put.run(kind, 'r' + n, 'one');
  }
  put.run('visit', 'same-id', 'one');
  put.run('appointment', 'same-id', 'two');
  const calls = [],
    index = indices(db, calls);
  index.assertUnique([own], ['one']);
  assert.equal(calls.length, 3, '401 indexed pairs must require exactly ceil(401/200) reads');
  assert.ok(calls.every((c) => c.method === 'all' && JSON.parse(c.args[0]).length <= 200));
  calls.length = 0;
  index.assertUnique([], ['one']);
  assert.equal(calls.length, 0);
  assert.doesNotThrow(() =>
    index.assertUnique([{ visits: [{ id: 'same-id' }], appointments: [] }], ['one']),
  );
  assert.throws(
    () => index.assertUnique([{ visits: [], appointments: [{ id: 'same-id' }] }], ['one']),
    { status: 400 },
  );
  assert.doesNotThrow(() =>
    index.assertUnique([{ visits: [], appointments: [{ id: 'same-id' }] }], ['one', 'two']),
  );
  assert.doesNotThrow(() =>
    index.assertUnique([{ visits: [{ id: 'not-present' }], appointments: [] }], ['one']),
  );
  // A later guard must see a new foreign ownership row, not reuse an earlier pass.
  const candidate = [{ visits: [{ id: 'later-foreign' }], appointments: [] }];
  index.assertUnique(candidate, ['one']);
  put.run('visit', 'later-foreign', 'two');
  assert.throws(() => index.assertUnique(candidate, ['one']), { status: 400 });
  const unusual = ['Иванов-😀-"-\\', 'legacy-\u0000-id'];
  for (const id of unusual) {
    put.run('visit', id, 'two');
    assert.throws(() => index.assertUnique([{ visits: [{ id }], appointments: [] }], ['one']), {
      status: 400,
    });
  }
  put.run('visit', 'legacy-\ufffd', 'two');
  assert.throws(
    () => index.assertUnique([{ visits: [{ id: 'legacy-\ud800' }], appointments: [] }], ['one']),
    { status: 400 },
    'old UTF8 parameter binding semantics must remain available for a legacy ill-formed ID',
  );
  db.exec('BEGIN');
  db.prepare('UPDATE cabinet_record_ids SET patient_id=? WHERE kind=? AND id=?').run(
    'one',
    'visit',
    'later-foreign',
  );
  index.assertUnique(candidate, ['one']);
  db.exec('ROLLBACK');
  assert.throws(() => index.assertUnique(candidate, ['one']), { status: 400 });
});
function recordsFixture(t, count = 205) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE patients(id TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE cabinet_patient_records(kind TEXT NOT NULL,id TEXT NOT NULL,patient_id TEXT NOT NULL REFERENCES patients(id),position INTEGER NOT NULL,value BLOB NOT NULL,PRIMARY KEY(kind,id),UNIQUE(patient_id,kind,position));`);
  const patients = Array.from({ length: count }, (_, n) => ({
    id: 'p' + n,
    name: 'Synthetic ' + n,
    visits: [{ id: 'v' + n, date: '2020-01-01', notes: 'History stays unchanged' }],
    appointments: [{ id: 'a' + n, date: '2035-01-01', time: '10:00' }],
  }));
  const p = db.prepare('INSERT INTO patients VALUES(?,?)'),
    r = db.prepare('INSERT INTO cabinet_patient_records VALUES(?,?,?,?,?)');
  for (const value of patients) {
    p.run(value.id, encode(patientProfile(value)));
    r.run('visit', value.visits[0].id, value.id, 0, encode(value.visits[0]));
    r.run('appointment', value.appointments[0].id, value.id, 0, encode(value.appointments[0]));
  }
  const calls = [];
  let decoded = 0;
  const records = createPatientRecords({
    db,
    schemaVersion: 2,
    encode,
    decode(value) {
      decoded++;
      return decode(value);
    },
    prepare(sql) {
      const q = db.prepare(sql);
      return {
        get(...args) {
          calls.push({ sql, method: 'get' });
          return q.get(...args);
        },
        all(...args) {
          calls.push({ sql, method: 'all' });
          return q.all(...args);
        },
        run(...args) {
          return q.run(...args);
        },
      };
    },
  });
  calls.length = 0;
  return { db, records, patients, calls, decoded: () => decoded };
}
test('record write diff reads each canonical row once, batches >200 profiles and preserves untouched bytes', (t) => {
  const f = recordsFixture(t),
    before = f.db.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all();
  const next = structuredClone(f.patients);
  next[0].appointments[0].time = '11:00';
  const ids = f.patients.map((p) => p.id);
  // Duplicate selection across the 200 boundary remains equivalent and missing rows stay missing.
  ids.push('p0', 'absent', 'p0');
  f.db.exec('BEGIN');
  const result = f.records.sync(next, ids);
  assert.equal(f.calls.length, 4, 'two profile chunks plus two canonical-record chunks');
  assert.equal(f.calls.filter((c) => c.sql.includes('FROM cabinet_patient_records')).length, 2);
  assert.equal(result.previousPatients.size, 1);
  assert.deepEqual([...result.indexedIds].sort(), ['absent', 'p0']);
  assert.deepEqual(result.previousPatients.get('p0'), f.patients[0]);
  assert.equal(
    f.decoded(),
    ids.filter((id) => id !== 'absent').length + f.patients.length * 2,
    'duplicate profiles preserve caller semantics; canonical records are decoded once',
  );
  f.db.exec('COMMIT');
  const after = f.db.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all();
  assert.deepEqual(
    after.filter((r) => r.id !== 'a0'),
    before.filter((r) => r.id !== 'a0'),
  );
  assert.equal(decode(after.find((r) => r.id === 'a0').value).time, '11:00');
});
test('record move/swap/delete and rollback retain uniqueness, positions and selected patient boundary', (t) => {
  const f = recordsFixture(t, 2),
    next = structuredClone(f.patients);
  [next[0].appointments, next[1].appointments] = [next[1].appointments, next[0].appointments];
  f.db.exec('BEGIN');
  f.records.sync(next, ['p0', 'p1']);
  f.db.exec('COMMIT');
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT id,patient_id FROM cabinet_patient_records WHERE kind='appointment' ORDER BY id",
      )
      .all()
      .map((r) => ({ ...r })),
    [
      { id: 'a0', patient_id: 'p1' },
      { id: 'a1', patient_id: 'p0' },
    ],
  );
  const snapshot = f.db.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all();
  f.db.exec('BEGIN');
  f.records.sync([next[0]], ['p0', 'p1']);
  f.db.exec('ROLLBACK');
  assert.deepEqual(
    f.db.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all(),
    snapshot,
  );
  f.db.exec('BEGIN');
  assert.throws(() => f.records.sync(next, ['p0']), /outside write selection/);
  f.db.exec('ROLLBACK');
  assert.deepEqual(
    f.db.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all(),
    snapshot,
  );
});

test('legacy profile IDs keep ordered point lookup before the existing canonical JSON gate', (t) => {
  const f = recordsFixture(t, 1),
    malformed = 'legacy-\ud800',
    nul = 'legacy-\u0000-id';
  for (const id of ['legacy-\ufffd', nul])
    f.db
      .prepare('INSERT INTO patients VALUES(?,?)')
      .run(id, encode({ id, name: 'Synthetic legacy' }));
  const ids = ['p0', malformed, 'p0', nul, 'p0'];
  const expected = ids.flatMap((id) => {
    const row = f.db.prepare('SELECT id,value FROM patients WHERE id=?').get(id);
    return row ? [row.id] : [];
  });
  const rows = [],
    methods = [],
    stop = Error('Synthetic stop after profile lookup');
  const records = createPatientRecords({
    db: f.db,
    schemaVersion: 2,
    encode,
    decode,
    prepare(sql) {
      const q = f.db.prepare(sql);
      return {
        get(...args) {
          const row = q.get(...args);
          methods.push('get');
          if (row) rows.push(row.id);
          return row;
        },
        all(...args) {
          if (sql.includes('WHERE patient_id IN (SELECT value FROM json_each(?))')) throw stop;
          const result = q.all(...args);
          if (sql.includes('patients AS selected')) {
            methods.push('all');
            rows.push(...result.map((row) => row.id));
          }
          return result;
        },
        run(...args) {
          return q.run(...args);
        },
      };
    },
  });
  f.db.exec('BEGIN');
  assert.throws(
    () => records.sync([], ids),
    (error) => error === stop,
  );
  f.db.exec('ROLLBACK');
  assert.deepEqual(rows, expected);
  assert.deepEqual(methods, ['all', 'get', 'all', 'get', 'all']);
});

const { createAppointmentStateReader } = require(
  path.join(ROOT, 'src/server/modules/notifications/appointment-state-reader.cjs'),
);
function readerFixture(snapshot, fallback) {
  const calls = [];
  const platform = {
    withNotificationReadSnapshot:
      snapshot &&
      function (cb) {
        assert.equal(this, platform);
        calls.push('notification');
        return snapshot(cb);
      },
    withReadSnapshot:
      fallback &&
      function (cb) {
        assert.equal(this, platform);
        calls.push('generic');
        return fallback(cb);
      },
    appointmentConfirmations: { readMany: () => new Map() },
  };
  const store = { settings: () => ({ timeZone: 'Europe/Moscow' }), confirmedMany: () => new Map() };
  let response;
  const read = createAppointmentStateReader({
    platform,
    store,
    tenantStore: () => null,
    coordinator: {
      describeMany(org, patients, options) {
        response = options.responseRead;
        return new Map();
      },
    },
  });
  return { calls, read, response: () => response };
}
test('notification reader chooses the explicit read-only port without manufacturing canonical snapshot proof', () => {
  let active = false;
  const f = readerFixture(
    (cb) => {
      active = true;
      try {
        return cb();
      } finally {
        active = false;
      }
    },
    () => {
      throw Error('Generic transaction must remain unused');
    },
  );
  const patients = [];
  assert.deepEqual(f.read({ patients }, 'org'), { patients });
  assert.deepEqual(f.calls, ['notification']);
  assert.equal(active, false);
  assert.equal(f.response().readSnapshot, null);
  assert.equal(f.response().sourcePatients, patients);
  const forged = { any: 'untrusted caller value' };
  f.read({ patients }, 'org', { readSnapshot: forged });
  assert.equal(
    f.response().readSnapshot,
    forged,
    'reader does not upgrade arbitrary input into a platform proof',
  );
});
test('profile1 and native query facades without the optional port preserve their owning generic transaction', () => {
  for (const profile of ['legacy-profile1', 'native-owning-RR']) {
    const f = readerFixture(null, (cb) => cb());
    assert.deepEqual(f.read({ patients: [] }, 'org'), { patients: [] }, profile);
    assert.deepEqual(f.calls, ['generic'], profile);
  }
  const f = readerFixture(null, null);
  assert.deepEqual(f.read({ patients: [] }, 'org'), { patients: [] });
  assert.equal(f.response(), null);
});
test('actual SQLite platform exposes no specialized port and its generic snapshot remains compatible', (t) => {
  const fs = require('node:fs'),
    os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-notification-read140-'));
  const { createPlatformStore } = require(path.join(ROOT, 'src/server/application/platform.cjs'));
  const p = createPlatformStore(path.join(directory, 'platform'), {
    assistantComposition: false,
    administrationComposition: false,
    scheduleStartupReconcile: false,
  });
  t.after(() => {
    p.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(p.withNotificationReadSnapshot, null);
  assert.equal(
    p.withReadSnapshot(() => p.hasAccounts()),
    false,
  );
  const failure = Error('synthetic reader failure');
  assert.throws(
    () =>
      p.withReadSnapshot(() => {
        throw failure;
      }),
    (e) => e === failure,
  );
  assert.equal(
    p.withReadSnapshot(() => p.hasAccounts()),
    false,
  );
});
