const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { codec } = require('../../src/server/migrations/prepare-cabinet-records.cjs');
const { createPatientRecords } = require('../../src/server/infrastructure/cabinet-records.cjs');
const { schema } = require('../../src/server/infrastructure/cabinet-history-index145.cjs');
const {
  createPatientHistoryReader,
} = require('../../src/server/infrastructure/patient-history-read145.cjs');

function patientCapsuleFixture197(t, { upcoming = true } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE patients(id TEXT PRIMARY KEY,value BLOB NOT NULL);' +
      'CREATE TABLE meta(key TEXT PRIMARY KEY,value BLOB NOT NULL);' +
      'CREATE TABLE cabinet_patient_records(kind TEXT NOT NULL,id TEXT NOT NULL,patient_id TEXT NOT NULL,position INTEGER NOT NULL,value BLOB NOT NULL,PRIMARY KEY(kind,id));' +
      schema +
      'PRAGMA user_version=2;',
  );
  const catalog = {
    version: 2,
    tables: Object.fromEntries(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(({ name }) => [
          name,
          { columns: db.prepare('PRAGMA table_info(' + name + ')').all() },
        ]),
    ),
  };
  db.catalog = catalog;
  const key = crypto.randomBytes(32),
    c = codec(key),
    hash = (value) => crypto.createHmac('sha256', key).update(value).digest('hex');
  let decoded = 0,
    revision = 0;
  const decode = (value) => {
    decoded++;
    return c.decode(value);
  };
  const records = createPatientRecords({ db, encode: c.encode, decode, hash });
  const current = {
    accountId: 'staff-a',
    sessionId: 'session-a',
    role: 'owner',
    organizationId: 'org-a',
  };
  const patient = {
    id: 'patient',
    name: 'Synthetic patient',
    createdBy: 'owner',
    notes: 'Synthetic profile notes',
    allergies: 'Synthetic allergy',
    visits: Array.from({ length: 113 }, (_, i) => ({
      id: 'v-' + i,
      date: '2020-01-' + String((i % 28) + 1).padStart(2, '0'),
      time: i % 2 ? '10:00' : '',
      staffId: i % 3 ? 'staff-a' : 'staff-b',
      photos: Array.from({ length: i % 3 }, (_, n) => ({ data: '/api/photos/synthetic-' + n })),
    })),
    appointments: Array.from({ length: 88 }, (_, i) => ({
      id: 'a-' + i,
      date: '2035-01-' + String((i % 28) + 1).padStart(2, '0'),
      time: '11:00',
      duration: 30,
      staffId: i % 3 ? 'staff-a' : 'staff-b',
      status:
        i % 4 === 0
          ? 'completed'
          : i % 4 === 1
            ? 'cancelled'
            : i % 4 === 2
              ? 'no_show'
              : upcoming
                ? 'scheduled'
                : 'completed',
    })),
  };
  const save = (value = patient) => {
    db.exec('BEGIN');
    try {
      records.sync([value], [value.id]);
      db.prepare(
        'INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('revision', c.encode(++revision));
      db.prepare(
        'INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('initialized', c.encode(true));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  save();
  const reader = createPatientHistoryReader({
    db,
    encode: c.encode,
    decode,
    hash,
    schemaVersion: 2,
  });
  function url(path = '/api/cabinet/patient', values = {}) {
    const result = new URL(path, 'http://local.test');
    result.searchParams.set('id', patient.id);
    if (path === '/api/cabinet/patient') result.searchParams.set('view', 'card');
    for (const [name, value] of Object.entries(values)) result.searchParams.set(name, value);
    return result;
  }
  const columns = [
    'bucket',
    'id',
    'patient_id',
    'kind',
    'position',
    'audience',
    'stream',
    'rank',
    'source_hash',
    'witness_kind',
    'witness_id',
    'value',
  ];
  const row = (bucket, values) =>
    Object.assign(Object.fromEntries(columns.map((name) => [name, null])), { bucket }, values);
  function packet(selection) {
    const { id, audience, kind, cursor } = selection;
    const rows = [];
    for (const profile of db.prepare('SELECT id,value FROM patients WHERE id=?').all(id))
      rows.push(row('profile', profile));
    for (const meta of db
      .prepare("SELECT key AS id,value FROM meta WHERE key IN('revision','initialized')")
      .all())
      rows.push(row('meta', meta));
    const manifests = db
      .prepare("SELECT * FROM cabinet_history_manifests WHERE patient_id=? AND audience IN('*',?)")
      .all(id, audience);
    for (const manifest of manifests) rows.push(row('manifest', manifest));
    const witnesses = new Set();
    for (const manifest of manifests.filter((m) => m.audience === audience)) {
      if (!manifest.witness_id) continue;
      const record = db
        .prepare('SELECT * FROM cabinet_patient_records WHERE patient_id=? AND kind=? AND id=?')
        .get(id, manifest.witness_kind, manifest.witness_id);
      const key = record && JSON.stringify([record.kind, record.id]);
      if (record && !witnesses.has(key)) {
        witnesses.add(key);
        rows.push(row('witness', record));
      }
    }
    const streams =
      kind === 'card'
        ? ['visit', 'outcome', 'upcoming']
        : kind === 'history'
          ? ['visit', 'outcome']
          : ['upcoming'];
    for (const stream of streams) {
      const selected = db
        .prepare(
          'SELECT e.*,r.patient_id AS current_patient_id,r.value FROM cabinet_history_entries e LEFT JOIN cabinet_patient_records r ON r.patient_id=e.patient_id AND r.kind=e.kind AND r.id=e.id AND r.position=e.position WHERE e.patient_id=? AND e.audience=? AND e.stream=? AND e.rank>? ORDER BY e.rank LIMIT 51',
        )
        .all(id, audience, stream, cursor[stream]);
      for (const entry of selected)
        rows.push(row('entry', { ...entry, patient_id: entry.current_patient_id }));
    }
    return {
      rows,
      bound: {
        patientPageEmpty165: !db
          .prepare(
            "SELECT 1 FROM cabinet_history_entries WHERE patient_id=? AND audience=? AND stream='upcoming' LIMIT 1",
          )
          .get(id, audience),
        clinicalWitness: 'synthetic-current-witness',
        sourceBounds: new Map(),
      },
    };
  }
  return {
    db,
    catalog,
    current,
    patient,
    reader,
    save,
    url,
    packet,
    encode: c.encode,
    decode,
    hash,
    reset: () => {
      decoded = 0;
    },
    decoded: () => decoded,
  };
}
module.exports = { patientCapsuleFixture197 };
