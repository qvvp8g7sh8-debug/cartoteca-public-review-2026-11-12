const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { createStorage } = require('../storage.cjs');
const {
  createAppointmentMutation,
  createAppointmentPatchMutation,
} = require('../src/server/modules/cabinet/appointment-commands.cjs');
test(
  'native schema2 point appointment writer keeps canonical history/photos/summary counts and full legacy CAS',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetComponents: { patientHistory: true } }),
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-point145-'));
    let store;
    t.after(() => {
      store?.close();
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.match(path.basename(root), /^cartoteca-point145-/);
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(
      path.join(root, 'postgresql-runtime.json'),
      JSON.stringify(f.identity.lineage),
      { flag: 'wx', mode: 0o600 },
    );
    fs.writeFileSync(path.join(root, 'encryption.key'), randomBytes(32), {
      flag: 'wx',
      mode: 0o600,
    });
    store = createStorage(root, {
      cabinetSchema: 2,
      databaseOwner: f.a.owner,
      databaseRoot: root,
      photoOrganizationId: f.cabinets[0].organizationId,
    });
    store.write({
      revision: 0,
      services: [],
      patients: [
        {
          id: 'p',
          name: 'Synthetic',
          createdBy: 'owner',
          visits: Array.from({ length: 240 }, (_, n) => ({
            id: 'v' + n,
            date: '2020-01-01',
            procedure: 'History ' + n,
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
        },
      ],
    });
    const history = () =>
        store.db
          .prepare(
            "SELECT id,position,value FROM cabinet_patient_records WHERE kind='visit' ORDER BY position",
          )
          .all(),
      kept = history(),
      original = store.readSelected(['p']).patients[0],
      beforeSummary = store.indexes.summaries({ role: 'owner' }, ['p'])[0];
    const indexRowIds = () =>
      store.db
        .prepare(
          'SELECT rowid FROM cabinet_history_entries WHERE patient_id=? ORDER BY audience,stream,rank',
        )
        .all('p');
    const originalIndexRowIds = indexRowIds();
    let saved;
    const body = {
        revision: store.get('revision'),
        patientId: 'p',
        changes: [
          {
            id: 'a',
            before: original.appointments[0],
            after: { ...original.appointments[0], notes: 'Native point' },
          },
        ],
      },
      command = createAppointmentMutation(body);
    store.transaction(() => {
      const before = store.readAppointmentMutation(command.appointmentRead, { role: 'owner' });
      assert.ok(before);
      command.acceptCompact(before);
      assert.equal(before.patients[0].visits.length, 0);
      saved = store.write(command.build({ role: 'owner' }, before), {
        insideTransaction: true,
        changedIds: command.changedIds,
        preparedBefore: before,
      });
    });
    assert.deepEqual(
      indexRowIds(),
      originalIndexRowIds,
      '155 note-only edit CASes hashes and manifests without rebuilding history ranks',
    );
    assert.equal(saved.patients[0].visits.length, 240);
    assert.equal(saved.patients[0].appointments[0].notes, 'Native point');
    assert.deepEqual(history(), kept);
    const summary = store.indexes.summaries({ role: 'owner' }, ['p'])[0];
    assert.equal(summary.visitCount, beforeSummary.visitCount);
    assert.deepEqual(summary.lastVisit, beforeSummary.lastVisit);
    const after = structuredClone(saved.patients[0]);
    after.appointments[0].notes = 'Legacy point';
    const legacy = {
        revision: saved.revision,
        patients: [{ id: 'p', before: saved.patients[0], after }],
        services: [],
      },
      patch = createAppointmentPatchMutation(legacy);
    store.transaction(() => {
      const before = store.readAppointmentMutation(patch.appointmentRead, { role: 'owner' });
      assert.ok(before);
      patch.acceptCompact(before);
      const result = store.write(patch.build({ role: 'owner' }, before), {
        insideTransaction: true,
        changedIds: patch.changedIds,
        preparedBefore: before,
      });
      assert.equal(result.patients[0].visits, legacy.patients[0].before.visits);
      assert.equal(result.patients[0].appointments[0].notes, 'Legacy point');
    });
    const stale = structuredClone(legacy);
    stale.patients[0].before.visits[0].notes = 'Wrong full before';
    stale.patients[0].after.visits[0].notes = 'Wrong full before';
    const rejected = createAppointmentPatchMutation(stale);
    assert.throws(
      () =>
        store.transaction(() =>
          store.readAppointmentMutation(rejected.appointmentRead, { role: 'owner' }),
        ),
      (error) => error.status === 409,
    );

    assert.deepEqual(history(), kept);
    const latest = store.readSelected(['p']);
    const compact = createAppointmentMutation({
      revision: latest.revision,
      patientId: 'p',
      changes: [
        {
          id: 'a',
          before: latest.patients[0].appointments[0],
          after: { ...latest.patients[0].appointments[0], notes: '151 delta' },
        },
      ],
    });
    const originalPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => {
      if (/SELECT.*value FROM cabinet_patient_records.*kind='visit'/i.test(sql))
        throw Error('151 native delta may not load visit history');
      return originalPrepare(sql);
    };
    store.transaction(() => {
      const before = store.readAppointmentMutation(compact.appointmentRead, { role: 'owner' });
      compact.acceptCompact(before);
      const delta = store.write(compact.build({ role: 'owner' }, before), {
        insideTransaction: true,
        changedIds: compact.changedIds,
        preparedBefore: before,
        appointmentOnly: true,
      });
      assert.equal(delta.appointmentOnly, true);
      assert.equal(delta.patients[0].visits.length, 0);
      assert.equal(delta.patients[0].appointments[0].notes, '151 delta');
    });
    store.db.prepare = originalPrepare;
    assert.deepEqual(history(), kept);
    assert.equal(store.readSelected(['p']).patients[0].visits.length, 240);
  },
);
