const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { codec } = require('../src/server/migrations/prepare-cabinet-records.cjs');
const { createPatientRecords } = require('../src/server/infrastructure/cabinet-records.cjs');
const {
  schema,
  createHistoryIndex,
} = require('../src/server/infrastructure/cabinet-history-index145.cjs');
const {
  createPatientHistoryReader,
} = require('../src/server/infrastructure/patient-history-read145.cjs');
function fixture(t, { indexed = true } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE patients(id TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE meta(key TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE cabinet_patient_records(kind TEXT NOT NULL,id TEXT NOT NULL,patient_id TEXT NOT NULL,position INTEGER NOT NULL,value BLOB NOT NULL,PRIMARY KEY(kind,id));PRAGMA user_version=2;',
  );
  if (indexed) db.exec(schema);
  const key = crypto.randomBytes(32),
    c = codec(key),
    hash = (value) => crypto.createHmac('sha256', key).update(value).digest('hex');
  let decoded = 0;
  const decode = (value) => {
    decoded++;
    return c.decode(value);
  };
  const records = createPatientRecords({ db, encode: c.encode, decode, hash });
  let revision = 0;
  const save = (patients, ids = patients.map((p) => p.id)) => {
    db.exec('BEGIN');
    try {
      records.sync(patients, ids);
      revision++;
      db.prepare(
        'INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('revision', c.encode(revision));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const current = {
    accountId: 'staff-a',
    sessionId: 'session-a',
    role: 'owner',
    organizationId: 'org-a',
  };
  const reader = createPatientHistoryReader({
    db,
    encode: c.encode,
    decode,
    hash,
    schemaVersion: 2,
  });
  const url = (path = '/api/cabinet/patient', extra = {}) => {
    const result = new URL(path, 'http://local.test');
    result.searchParams.set('id', 'patient');
    for (const [k, v] of Object.entries(extra)) result.searchParams.set(k, v);
    return result;
  };
  return {
    db,
    save,
    records,
    current,
    reader,
    url,
    hash,
    ...c,
    decode,
    count: () => decoded,
    reset: () => {
      decoded = 0;
    },
  };
}
function patient(visits = 137, appointments = 160) {
  return {
    id: 'patient',
    name: 'Synthetic',
    createdBy: 'owner',
    notes: 'Preserve profile',
    visits: Array.from({ length: visits }, (_, i) => ({
      id: 'v' + i,
      date: '2020-01-' + String((i % 28) + 1).padStart(2, '0'),
      time: i % 2 ? '10:00' : '',
      staffId: i % 3 ? 'staff-a' : 'staff-b',
      photos: Array.from({ length: i % 3 }, (_, n) => ({ data: '/api/photos/' + i + '-' + n })),
    })),
    appointments: Array.from({ length: appointments }, (_, i) => ({
      id: 'a' + i,
      date: '2020-01-' + String((i % 28) + 1).padStart(2, '0'),
      time: i % 2 ? '10:00' : '',
      staffId: i % 3 ? 'staff-a' : 'staff-b',
      duration: 30,
      status:
        i % 4 === 0
          ? 'completed'
          : i % 4 === 1
            ? 'cancelled'
            : i % 4 === 2
              ? 'no_show'
              : 'scheduled',
    })),
  };
}
const compare = (a, b) =>
  (b.record.date + ' ' + (b.record.time || '')).localeCompare(
    a.record.date + ' ' + (a.record.time || ''),
  );
const expectedHistory = (p) =>
  [
    ...p.visits.map((record) => ({ kind: 'visit', record })),
    ...p.appointments
      .filter((a) => ['cancelled', 'no_show'].includes(a.status))
      .map((record) => ({ kind: 'appointment', record })),
  ].sort(compare);
test('card/history keyset exactly matches canonical stable ordering with bounded decrypt per page', (t) => {
  const f = fixture(t),
    p = patient();
  f.save([p]);
  f.reset();
  const card = f.reader.read(f.current, f.url(undefined, { view: 'card' }));
  assert.equal(card.patient.notes, p.notes);
  assert.equal(card.history.entries.length, 50);
  assert.equal(card.upcoming.entries.length, 40);
  assert.ok(f.count() <= 160, 'only profile/manifests/bounded candidates decoded');
  const entries = [...card.history.entries];
  let cursor = card.history.nextCursor;
  while (cursor) {
    f.reset();
    const page = f.reader.read(f.current, f.url('/api/cabinet/patient/history', { cursor }));
    assert.ok(f.count() <= 110);
    entries.push(...page.entries);
    cursor = page.nextCursor;
  }
  assert.deepEqual(entries, expectedHistory(p));
  assert.equal(new Set(entries.map((e) => e.kind + e.record.id)).size, entries.length);
  assert.equal(card.history.total, entries.length);
  assert.equal(
    card.history.photoCount,
    p.visits.reduce((n, v) => n + v.photos.length, 0),
  );
  const upcoming = p.appointments
    .filter((a) => !a.status || a.status === 'scheduled')
    .sort((a, b) => -compare({ record: a }, { record: b }));
  assert.deepEqual(card.upcoming.entries, upcoming);
  assert.ok(
    card.upcoming.entries.every((a) => a.date < '2026-01-01'),
    'overdue active appointments preserved',
  );
  assert.deepEqual(
    f.records.hydrate(f.db.prepare('SELECT id,value FROM patients').all())[0],
    p,
    'full canonical route source remains complete',
  );
});
test('staff canonical witness filters every row/count/photo and cursor binds full identity plus revision', (t) => {
  const f = fixture(t),
    p = patient();
  f.save([p]);
  const staff = { ...f.current, role: 'cosmetologist' },
    page = f.reader.read(staff, f.url());
  assert.ok(page.history.entries.every((e) => e.record.staffId === staff.accountId));
  assert.equal(
    page.history.total,
    expectedHistory(p).filter((e) => e.record.staffId === staff.accountId).length,
  );
  assert.equal(
    page.history.photoCount,
    p.visits.filter((v) => v.staffId === staff.accountId).reduce((n, v) => n + v.photos.length, 0),
  );
  const next = f.url('/api/cabinet/patient/history', { cursor: page.history.nextCursor });
  for (const override of [
    { accountId: 'other' },
    { sessionId: 'other' },
    { organizationId: 'other' },
    { role: 'owner' },
  ])
    assert.throws(() => f.reader.read({ ...staff, ...override }, next), { status: 400 });
  assert.throws(
    () =>
      f.reader.read(
        staff,
        f.url('/api/cabinet/patient/upcoming', { cursor: page.history.nextCursor }),
      ),
    { status: 400 },
  );
  assert.throws(() => f.reader.read({ ...staff, accountId: 'outsider' }, f.url()), { status: 404 });
  f.save([{ ...p, notes: 'new profile' }]);
  assert.throws(() => f.reader.read(staff, next), { status: 409 });
});
test('tampered/missing derived data and staff witness cannot authorize or silently omit canonical records', (t) => {
  const f = fixture(t),
    p = patient();
  f.save([p]);
  const staff = { ...f.current, role: 'cosmetologist' };
  f.db
    .prepare('DELETE FROM cabinet_history_manifests WHERE audience=? AND stream=?')
    .run(f.hash('staff:staff-a'), 'visit');
  assert.throws(() => f.reader.read(staff, f.url()), { code: 'CABINET_HISTORY_INDEX' });
  f.db.exec('BEGIN');
  f.records.historyIndex.syncPatient(
    p,
    f.db.prepare('SELECT * FROM cabinet_patient_records').all(),
    f.db.prepare('SELECT value FROM patients').get().value,
  );
  f.db.exec('COMMIT');
  f.db
    .prepare(
      "UPDATE cabinet_history_entries SET source_hash='invalid' WHERE audience='*' AND stream='visit' AND rank=1",
    )
    .run();
  assert.throws(() => f.reader.read(f.current, f.url()), { code: 'CABINET_HISTORY_INDEX' });
  f.db.prepare("DELETE FROM cabinet_patient_records WHERE kind='visit'").run();
  assert.throws(() => f.reader.read(staff, f.url()), { code: 'CABINET_HISTORY_INDEX' });
});
test('appointment-only index update never reads/decrypts visits and rollback preserves original ranks/manifests', (t) => {
  const f = fixture(t),
    p = patient();
  f.save([p]);
  const oldVisits = f.db
    .prepare("SELECT * FROM cabinet_history_entries WHERE stream='visit'")
    .all();
  const oldManifests = f.db
    .prepare("SELECT * FROM cabinet_history_manifests WHERE stream='visit'")
    .all();
  const next = p.appointments.map((a, i) =>
    i === 0 ? { ...a, status: 'cancelled', date: '2030-01-01' } : a,
  );
  const index = createHistoryIndex({
    db: f.db,
    encode: f.encode,
    hash: f.hash,
    schemaVersion: 2,
    decode: (value) => {
      const v = f.decode(value);
      assert.ok(!v.photos, 'no canonical visit decode');
      return v;
    },
    prepare: (sql) => {
      assert.ok(!sql.includes("kind='visit'"));
      return f.db.prepare(sql);
    },
  });
  f.db.exec('BEGIN');
  f.db
    .prepare("UPDATE cabinet_patient_records SET value=? WHERE kind='appointment' AND id='a0'")
    .run(f.encode(next[0]));
  index.syncAppointments(p.id, p.appointments, next);
  assert.equal(f.reader.read(f.current, f.url()).history.entries[0].record.id, 'a0');
  assert.deepEqual(
    f.db.prepare("SELECT * FROM cabinet_history_entries WHERE stream='visit'").all(),
    oldVisits,
  );
  assert.deepEqual(
    f.db.prepare("SELECT * FROM cabinet_history_manifests WHERE stream='visit'").all(),
    oldManifests,
  );
  f.db.exec('ROLLBACK');
  assert.deepEqual(
    f.reader.read(f.current, f.url()).history.entries,
    expectedHistory(p).slice(0, 50),
  );
});
test('completed-only staff proof grants existing visibility while absent component never fetches patient data', (t) => {
  const f = fixture(t),
    p = patient(0, 0);
  p.appointments.push({
    id: 'done',
    date: '2020-01-01',
    time: '10:00',
    staffId: 'staff-a',
    status: 'completed',
  });
  f.save([p]);
  const card = f.reader.read({ ...f.current, role: 'cosmetologist' }, f.url());
  assert.equal(card.history.total, 0);
  assert.equal(card.upcoming.total, 0);
  const none = createPatientHistoryReader({
    db: {
      catalog: { version: 1, tables: {} },
      prepare() {
        throw Error('must not fetch');
      },
    },
  });
  assert.deepEqual(none.read(f.current, f.url()), { viewUnsupported: true });
  assert.throws(
    () =>
      createPatientHistoryReader({
        db: { catalog: { version: 2, tables: { cabinet_history_entries: {} } } },
      }),
    { code: 'CABINET_HISTORY_INDEX' },
  );
  assert.throws(() => f.reader.read(f.current, f.url(undefined, { cursor: 'broken' })), {
    status: 400,
  });
});
test('async owning-operation materialization matches sync output, including bounded selected notification appointments', async (t) => {
  const f = fixture(t),
    p = patient();
  f.save([p]);
  const materialized = new Set(),
    requests = new WeakMap();
  const key = (sql, method, args) => JSON.stringify([sql, method, args]);
  const db = {
    catalog: { version: 2, tables: { cabinet_history_entries: {}, cabinet_history_manifests: {} } },
    prepare(sql) {
      return {
        readRequest(method, args) {
          const token = {};
          requests.set(token, { sql, method, args });
          return token;
        },
        get(...args) {
          assert.ok(materialized.has(key(sql, 'get', args)));
          return f.db.prepare(sql).get(...args);
        },
        all(...args) {
          assert.ok(materialized.has(key(sql, 'all', args)));
          return f.db.prepare(sql).all(...args);
        },
      };
    },
    async prefetchAll(tokens) {
      for (const token of tokens) {
        const r = requests.get(token);
        materialized.add(key(r.sql, r.method, r.args));
      }
    },
  };
  const reader = createPatientHistoryReader({
    db,
    encode: f.encode,
    decode: f.decode,
    hash: f.hash,
  });
  const result = await reader.readAsync(f.current, f.url()),
    sync = f.reader.read(f.current, f.url());
  assert.deepEqual(
    {
      ...result.history,
      nextCursor: f.decode(Buffer.from(result.history.nextCursor, 'base64url')),
    },
    { ...sync.history, nextCursor: f.decode(Buffer.from(sync.history.nextCursor, 'base64url')) },
  );
  const selected = await reader.readAsync(
    { ...f.current, role: 'cosmetologist' },
    f.url('/api/telegram/patient'),
    ['a1', 'a2'],
  );
  assert.equal(selected.patient.appointments.length, 2);
  assert.equal(selected.patient.visits.length, 0);
  await assert.rejects(
    reader.readAsync({ ...f.current, role: 'cosmetologist' }, f.url('/api/telegram/patient'), [
      'a0',
    ]),
    { status: 404 },
  );
  await assert.rejects(
    reader.readAsync(f.current, f.url('/api/telegram/patient'), Array(51).fill('a1')),
    { status: 400 },
  );
});

test('connection preview validates revision and selected IDs before storage, MAX uses canonical visibility with no full read', (t) => {
  const {
    patientViewStatus,
  } = require('../src/server/modules/notifications/patient-view-status145.cjs');
  const {
    createMaxConnections,
  } = require('../src/server/modules/notifications/max-connections.cjs');
  const f = fixture(t),
    p = patient();
  f.save([p]);
  let calls = 0;
  const storage = {
    readSelected() {
      throw Error('full history forbidden');
    },
    patientViewAppointments(current, url, ids) {
      calls++;
      return f.reader.read(current, url, ids);
    },
  };
  const c = {
    current: f.current,
    url: f.url('/api/telegram/patient', {
      view: 'card',
      patientId: p.id,
      revision: '1',
      appointmentIds: JSON.stringify(['a1']),
    }),
    tenantStore: () => storage,
  };
  const selected = patientViewStatus(c);
  assert.equal(selected.revision, 1);
  assert.equal(selected.patient.appointments[0].id, 'a1');
  c.url.searchParams.set('revision', '0');
  assert.throws(() => patientViewStatus(c), { status: 409 });
  c.url.searchParams.delete('revision');
  const before = calls;
  assert.throws(() => patientViewStatus(c), { status: 400 });
  assert.equal(calls, before);
  const max = createMaxConnections({ platform: {}, tenantStore: () => storage });
  const status = max.status(
    f.current,
    p.id,
    f.url('/api/max/patient', { view: 'card', patientId: p.id }),
  );
  assert.equal(status.patientId, p.id);
  assert.equal(status.linked, false);
  assert.throws(
    () =>
      max.status(
        { ...f.current, role: 'cosmetologist', accountId: 'outsider' },
        p.id,
        f.url('/api/max/patient', { view: 'card', patientId: p.id }),
      ),
    { status: 404 },
  );
});
test('real storage connects prepared component while full reads and save remain canonical', (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const { createStorage } = require('../storage.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-history145-'));
  let store;
  t.after(() => {
    try {
      store?.close();
    } finally {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  store = createStorage(root, { cabinetSchema: 2 });
  store.close();
  const db = new DatabaseSync(path.join(root, 'cabinet.sqlite'));
  db.exec(schema);
  db.close();
  store = createStorage(root);
  const p = patient(20, 4);
  p.appointments[0].status = 'scheduled';
  p.visits.forEach((v) => {
    v.photos = [];
  });
  p.appointments.forEach((a) => {
    a.time = '10:00';
  });
  store.write({ patients: [p], services: [], revision: 0 });
  const current = { accountId: 'staff-a', role: 'owner', sessionId: 's', organizationId: 'org' };
  const url = new URL('http://local/api/cabinet/patient?id=patient&view=card');
  assert.equal(store.patientView(current, url).history.total, 22);
  assert.deepEqual(store.readSelected([p.id]).patients[0], p);
  const before = store.readSelected([p.id]);
  store.write(
    { ...before, patients: [{ ...p, notes: 'Keep full visits' }] },
    { changedIds: { patients: [p.id], services: [] } },
  );
  assert.equal(store.patientView(current, url).patient.notes, 'Keep full visits');
  assert.equal(store.readSelected([p.id]).patients[0].visits.length, 20);
});

test('actual Telegram/MAX GET handlers preserve complete bounded status and reject foreign/stale selections', async (t) => {
  const telegramRoute = require('../src/server/modules/notifications/routes.cjs').routes.find(
    (r) => r.method === 'GET' && r.path === '/api/telegram/patient',
  );
  const maxRoute = require('../src/server/modules/notifications/max-routes.cjs').routes.find(
    (r) => r.method === 'GET' && r.path === '/api/max/patient',
  );
  const {
    createMaxConnections,
  } = require('../src/server/modules/notifications/max-connections.cjs');
  const f = fixture(t),
    p = patient(8, 12),
    foreign = { ...patient(2, 2), id: 'foreign' };
  foreign.visits.forEach((v) => {
    v.id = 'foreign-' + v.id;
    v.staffId = 'staff-b';
  });
  foreign.appointments.forEach((a) => {
    a.id = 'foreign-' + a.id;
    a.staffId = 'staff-b';
  });
  f.save([p, foreign]);
  let fullCalls = 0;
  const storage = {
    readSelected() {
      fullCalls++;
      throw Error('full read forbidden');
    },
    patientViewAppointments(current, url, ids) {
      return f.reader.read(current, url, ids);
    },
  };
  const current = { ...f.current, role: 'cosmetologist' };
  const makeUrl = (channel, id = 'patient', ids = ['a1', 'a2']) => {
    const u = new URL('http://local/api/' + channel + '/patient');
    u.searchParams.set('patientId', id);
    u.searchParams.set('view', 'card');
    if (channel === 'telegram') {
      u.searchParams.set('revision', '1');
      u.searchParams.set('appointmentIds', JSON.stringify(ids));
    }
    return u;
  };
  const platform = {
    telegram: {
      link: () => ({ linkedAt: 123, servicesConsent: true }),
      settings: () => ({ timeZone: 'Europe/Moscow', enabled: true, showServices: true }),
      confirmed: () => 111,
      delivery: () => 'sent',
    },
    subscription: () => ({ status: 'active', limits: { automaticNotifications: true } }),
    appointmentConfirmations: {
      read: (_org, _patient, a) => ({ manualConfirmedAt: a.id === 'a1' ? 222 : null }),
      stamp: (a) => 'stamp-' + a.id,
    },
  };
  const c = {
    current,
    platform,
    url: makeUrl('telegram'),
    res: {},
    tenantStore: () => storage,
    telegram: { status: () => ({ connected: true }) },
    json: (_res, code, result) => {
      assert.equal(code, 200);
      return result;
    },
  };
  const good = await telegramRoute.handle(c);
  assert.equal(good.revision, 1);
  assert.equal(good.linked, true);
  assert.equal(good.linkedAt, 123);
  assert.equal(good.showServices, true);
  assert.equal(good.confirmations.length, 2);
  assert.equal(good.confirmations[0].manualConfirmedAt, 222);
  assert.deepEqual(
    good.appointments.map((a) => a.appointmentId),
    ['a1', 'a2'],
  );
  for (const [id, ids] of [
    ['foreign', ['foreign-a1']],
    ['patient', ['foreign-a1']],
    ['patient', ['a0']],
  ])
    await assert.rejects(telegramRoute.handle({ ...c, url: makeUrl('telegram', id, ids) }), {
      status: 404,
    });
  const stale = makeUrl('telegram');
  stale.searchParams.set('revision', '0');
  await assert.rejects(telegramRoute.handle({ ...c, url: stale }), { status: 409 });
  await assert.rejects(
    telegramRoute.handle({
      ...c,
      url: makeUrl(
        'telegram',
        'patient',
        Array.from({ length: 51 }, (_, i) => 'a' + i),
      ),
    }),
    { status: 400 },
  );
  const spoof = makeUrl('telegram', 'foreign', ['a1']);
  spoof.searchParams.set('id', 'patient');
  await assert.rejects(telegramRoute.handle({ ...c, url: spoof }), { status: 404 });
  const maxConnections = createMaxConnections({ platform, tenantStore: () => storage });
  const max = await maxRoute.handle({ ...c, url: makeUrl('max'), maxConnections });
  assert.equal(max.patientId, 'patient');
  await assert.rejects(maxRoute.handle({ ...c, url: makeUrl('max', 'foreign'), maxConnections }), {
    status: 404,
  });
  assert.equal(fullCalls, 0, 'supported view does not call the full patient endpoint');
});

test('profile-only and photo-only canonical saves retain ranks, use exact hash CAS, and roll back a mismatch', (t) => {
  const f = fixture(t),
    p = patient();
  f.save([p]);
  const executed = [];
  const prepare = (sql) => {
    const statement = f.db.prepare(sql);
    return {
      get: (...args) => statement.get(...args),
      all: (...args) => statement.all(...args),
      run: (...args) => {
        executed.push({ sql, args });
        return statement.run(...args);
      },
    };
  };
  const records = createPatientRecords({
    db: f.db,
    prepare,
    encode: f.encode,
    decode: f.decode,
    hash: f.hash,
  });
  const selection = () =>
    records.hydrate(f.db.prepare('SELECT id,value FROM patients WHERE id=?').all(p.id), true);
  const before = selection(),
    captured = records.captureWrite(before);
  const entries = f.db
    .prepare('SELECT * FROM cabinet_history_entries ORDER BY audience,stream,rank')
    .all();
  f.db.exec('BEGIN');
  records.sync([{ ...before[0], notes: 'Only profile changed' }], [p.id], f.encode, captured);
  f.db.exec('COMMIT');
  assert.equal(
    executed.filter((r) => /^(INSERT|UPDATE|DELETE).*cabinet_history_entries/.test(r.sql)).length,
    0,
  );
  assert.deepEqual(
    f.db.prepare('SELECT * FROM cabinet_history_entries ORDER BY audience,stream,rank').all(),
    entries,
  );
  assert.equal(f.reader.read(f.current, f.url()).patient.notes, 'Only profile changed');
  const withProfile = selection(),
    photo = { data: '/api/photos/synthetic' },
    next = {
      ...withProfile[0],
      visits: withProfile[0].visits.map((v, i) => (i ? v : { ...v, photos: [photo] })),
    };
  executed.length = 0;
  f.db.exec('BEGIN');
  records.sync([next], [p.id], f.encode, records.captureWrite(withProfile));
  f.db.exec('COMMIT');
  const entryWrites = executed.filter((r) =>
    /^(INSERT|UPDATE|DELETE).*cabinet_history_entries/.test(r.sql),
  );
  assert.equal(entryWrites.length, 1);
  assert.match(entryWrites[0].sql, /^UPDATE .*source_hash=CASE/);
  const updated = f.db
    .prepare('SELECT * FROM cabinet_history_entries ORDER BY audience,stream,rank')
    .all();
  assert.deepEqual(
    updated.map((r) => ({ ...r, source_hash: '' })),
    entries.map((r) => ({ ...r, source_hash: '' })),
  );
  assert.equal(updated.filter((r, i) => r.source_hash !== entries[i].source_hash).length, 2);
  assert.equal(
    f.reader.read(f.current, f.url()).history.photoCount,
    p.visits.reduce((n, v) => n + v.photos.length, 0) + 1,
  );
  const stable = selection(),
    originalCipher = f.db
      .prepare("SELECT value FROM cabinet_patient_records WHERE kind='visit' AND id='v0'")
      .get().value;
  f.db.exec('BEGIN');
  f.db
    .prepare(
      "UPDATE cabinet_history_entries SET source_hash='wrong' WHERE stream='visit' AND id='v0' AND audience='*'",
    )
    .run();
  const mismatch = {
    ...stable[0],
    visits: stable[0].visits.map((v, i) => (i ? v : { ...v, notes: 'Changed' })),
  };
  assert.throws(() => records.sync([mismatch], [p.id], f.encode, records.captureWrite(stable)), {
    code: 'CABINET_HISTORY_INDEX',
  });
  f.db.exec('ROLLBACK');
  assert.deepEqual(
    f.db.prepare("SELECT value FROM cabinet_patient_records WHERE kind='visit' AND id='v0'").get()
      .value,
    originalCipher,
  );
  assert.equal(f.reader.read(f.current, f.url()).history.photoCount, 137);
});
test('changed ordering rebuild uses bounded bulk statements and retains unrelated stream ciphertext', (t) => {
  const f = fixture(t),
    p = patient(300, 10);
  f.save([p]);
  const writes = [];
  const records = createPatientRecords({
    db: f.db,
    encode: f.encode,
    decode: f.decode,
    hash: f.hash,
    prepare: (sql) => {
      const q = f.db.prepare(sql);
      return {
        get: (...args) => q.get(...args),
        all: (...args) => q.all(...args),
        run: (...args) => {
          writes.push({ sql, args });
          return q.run(...args);
        },
      };
    },
  });
  const before = records.hydrate(f.db.prepare('SELECT id,value FROM patients').all(), true);
  const appointmentIndex = f.db
    .prepare(
      "SELECT * FROM cabinet_history_entries WHERE stream<>'visit' ORDER BY audience,stream,rank",
    )
    .all();
  const next = {
    ...before[0],
    visits: before[0].visits.map((v, i) => (i ? v : { ...v, date: '2035-01-01' })),
  };
  f.db.exec('BEGIN');
  records.sync([next], [p.id], f.encode, records.captureWrite(before));
  f.db.exec('COMMIT');
  const inserts = writes.filter((q) => q.sql.startsWith('INSERT INTO cabinet_history_entries'));
  assert.equal(inserts.length, 5, '600 global+staff visit rows in chunks128');
  assert.ok(inserts.every((q) => q.args.length <= 1024));
  assert.ok(inserts.some((q) => q.args.length === 1024));
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT * FROM cabinet_history_entries WHERE stream<>'visit' ORDER BY audience,stream,rank",
      )
      .all(),
    appointmentIndex,
  );
  assert.equal(f.reader.read(f.current, f.url()).history.entries[0].record.id, 'v0');
});
