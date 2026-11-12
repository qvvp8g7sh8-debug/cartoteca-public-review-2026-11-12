const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { codec } = require('../src/server/migrations/prepare-cabinet-records.cjs');
const { createPatientRecords } = require('../src/server/infrastructure/cabinet-records.cjs');
const { createHistoryIndex } = require('../src/server/infrastructure/cabinet-history-index145.cjs');
const {
  createPatientHistoryReader,
} = require('../src/server/infrastructure/patient-history-read145.cjs');
const {
  preparePostgresPatientHistory,
} = require('../src/server/infrastructure/postgres/history-prepare145.cjs');
const {
  MARKER,
  acquireOfflinePreparation145,
} = require('../src/server/infrastructure/postgres/assistant-prepare145.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
function synthetic() {
  return {
    id: 'patient',
    name: 'Synthetic client',
    createdBy: 'owner',
    notes: 'Preserved profile',
    visits: Array.from({ length: 130 }, (_, i) => ({
      id: 'v' + i,
      date: '2020-01-' + String((i % 28) + 1).padStart(2, '0'),
      staffId: i % 3 ? 'staff-a' : 'staff-b',
      procedure: 'Synthetic',
      photos: [],
    })),
    appointments: Array.from({ length: 90 }, (_, i) => ({
      id: 'a' + i,
      date: '2020-01-' + String((i % 28) + 1).padStart(2, '0'),
      time: '10:00',
      staffId: i % 3 ? 'staff-a' : 'staff-b',
      duration: 30,
      status: ['scheduled', 'cancelled', 'no_show'][i % 3],
    })),
  };
}
test(
  'native optional history preparation/reads preserve RLS, canonical lifecycle and current-data inverse',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      keys = new Map(),
      patients = new Map();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-history-native145-'));
    t.after(() => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, 'platform'));
    for (let n = 0; n < f.cabinets.length; n++) {
      const scope = f.cabinets[n],
        folder = n ? path.join(root, 'tenants', scope.organizationId) : root;
      fs.mkdirSync(folder, { recursive: true });
      const key = randomBytes(32);
      keys.set(scope.storeId, key);
      fs.writeFileSync(path.join(folder, 'encryption.key'), key, { flag: 'wx', mode: 0o600 });
      const c = codec(key),
        db = f.a.c[n],
        p = synthetic();
      patients.set(scope.storeId, p);
      db.exec('BEGIN IMMEDIATE');
      createPatientRecords({ db, encode: c.encode, decode: c.decode }).sync([p], [p.id]);
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('revision', c.encode(1));
      db.exec('COMMIT');
    }
    await f.a.owner.close();
    const marker = path.join(root, 'postgresql-runtime.json');
    fs.writeFileSync(marker, JSON.stringify(f.identity.lineage), { flag: 'wx' });
    fs.writeFileSync(path.join(root, '.restore-in-progress'), MARKER, { flag: 'wx' });
    const offline = await acquireOfflinePreparation145({ client: f.admin, directory: root });
    const options = {
      client: f.admin,
      directory: root,
      applicationRole: f.runtime.application.user,
      runtime: f.identity.lineage,
    };
    const inventory = async () =>
      (
        await f.admin.query(
          'SELECT _store_id,kind,id,patient_id,position,value FROM cartoteca_cabinet.cabinet_patient_records ORDER BY _store_id,kind,id',
        )
      ).rows;
    const original = await inventory();
    const foreign = randomUUID();
    await f.admin.query('BEGIN');
    await preparePostgresSchema(f.admin, {
      kind: 'cabinet',
      storeId: foreign,
      source: f.cabinetCatalog,
      applicationRole: f.runtime.application.user,
    });
    await f.admin.query('COMMIT');
    await t.test(
      'outer rollback restores all catalogs and never touches a foreign asset lineage',
      async () => {
        await f.admin.query('BEGIN');
        const result = await preparePostgresPatientHistory(options);
        assert.equal(result.proof.stores, 2);
        assert.equal(result.proof.patients, 2);
        await f.admin.query('ROLLBACK');
        assert.deepEqual(await inventory(), original);
        const catalog = (
          await f.admin.query(
            "SELECT catalog_hash FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=$1",
            [foreign],
          )
        ).rows[0];
        assert.equal(catalog.catalog_hash, digest(f.cabinetCatalog));
      },
    );
    await t.test(
      'invalid visit backlink to active appointment fails before committing an index',
      async () => {
        await f.admin.query('BEGIN');
        const key = keys.get(f.cabinets[0].storeId),
          p = patients.get(f.cabinets[0].storeId);
        await f.admin.query(
          "UPDATE cartoteca_cabinet.cabinet_patient_records SET value=$1 WHERE _store_id=$2 AND kind='visit' AND id='v0'",
          [codec(key).encode({ ...p.visits[0], appointmentId: 'a0' }), f.cabinets[0].storeId],
        );
        await assert.rejects(preparePostgresPatientHistory(options), { status: 400 });
        await f.admin.query('ROLLBACK');
        assert.deepEqual(await inventory(), original);
      },
    );
    await t.test(
      'empty legacy patient id is examined and rejected instead of skipped by keyset',
      async () => {
        await f.admin.query('BEGIN');
        const first = f.cabinets[0].storeId,
          key = keys.get(first);
        await f.admin.query(
          'INSERT INTO cartoteca_cabinet.patients(_store_id,id,value) VALUES($1,$2,$3)',
          [first, '', codec(key).encode({ id: '', name: 'Invalid empty ID', createdBy: 'owner' })],
        );
        await assert.rejects(preparePostgresPatientHistory(options), { status: 400 });
        await f.admin.query('ROLLBACK');
        assert.deepEqual(await inventory(), original);
      },
    );
    let prepared;
    await t.test(
      'confirmed preparation changes only optional catalogs/indexes, then reads exact bounded pages',
      async () => {
        await f.admin.query('BEGIN');
        prepared = await preparePostgresPatientHistory(options);
        await f.admin.query(
          "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2 AND marker_hash=$3",
          [digest(prepared.runtime), f.platform.storeId, f.identity.markerHash],
        );
        await f.admin.query('COMMIT');
        fs.writeFileSync(marker, JSON.stringify(prepared.runtime));
        f.identity.lineage = prepared.runtime;
        f.identity.markerHash = digest(prepared.runtime);
        assert.deepEqual(await inventory(), original);
        await offline.release();
      },
    );
    const opened = await f.open(),
      db = opened.c[0],
      key = keys.get(f.cabinets[0].storeId),
      c = codec(key),
      hash = (v) => createHmac('sha256', key).update(v).digest('hex');
    const reader = createPatientHistoryReader({ db, ...c, hash }),
      current = {
        organizationId: f.organizations[0],
        accountId: 'staff-a',
        sessionId: 'session-a',
        role: 'owner',
      };
    const url = (mode = 'card', cursor) => {
      const u = new URL(
        'http://local/api/cabinet/patient' + (mode === 'card' ? '?view=card' : '/' + mode),
      );
      u.searchParams.set('id', 'patient');
      if (cursor) u.searchParams.set('cursor', cursor);
      return u;
    };
    const read = (actor, request) => {
      db.exec('BEGIN READONLY');
      try {
        const result = reader.read(actor, request);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    let first;
    await t.test(
      'actual native SQL keyset, private staff counts and cursor identity work without full hydration',
      () => {
        first = read(current, url());
        assert.equal(first.history.entries.length, 50);
        assert.equal(first.history.total, 190);
        assert.equal(first.upcoming.total, 30);
        const collected = [...first.history.entries];
        let cursor = first.history.nextCursor;
        while (cursor) {
          const page = read(current, url('history', cursor));
          collected.push(...page.entries);
          cursor = page.nextCursor;
        }
        assert.equal(collected.length, 190);
        assert.equal(new Set(collected.map((v) => v.kind + v.record.id)).size, 190);
        const staff = read({ ...current, role: 'cosmetologist' }, url());
        assert.ok(staff.history.entries.every((v) => v.record.staffId === 'staff-a'));
        assert.throws(
          () => read({ ...current, sessionId: 'other' }, url('history', first.history.nextCursor)),
          { status: 400 },
        );
        assert.throws(
          () => read({ ...current, role: 'cosmetologist', accountId: 'outsider' }, url()),
          { status: 404 },
        );
        const other = createPatientHistoryReader({ db: opened.c[1], ...c, hash });
        opened.c[1].exec('BEGIN READONLY');
        try {
          assert.throws(
            () => other.read(current, url()),
            /authenticate|decrypt|Unsupported|bad|state/i,
          );
        } finally {
          opened.c[1].exec('ROLLBACK');
        }
      },
    );
    await t.test(
      'appointment delta keeps visit index bytes, revision rejects old cursor and rollback preserves state',
      () => {
        const entries = db
          .prepare(
            "SELECT * FROM cabinet_history_entries WHERE stream='visit' ORDER BY audience,rank",
          )
          .all();
        const p = patients.get(f.cabinets[0].storeId),
          next = p.appointments.map((v, i) =>
            i ? v : { ...v, status: 'cancelled', date: '2030-01-01' },
          );
        db.exec('BEGIN IMMEDIATE');
        db.prepare(
          "UPDATE cabinet_patient_records SET value=? WHERE kind='appointment' AND id='a0'",
        ).run(c.encode(next[0]));
        createHistoryIndex({ db, ...c, hash, schemaVersion: 2 }).syncAppointments(
          p.id,
          p.appointments,
          next,
        );
        db.prepare('UPDATE meta SET value=? WHERE key=?').run(c.encode(2), 'revision');
        db.exec('COMMIT');
        assert.deepEqual(
          db
            .prepare(
              "SELECT * FROM cabinet_history_entries WHERE stream='visit' ORDER BY audience,rank",
            )
            .all(),
          entries,
        );
        assert.equal(read(current, url()).history.entries[0].record.id, 'a0');
        assert.throws(() => read(current, url('history', first.history.nextCursor)), {
          status: 409,
        });
        db.exec('BEGIN IMMEDIATE');
        db.prepare(
          "DELETE FROM cabinet_history_entries WHERE audience='*' AND stream='visit' AND rank=1",
        ).run();
        db.exec('ROLLBACK');
        assert.equal(read(current, url()).history.total, 191);
      },
    );
    await t.test(
      'native profile-only save retains all entry rows and photo update CASes only source proofs',
      () => {
        const records = createPatientRecords({ db, ...c, hash });
        const selected = () =>
          records.hydrate(
            db.prepare('SELECT id,value FROM patients WHERE id=?').all('patient'),
            true,
          );
        const before = selected(),
          entries = db
            .prepare('SELECT * FROM cabinet_history_entries ORDER BY audience,stream,rank')
            .all();
        db.exec('BEGIN IMMEDIATE');
        records.sync(
          [{ ...before[0], notes: 'Profile current' }],
          ['patient'],
          c.encode,
          records.captureWrite(before),
        );
        db.exec('COMMIT');
        assert.deepEqual(
          db.prepare('SELECT * FROM cabinet_history_entries ORDER BY audience,stream,rank').all(),
          entries,
        );
        assert.equal(read(current, url()).patient.notes, 'Profile current');
        const photoBefore = selected(),
          next = {
            ...photoBefore[0],
            visits: photoBefore[0].visits.map((v, i) =>
              i ? v : { ...v, photos: [{ data: '/api/photos/synthetic' }] },
            ),
          };
        db.exec('BEGIN IMMEDIATE');
        records.sync([next], ['patient'], c.encode, records.captureWrite(photoBefore));
        db.exec('COMMIT');
        const after = db
          .prepare('SELECT * FROM cabinet_history_entries ORDER BY audience,stream,rank')
          .all();
        assert.deepEqual(
          after.map((r) => ({ ...r, source_hash: '' })),
          entries.map((r) => ({ ...r, source_hash: '' })),
        );
        assert.equal(after.filter((r, i) => r.source_hash !== entries[i].source_hash).length, 2);
        assert.equal(read(current, url()).history.photoCount, 1);
        const stable = selected();
        db.exec('BEGIN IMMEDIATE');
        db.prepare(
          "UPDATE cabinet_history_entries SET source_hash='bad' WHERE stream='visit' AND id='v0' AND audience='*'",
        ).run();
        assert.throws(
          () =>
            records.sync(
              [
                {
                  ...stable[0],
                  visits: stable[0].visits.map((v, i) => (i ? v : { ...v, notes: 'Rejected' })),
                },
              ],
              ['patient'],
              c.encode,
              records.captureWrite(stable),
            ),
          { code: 'CABINET_HISTORY_INDEX' },
        );
        db.exec('ROLLBACK');
        assert.equal(read(current, url()).history.photoCount, 1);
      },
    );
    await opened.owner.close();
    await t.test(
      'current-state inverse removes only derived rows and preserves newer canonical appointment',
      async () => {
        const hold = await acquireOfflinePreparation145({ client: f.admin, directory: root });
        try {
          const before = await inventory();
          await f.admin.query('BEGIN');
          const inverse = await preparePostgresPatientHistory({
            ...options,
            runtime: prepared.runtime,
            rollback: true,
          });
          assert.equal(inverse.proof.currentDataInverse, true);
          await f.admin.query('COMMIT');
          assert.deepEqual(await inventory(), before);
          assert.equal(
            (
              await f.admin.query(
                'SELECT count(*)::text n FROM cartoteca_cabinet.cabinet_history_entries',
              )
            ).rows[0].n,
            '0',
          );
        } finally {
          await hold.release();
        }
      },
    );
  },
);
