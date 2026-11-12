const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { hotDirectoryFixture170 } = require('./helpers/postgres-hot-directory170-fixture.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  createAppointmentMutation,
} = require('../src/server/modules/cabinet/appointment-commands.cjs');
const {
  projectionKey,
  compact,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const {
  prepareDirectoryState196,
} = require('../src/server/infrastructure/postgres/directory-state-prepare196.cjs');
const {
  verifyDirectoryState196,
} = require('../src/server/infrastructure/postgres/directory-state-schema196.cjs');
const {
  HEAD,
  CHANGES,
} = require('../src/server/infrastructure/postgres/directory-state-sql196.cjs');

test(
  '196 real schema2 point writer preserves semantic pairs and journals only visible/repair writes',
  { timeout: 180000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    const storeId = f.cabinets[0].storeId,
      owner = f.actors[0],
      patientId = 'patient';
    let storage;
    const key = fs.readFileSync(path.join(f.dir, 'encryption.key'));
    const hash = (value) => createHmac('sha256', key).update(value).digest('hex');
    async function scope() {
      await f.admin.query(
        "SELECT set_config('cartoteca.kind','cabinet',false),set_config('cartoteca.store_id',$1,false)",
        [storeId],
      );
    }
    async function head() {
      const rows = (
        await f.admin.query(
          `SELECT epoch::text,seq::text,floor_seq::text,reset_seq::text,change_count::text FROM ${HEAD} WHERE store_id=$1`,
          [storeId],
        )
      ).rows;
      assert.equal(rows.length, 1);
      return rows[0];
    }
    async function pairFingerprint() {
      return (
        await f.admin.query(
          `SELECT 'summary'::text kind,patient_id||':'||audience identity,ctid::text tuple,
      encode(sha256(value),'hex') cipher FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND patient_id=$2
      UNION ALL SELECT 'projection',key,ctid::text,encode(sha256(value),'hex') FROM cartoteca_cabinet.meta
      WHERE _store_id=$1 AND key LIKE 'directory164:%' ORDER BY kind,identity`,
          [storeId, patientId],
        )
      ).rows;
    }
    async function clock() {
      return BigInt(
        (
          await f.admin.query(
            "SELECT revision::text FROM cartoteca_catalog.read_scope_versions163 WHERE kind='cabinet' AND store_id=$1 AND scope_id='*'",
            [storeId],
          )
        ).rows[0].revision,
      );
    }
    async function sourcePair() {
      const full = (
        await f.admin.query(
          "SELECT value FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND patient_id=$2 AND audience='*'",
          [storeId, patientId],
        )
      ).rows;
      const side = (
        await f.admin.query(
          'SELECT value FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key=$2',
          [storeId, projectionKey(patientId, '*')],
        )
      ).rows;
      assert.equal(full.length, 1);
      assert.equal(side.length, 1);
      return { full: full[0].value, projection: side[0].value };
    }
    function edit(change) {
      const current = storage.readSelected([patientId]).patients[0];
      const before = current.appointments[0],
        after = change(structuredClone(before));
      const command = createAppointmentMutation({
        revision: storage.get('revision'),
        patientId,
        changes: [{ id: before.id, before, after }],
      });
      return storage.transaction(() => {
        const snapshot = storage.readAppointmentMutation(command.appointmentRead, owner);
        assert.ok(snapshot);
        command.acceptCompact(snapshot);
        return storage.write(command.build(owner, snapshot), {
          insideTransaction: true,
          changedIds: command.changedIds,
          preparedBefore: snapshot,
          appointmentOnly: true,
        });
      });
    }
    try {
      await f.admin.query('BEGIN');
      try {
        await prepareDirectoryState196(f.admin, f.runtime.application.user);
        await f.admin.query('COMMIT');
      } catch (error) {
        await f.admin.query('ROLLBACK');
        throw error;
      }
      assert.equal((await verifyDirectoryState196(f.admin, f.runtime.application.user)).version, 1);
      // The pre-preparation driver can cache absence; this fresh owning connection
      // must attest the adjunct before storage enables its private no-op port.
      const fresh = await f.open();
      storage = createStorage(f.dir, {
        cabinetSchema: 2,
        databaseOwner: fresh.owner,
        databaseRoot: f.dir,
        photoOrganizationId: owner.organizationId,
      });
      assert.equal(storage.db.directoryState196?.version, 1);
      assert.equal(storage.indexes.directoryProjection164.logical196, true);
      await scope();

      await t.test(
        'notes-only changes persist notes/general revision/C* while all current list pairs stay byte-and-tuple identical',
        async () => {
          const oldHead = await head(),
            before = await pairFingerprint(),
            rev = storage.get('revision'),
            oldClock = await clock();
          const saved = edit((a) => ({ ...a, notes: 'Synthetic196 notes only' }));
          assert.equal(saved.appointmentOnly, true);
          assert.equal(saved.revision, rev + 1);
          assert.equal(
            storage.readSelected([patientId]).patients[0].appointments[0].notes,
            'Synthetic196 notes only',
          );
          assert.deepEqual(await head(), oldHead);
          assert.deepEqual(await pairFingerprint(), before);
          assert.ok((await clock()) > oldClock);
        },
      );
      await t.test(
        'visible appointment time changes update the canonical summary and exactly one committed directory sequence',
        async () => {
          const oldHead = await head(),
            before = await pairFingerprint();
          edit((a) => ({ ...a, time: '11:00' }));
          const after = await head();
          assert.equal(BigInt(after.seq), BigInt(oldHead.seq) + 1n);
          assert.notDeepEqual(await pairFingerprint(), before);
          const pair = await sourcePair(),
            summary = storage.decode(pair.full),
            projection = storage.decode(pair.projection);
          assert.ok(summary.appointments.some((a) => a.time === '11:00'));
          assert.equal(projection.sourceHash, hash(pair.full));
          assert.deepEqual(projection.row, compact(summary));
          const changes = (
            await f.admin.query(
              `SELECT patient_id,summary_changed,projection_changed FROM ${CHANGES} WHERE store_id=$1 AND seq=$2 AND audience='*'`,
              [storeId, after.seq],
            )
          ).rows;
          assert.deepEqual(changes, [
            { patient_id: patientId, summary_changed: true, projection_changed: true },
          ]);
        },
      );
      await t.test(
        'valid AES but stale sourceHash is repaired atomically instead of retained as a semantic no-op',
        async () => {
          const pair = await sourcePair(),
            projection = storage.decode(pair.projection);
          await scope();
          await f.admin.query(
            'UPDATE cartoteca_cabinet.meta SET value=$3 WHERE _store_id=$1 AND key=$2',
            [
              storeId,
              projectionKey(patientId, '*'),
              storage.encode({ ...projection, sourceHash: '0'.repeat(64) }),
            ],
          );
          const oldHead = await head();
          edit((a) => ({ ...a, notes: 'Synthetic196 stale pair repair' }));
          assert.equal(BigInt((await head()).seq), BigInt(oldHead.seq) + 1n);
          const repaired = await sourcePair();
          assert.equal(storage.decode(repaired.projection).sourceHash, hash(repaired.full));
          assert.deepEqual(
            storage.decode(repaired.projection).row,
            compact(storage.decode(repaired.full)),
          );
        },
      );
      await t.test(
        'missing owner projection is recreated in the same point transaction',
        async () => {
          await scope();
          await f.admin.query('DELETE FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key=$2', [
            storeId,
            projectionKey(patientId, '*'),
          ]);
          const oldHead = await head();
          edit((a) => ({ ...a, notes: 'Synthetic196 missing pair repair' }));
          assert.equal(BigInt((await head()).seq), BigInt(oldHead.seq) + 1n);
          const pair = await sourcePair();
          assert.equal(storage.decode(pair.projection).sourceHash, hash(pair.full));
        },
      );
      await t.test(
        'invalid AES on the current paired projection fails503 and rolls back earlier appointment writes and revision',
        async () => {
          await scope();
          await f.admin.query(
            'UPDATE cartoteca_cabinet.meta SET value=$3 WHERE _store_id=$1 AND key=$2',
            [storeId, projectionKey(patientId, '*'), Buffer.from([1, 2, 3])],
          );
          const beforeHead = await head(),
            before = await pairFingerprint(),
            rev = storage.get('revision');
          const notes = storage.readSelected([patientId]).patients[0].appointments[0].notes;
          assert.throws(
            () => edit((a) => ({ ...a, notes: 'Synthetic196 must rollback' })),
            (e) => e.status === 503,
          );
          assert.equal(storage.get('revision'), rev);
          assert.equal(storage.readSelected([patientId]).patients[0].appointments[0].notes, notes);
          assert.deepEqual(await head(), beforeHead);
          assert.deepEqual(await pairFingerprint(), before);
        },
      );
    } finally {
      key.fill(0);
      storage?.close();
      await f.close();
    }
  },
);
