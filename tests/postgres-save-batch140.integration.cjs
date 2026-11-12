// Actual PostgreSQL regressions using the cohort-owned synthetic fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { queueFixture } = require(path.join(ROOT, 'tests/helpers/postgres-queue134-fixture.cjs'));
const { createCabinetIndexes } = require(
  path.join(ROOT, 'src/server/infrastructure/cabinet-indexes.cjs'),
);
const { createPatientRecords, patientProfile } = require(
  path.join(ROOT, 'src/server/infrastructure/cabinet-records.cjs'),
);
test(
  'actual PostgreSQL batched uniqueness keeps fresh guards, exact kind and cabinet RLS',
  { timeout: 90000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 2 });
    const rows = Array.from({ length: 401 }, (_, n) => ({
      kind: n % 2 ? 'visit' : 'appointment',
      id: 'r' + n,
      patient_id: 'one',
    }));
    const insert = async (scope, data) =>
      f.admin.query(
        `INSERT INTO cartoteca_cabinet.cabinet_record_ids(_store_id,kind,id,patient_id)
    SELECT $1,x.kind,x.id,x.patient_id FROM jsonb_to_recordset($2::jsonb) AS x(kind text,id text,patient_id text)`,
        [scope.storeId, JSON.stringify(data)],
      );
    await insert(f.cabinets[0], rows);
    await insert(f.cabinets[0], [
      { kind: 'visit', id: 'same-id', patient_id: 'one' },
      { kind: 'appointment', id: 'same-id', patient_id: 'two' },
    ]);
    await insert(f.cabinets[1], [
      { kind: 'visit', id: 'foreign-cabinet-only', patient_id: 'secret-foreign-owner' },
    ]);
    const index = createCabinetIndexes({
      db: f.a.c[0],
      schemaVersion: 2,
      encode: (v) => Buffer.from(JSON.stringify(v)),
      decode: (v) => JSON.parse(Buffer.from(v)),
      hash: (v) => v,
    });
    const patient = {
      visits: rows.filter((r) => r.kind === 'visit'),
      appointments: rows.filter((r) => r.kind === 'appointment'),
    };
    let at = f.a.owner.stats().calls;
    index.assertUnique([patient], ['one']);
    assert.equal(
      f.a.owner.stats().calls - at,
      3,
      'compiled fixed JSON lookup is three native RPCs, not 401',
    );
    at = f.a.owner.stats().calls;
    index.assertUnique([], ['one']);
    assert.equal(f.a.owner.stats().calls - at, 0);
    assert.throws(
      () => index.assertUnique([{ visits: [], appointments: [{ id: 'same-id' }] }], ['one']),
      { status: 400 },
    );
    assert.doesNotThrow(() =>
      index.assertUnique([{ visits: [{ id: 'same-id' }], appointments: [] }], ['one']),
    );
    assert.doesNotThrow(() =>
      index.assertUnique([{ visits: [], appointments: [{ id: 'same-id' }] }], ['one', 'two']),
    );
    assert.doesNotThrow(
      () =>
        index.assertUnique(
          [{ visits: [{ id: 'foreign-cabinet-only' }], appointments: [] }],
          ['one'],
        ),
      'same record ID in another cabinet cannot affect this tenant guard',
    );
    await insert(f.cabinets[0], [
      { kind: 'visit', id: 'legacy-\ufffd', patient_id: 'two' },
      { kind: 'visit', id: 'Иванов-😀-"-\\', patient_id: 'two' },
    ]);
    assert.throws(
      () => index.assertUnique([{ visits: [{ id: 'legacy-\ud800' }], appointments: [] }], ['one']),
      { status: 400 },
    );
    assert.throws(
      () => index.assertUnique([{ visits: [{ id: 'Иванов-😀-"-\\' }], appointments: [] }], ['one']),
      { status: 400 },
    );
    const fresh = [{ visits: [{ id: 'later-foreign' }], appointments: [] }];
    index.assertUnique(fresh, ['one']);
    await insert(f.cabinets[0], [{ kind: 'visit', id: 'later-foreign', patient_id: 'two' }]);
    assert.throws(
      () => index.assertUnique(fresh, ['one']),
      { status: 400 },
      'later committed owner must be observed',
    );
    f.a.c[0].exec('BEGIN IMMEDIATE');
    f.a.c[0]
      .prepare('UPDATE cabinet_record_ids SET patient_id=? WHERE kind=? AND id=?')
      .run('one', 'visit', 'later-foreign');
    index.assertUnique(fresh, ['one']);
    f.a.c[0].exec('ROLLBACK');
    assert.throws(() => index.assertUnique(fresh, ['one']), { status: 400 });
    await t.test('one canonical selection supports a real write diff, swap and rollback', () => {
      const c = f.a.c[0],
        encode = (v) => Buffer.from(JSON.stringify(v)),
        decode = (v) => JSON.parse(Buffer.from(v).toString('utf8'));
      const patients = ['p0', 'p1'].map((id, n) => ({
        id,
        name: 'Synthetic ' + n,
        visits: [
          { id: 'canonical-v' + n, date: '2020-01-01', notes: 'Retained synthetic history' },
        ],
        appointments: [{ id: 'canonical-a' + n, date: '2035-01-01', time: '10:00' }],
      }));
      c.exec('BEGIN IMMEDIATE');
      for (const patient of patients) {
        c.prepare('INSERT INTO patients(id,value) VALUES(?,?)').run(
          patient.id,
          encode(patientProfile(patient)),
        );
        for (const [kind, list] of [
          ['visit', patient.visits],
          ['appointment', patient.appointments],
        ])
          list.forEach((value, n) =>
            c
              .prepare(
                'INSERT INTO cabinet_patient_records(kind,id,patient_id,position,value) VALUES(?,?,?,?,?)',
              )
              .run(kind, value.id, patient.id, n, encode(value)),
          );
      }
      c.exec('COMMIT');
      const reads = [];
      const records = createPatientRecords({
        db: c,
        schemaVersion: 2,
        encode,
        decode,
        prepare(sql) {
          const q = c.prepare(sql);
          return {
            get(...args) {
              reads.push(sql);
              return q.get(...args);
            },
            all(...args) {
              reads.push(sql);
              return q.all(...args);
            },
            run(...args) {
              return q.run(...args);
            },
          };
        },
      });
      reads.length = 0;
      c.exec('BEGIN IMMEDIATE');
      const at = f.a.owner.stats().calls;
      const before = records.sync(patients, ['p1', 'p0', 'p1']);
      assert.equal(
        f.a.owner.stats().calls - at,
        2,
        'one profile query plus one fresh canonical-record query',
      );
      assert.equal(reads.length, 2);
      assert.equal(before.indexedIds.size, 0);
      c.exec('COMMIT');
      const rows = c.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all();
      const next = structuredClone(patients);
      [next[0].appointments, next[1].appointments] = [next[1].appointments, next[0].appointments];
      c.exec('BEGIN IMMEDIATE');
      records.sync(next, ['p0', 'p1']);
      c.exec('COMMIT');
      assert.deepEqual(
        c
          .prepare(
            "SELECT id,patient_id FROM cabinet_patient_records WHERE kind='appointment' ORDER BY id",
          )
          .all(),
        [
          { id: 'canonical-a0', patient_id: 'p1' },
          { id: 'canonical-a1', patient_id: 'p0' },
        ],
      );
      assert.deepEqual(
        c.prepare("SELECT * FROM cabinet_patient_records WHERE kind='visit' ORDER BY id").all(),
        rows.filter((r) => r.kind === 'visit'),
      );
      const swapped = c.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all();
      c.exec('BEGIN IMMEDIATE');
      records.sync([next[0]], ['p0', 'p1']);
      c.exec('ROLLBACK');
      assert.deepEqual(
        c.prepare('SELECT * FROM cabinet_patient_records ORDER BY kind,id').all(),
        swapped,
      );
      c.prepare('INSERT INTO patients(id,value) VALUES(?,?)').run(
        'legacy-\ufffd',
        encode({ id: 'legacy-\ufffd', name: 'Synthetic legacy' }),
      );
      const ids = ['p0', 'legacy-\ud800', 'p0'],
        expected = ids.flatMap((id) => {
          const row = c.prepare('SELECT id,value FROM patients WHERE id=?').get(id);
          return row ? [row.id] : [];
        });
      const selected = [],
        methods = [],
        stop = Error('Synthetic stop after profile lookup');
      const legacyRecords = createPatientRecords({
        db: c,
        schemaVersion: 2,
        encode,
        decode,
        prepare(sql) {
          const q = c.prepare(sql);
          return {
            get(...args) {
              const row = q.get(...args);
              methods.push('get');
              if (row) selected.push(row.id);
              return row;
            },
            all(...args) {
              if (sql.includes('WHERE patient_id IN (SELECT value FROM json_each(?))')) throw stop;
              const result = q.all(...args);
              if (sql.includes('patients AS selected')) {
                methods.push('all');
                selected.push(...result.map((row) => row.id));
              }
              return result;
            },
            run(...args) {
              return q.run(...args);
            },
          };
        },
      });
      c.exec('BEGIN IMMEDIATE');
      assert.throws(
        () => legacyRecords.sync([], ids),
        (error) => error === stop,
      );
      c.exec('ROLLBACK');
      assert.deepEqual(selected, expected);
      assert.deepEqual(methods, ['all', 'get', 'all']);
    });

    await t.test(
      'full profile3 platform notification port uses physical READONLY and restores the root after failures',
      () => {
        const fs = require('node:fs'),
          os = require('node:os'),
          { randomBytes } = require('node:crypto');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-notification-read140-'));
        const platformDirectory = path.join(directory, 'platform');
        fs.mkdirSync(platformDirectory);
        fs.writeFileSync(
          path.join(directory, 'postgresql-runtime.json'),
          JSON.stringify(f.identity.lineage),
        );
        fs.writeFileSync(path.join(platformDirectory, 'platform.key'), randomBytes(32), {
          flag: 'wx',
        });
        let platform;
        try {
          const { createPlatformStore } = require(
            path.join(ROOT, 'src/server/application/platform.cjs'),
          );
          platform = createPlatformStore(platformDirectory, {
            databaseOwner: f.a.owner,
            notificationSchema: 19,
            assistantComposition: false,
            administrationComposition: false,
            scheduleStartupReconcile: false,
            notificationChannelProjection: true,
          });
          assert.equal(typeof platform.withNotificationReadSnapshot, 'function');
          const p = f.a.p,
            org = f.organizations[0],
            organization = p.prepare('SELECT id,slug FROM organizations WHERE id=?'),
            subscription = p.prepare('SELECT plan FROM subscriptions WHERE organization_id=?');
          assert.equal(p.isTransaction, false);
          platform.withNotificationReadSnapshot(() => {
            assert.equal(p.isTransaction, true);
            assert.equal(p.canPrefetchReads, true);
            const before = f.a.owner.stats().calls;
            assert.equal(
              p.prefetchReads([
                organization.readRequest('get', [org]),
                subscription.readRequest('get', [org]),
              ]),
              true,
            );
            assert.equal(organization.get(org).id, org);
            assert.equal(subscription.get(org), undefined);
            assert.equal(
              f.a.owner.stats().calls - before,
              1,
              'two effect-free reads and ordinary consumers share one physical RPC',
            );
          });
          assert.equal(p.isTransaction, false);
          assert.equal(p.canPrefetchReads, false);
          platform.withReadSnapshot(() =>
            assert.equal(p.canPrefetchReads, false, 'generic DEFERRED contract is unchanged'),
          );
          const original = organization.get(org);
          assert.throws(
            () =>
              platform.withNotificationReadSnapshot(() =>
                p.prepare('UPDATE organizations SET slug=? WHERE id=?').run('must-not-write', org),
              ),
            { code: 'POSTGRES_QUERY_ONLY' },
          );
          assert.equal(p.isTransaction, false);
          assert.deepEqual(organization.get(org), original);
          assert.throws(
            () =>
              platform.withNotificationReadSnapshot(() =>
                p.prepare('SELECT 1 / 0 AS broken').get(),
              ),
            { code: '22012' },
          );
          assert.equal(p.isTransaction, false);
          platform.withNotificationReadSnapshot(() => assert.equal(organization.get(org).id, org));
          assert.equal(p.isTransaction, false);
          const aborted = Error('synthetic projection failure');
          assert.throws(
            () =>
              platform.withNotificationReadSnapshot(() => {
                organization.get(org);
                throw aborted;
              }),
            (e) => e === aborted,
          );
          assert.equal(p.isTransaction, false);
          platform.withNotificationReadSnapshot(() => assert.equal(organization.get(org).id, org));
        } finally {
          platform?.close();
          fs.rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  },
);
