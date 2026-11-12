'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { codec } = require('../src/server/migrations/prepare-cabinet-records.cjs');
const {
  preparePostgresCabinetRecords,
} = require('../src/server/infrastructure/postgres/cabinet-prepare145.cjs');
const {
  MARKER,
  acquireOfflinePreparation145,
} = require('../src/server/infrastructure/postgres/assistant-prepare145.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  verifyAssetProfile,
} = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');

for (const markerSchema of [1, 0])
  test(
    `native offline cabinet145 marker${markerSchema} prepares schema2 atomically and inverses CURRENT records without a data copy`,
    { timeout: 120000 },
    async (t) => {
      const f = await queueFixture(t, { cabinetVersion: 1 });
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-cabinet-prepare145-'));
      t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.match(path.basename(root), /^cartoteca-cabinet-prepare145-/);
        fs.rmSync(root, { recursive: true, force: true });
      });
      fs.mkdirSync(path.join(root, 'platform'));
      const keys = new Map(),
        patients = new Map();
      for (let n = 0; n < f.cabinets.length; n++) {
        const scope = f.cabinets[n],
          folder = n ? path.join(root, 'tenants', scope.organizationId) : root;
        fs.mkdirSync(folder, { recursive: true });
        const key = randomBytes(32);
        keys.set(scope.storeId, key);
        fs.writeFileSync(path.join(folder, 'encryption.key'), key, { flag: 'wx', mode: 0o600 });
        const patient = {
          id: 'p',
          name: 'Synthetic client',
          createdBy: 'owner',
          notes: 'Keep profile',
          visits: Array.from({ length: 40 }, (_, i) => ({
            id: 'v' + i,
            date: '2020-01-01',
            procedure: 'History ' + i,
            staffId: 'owner',
            photos: [],
          })),
          appointments: [
            {
              id: 'a',
              date: '2035-01-01',
              time: '10:00',
              duration: 30,
              staffId: 'owner',
              service: 'Synthetic',
            },
          ],
        };
        patients.set(scope.storeId, patient);
        f.a.c[n]
          .prepare('INSERT INTO patients(id,value) VALUES(?,?)')
          .run(patient.id, codec(key).encode(patient));
        f.a.c[n]
          .prepare('INSERT INTO services(id,value) VALUES(?,?)')
          .run('service', Buffer.from('opaque unchanged service'));
      }
      await f.a.owner.close();
      const initialRuntime = { ...f.identity.lineage, cabinetSchema: markerSchema };
      const marker = path.join(root, 'postgresql-runtime.json');
      fs.writeFileSync(marker, JSON.stringify(initialRuntime), { flag: 'wx', mode: 0o600 });
      const gate = path.join(root, '.restore-in-progress');
      fs.writeFileSync(gate, MARKER, { flag: 'wx', mode: 0o600 });
      const admin = f.admin;
      if (markerSchema === 0)
        await admin.query(
          "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2 AND marker_hash=$3",
          [digest(initialRuntime), initialRuntime.platformStoreId, digest(f.identity.lineage)],
        );
      const inventory = async () =>
        (
          await admin.query(
            'SELECT _store_id,id,value FROM cartoteca_cabinet.patients ORDER BY _store_id,id',
          )
        ).rows;
      const servicesBefore = (
        await admin.query(
          'SELECT _store_id,id,value FROM cartoteca_cabinet.services ORDER BY _store_id,id',
        )
      ).rows;
      const before = await inventory();
      const offline = await acquireOfflinePreparation145({ client: admin, directory: root });
      const options = {
        client: admin,
        directory: root,
        applicationRole: f.runtime.application.user,
      };
      await t.test('physical schema0 is rejected before table/catalog/data mutation', async () => {
        await admin.query('BEGIN');
        await admin.query(
          "UPDATE cartoteca_catalog.stores SET version=0 WHERE kind='cabinet' AND store_id=$1",
          [f.cabinets[0].storeId],
        );
        const statements = [];
        const client = {
          query(...args) {
            statements.push(args[0]);
            return admin.query(...args);
          },
        };
        await assert.rejects(preparePostgresCabinetRecords({ ...options, client }), {
          code: 'CABINET_PREPARATION_SCHEMA0_UNSUPPORTED',
        });
        assert.equal(
          statements.some((sql) =>
            /^\s*(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(sql),
          ),
          false,
        );
        assert.deepEqual(await inventory(), before);
        await admin.query('ROLLBACK');
      });
      await t.test(
        'outer rollback restores all original encrypted rows/catalog after complete forward preparation',
        async () => {
          await admin.query('BEGIN');
          const result = await preparePostgresCabinetRecords(options);
          assert.equal(result.runtime.cabinetSchema, 2);
          assert.equal(result.proof.patients, 2);
          assert.equal(result.proof.visits, 80);
          assert.equal(result.proof.typedReadbackVerified, true);
          assert.equal(result.proof.dataCopiesCreated, 0);
          await admin.query('ROLLBACK');
          assert.deepEqual(await inventory(), before);
          assert.ok(
            (
              await admin.query("SELECT version FROM cartoteca_catalog.stores WHERE kind='cabinet'")
            ).rows.every((row) => Number(row.version) === 1),
          );
        },
      );
      await t.test(
        'invalid legacy backlink and empty patient ID refuse preparation without publishing catalog2',
        async () => {
          const scope = f.cabinets[0],
            crypto = codec(keys.get(scope.storeId)),
            bad = structuredClone(patients.get(scope.storeId));
          bad.visits[0].appointmentId = 'a';
          for (const [id, value] of [
            ['', { ...bad, id: '' }],
            ['invalid-backlink', { ...bad, id: 'invalid-backlink' }],
          ]) {
            await admin.query('BEGIN');
            await admin.query(
              'INSERT INTO cartoteca_cabinet.patients(_store_id,id,value) VALUES($1,$2,$3)',
              [scope.storeId, id, crypto.encode(value)],
            );
            await assert.rejects(preparePostgresCabinetRecords(options));
            await admin.query('ROLLBACK');
            assert.deepEqual(await inventory(), before);
          }
        },
      );
      let prepared;
      await t.test(
        'forward publication keeps IDs/order/services and verifies the new runtime binding',
        async () => {
          await admin.query('BEGIN');
          prepared = await preparePostgresCabinetRecords(options);
          await admin.query(
            "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2 AND marker_hash=$3",
            [digest(prepared.runtime), prepared.runtime.platformStoreId, digest(initialRuntime)],
          );
          await admin.query('COMMIT');
          fs.writeFileSync(marker, JSON.stringify(prepared.runtime));
          await verifyAssetProfile(admin, prepared.runtime);
          assert.deepEqual(
            (
              await admin.query(
                'SELECT _store_id,id,value FROM cartoteca_cabinet.services ORDER BY _store_id,id',
              )
            ).rows,
            servicesBefore,
          );
          for (const row of await inventory()) {
            const profile = codec(keys.get(row._store_id)).decode(row.value);
            assert.equal(profile.id, 'p');
            assert.equal(profile.visits, undefined);
            assert.equal(profile.appointments, undefined);
          }
          const rows = (
            await admin.query(
              'SELECT _store_id,kind,id,patient_id,position,value FROM cartoteca_cabinet.cabinet_patient_records ORDER BY _store_id,kind,position',
            )
          ).rows;
          assert.equal(rows.length, 82);
          for (const scope of f.cabinets) {
            const crypto = codec(keys.get(scope.storeId)),
              original = patients.get(scope.storeId);
            for (const row of rows.filter((row) => row._store_id === scope.storeId))
              assert.deepEqual(
                crypto.decode(row.value),
                original[row.kind === 'visit' ? 'visits' : 'appointments'][Number(row.position)],
              );
          }
        },
      );
      await t.test(
        'inverse materializes current post-migration writes, never an obsolete schema1 blob',
        async () => {
          const scope = f.cabinets[0],
            crypto = codec(keys.get(scope.storeId));
          const changed = {
            ...patients.get(scope.storeId).appointments[0],
            notes: 'Committed after migration',
          };
          await admin.query(
            "UPDATE cartoteca_cabinet.cabinet_patient_records SET value=$1 WHERE _store_id=$2 AND kind='appointment' AND id='a'",
            [crypto.encode(changed), scope.storeId],
          );
          await admin.query('BEGIN');
          const inverse = await preparePostgresCabinetRecords({ ...options, rollback: true });
          assert.equal(inverse.proof.currentDataInverse, true);
          assert.equal(inverse.runtime.cabinetSchema, 1);
          await admin.query(
            "UPDATE cartoteca_catalog.asset_profiles SET marker_hash=$1 WHERE kind='platform' AND store_id=$2 AND marker_hash=$3",
            [digest(inverse.runtime), inverse.runtime.platformStoreId, digest(prepared.runtime)],
          );
          await admin.query('COMMIT');
          fs.writeFileSync(marker, JSON.stringify(inverse.runtime));
          await verifyAssetProfile(admin, inverse.runtime);
          const rows = await inventory();
          for (const row of rows) {
            const value = codec(keys.get(row._store_id)).decode(row.value),
              original = patients.get(row._store_id);
            assert.deepEqual(value.visits, original.visits);
            assert.deepEqual(
              value.appointments,
              row._store_id === scope.storeId ? [changed] : original.appointments,
            );
          }
          assert.equal(
            Number(
              (
                await admin.query(
                  'SELECT count(*) n FROM cartoteca_cabinet.cabinet_patient_records',
                )
              ).rows[0].n,
            ),
            0,
          );
          assert.deepEqual(
            (
              await admin.query(
                'SELECT _store_id,id,value FROM cartoteca_cabinet.services ORDER BY _store_id,id',
              )
            ).rows,
            servicesBefore,
          );
        },
      );
      await offline.release();
    },
  );
