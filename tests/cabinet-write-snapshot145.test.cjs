'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStorage } = require('../storage.cjs');
const { migrateCabinetRecords } = require('../src/server/migrations/002-cabinet-records.cjs');
const {
  createAppointmentPatchMutation,
} = require('../src/server/modules/cabinet/appointment-commands.cjs');
function fixture(t, schema) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-write145-'));
  let store = createStorage(directory);
  const photoId = 'f'.repeat(32);
  store.db.prepare('INSERT INTO photos(id,mime,active) VALUES(?,?,1)').run(photoId, 'image/png');
  store.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'p',
        name: 'Synthetic',
        createdBy: 'owner',
        notes: 'Keep profile',
        visits: Array.from({ length: 30 }, (_, n) => ({
          id: 'v' + n,
          date: '2020-01-01',
          procedure: 'History ' + n,
          staffId: 'owner',
          photos: n === 0 ? [{ data: '/api/photos/' + photoId, caption: 'Synthetic retained' }] : [],
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
  if (schema === 2) {
    migrateCabinetRecords(store);
    store.close();
    store = createStorage(directory, { cabinetSchema: 2 });
  }
  t.after(() => {
    store.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cartoteca-write145-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}
function withNoPatientDecrypt(store, schema, callback) {
  const blobs =
    schema === 2
      ? store.db.prepare('SELECT value FROM cabinet_patient_records').all()
      : store.db.prepare('SELECT value FROM patients').all();
  const ivs = new Set(blobs.map(({ value }) => Buffer.from(value).subarray(0, 12).toString('hex')));
  const original = crypto.createDecipheriv;
  crypto.createDecipheriv = function (algorithm, key, iv, ...rest) {
    if (ivs.has(Buffer.from(iv).toString('hex'))) throw Error('Duplicate canonical hydration');
    return original.call(this, algorithm, key, iv, ...rest);
  };
  try {
    return callback();
  } finally {
    crypto.createDecipheriv = original;
  }
}
for (const schema of [1, 2]) {
  test(`fresh owning snapshot avoids repeated patient/history decode in schema${schema}`, (t) => {
    const store = fixture(t, schema),
      ids = { patients: ['p'], services: [] };
    const unchanged =
      schema === 2
        ? store.db
            .prepare(
              "SELECT kind,id,position,value FROM cabinet_patient_records WHERE kind='visit' ORDER BY position",
            )
            .all()
        : null;
    store.transaction(() => {
      const before = store.readForMutation(ids),
        next = structuredClone(before);
      assert.ok(Object.isFrozen(before.patients[0].visits[0]));
      next.patients[0].appointments[0].notes = 'Only this appointment changes';
      withNoPatientDecrypt(store, schema, () =>
        store.write(next, { insideTransaction: true, changedIds: ids, preparedBefore: before }),
      );
    });
    const after = store.readSelected(['p']);
    assert.equal(after.patients[0].appointments[0].notes, 'Only this appointment changes');
    assert.equal(after.patients[0].visits.length, 30);
    if (schema === 2)
      assert.deepEqual(
        store.db
          .prepare(
            "SELECT kind,id,position,value FROM cabinet_patient_records WHERE kind='visit' ORDER BY position",
          )
          .all(),
        unchanged,
      );
  });
  test(`foreign/previous-transaction snapshots cannot suppress authoritative reread in schema${schema}`, (t) => {
    const store = fixture(t, schema),
      ids = { patients: ['p'], services: [] };
    let previous;
    store.transaction(() => {
      previous = store.readForMutation(ids);
    });
    for (const getBefore of [() => previous, () => structuredClone(previous)]) {
      assert.throws(
        () =>
          store.transaction(() => {
            const next = structuredClone(previous);
            next.patients[0].appointments[0].notes = 'Must rehydrate';
            withNoPatientDecrypt(store, schema, () =>
              store.write(next, {
                insideTransaction: true,
                changedIds: ids,
                preparedBefore: getBefore(),
              }),
            );
          }),
        /Duplicate canonical hydration/,
      );
    }
    assert.equal(store.readSelected(['p']).patients[0].appointments[0].notes, undefined);
  });
  test(`intervening SQL invalidates the fresh write snapshot in schema${schema}`, (t) => {
    const store = fixture(t, schema),
      ids = { patients: ['p'], services: [] };
    assert.throws(
      () =>
        store.transaction(() => {
          const before = store.readForMutation(ids),
            next = structuredClone(before);
          next.patients[0].appointments[0].notes = 'Must not use stale before';
          store.db.prepare('UPDATE patients SET value=value WHERE id=?').run('p');
          withNoPatientDecrypt(store, schema, () =>
            store.write(next, { insideTransaction: true, changedIds: ids, preparedBefore: before }),
          );
        }),
      /Duplicate canonical hydration/,
    );
    assert.equal(store.readSelected(['p']).patients[0].appointments[0].notes, undefined);
    assert.throws(() => store.readForMutation(ids), /requires transaction/);
  });
}
test('legacy appointment-only PATCH keeps full before-CAS and original receipt body, without cloning unchanged history', () => {
  const patient = {
    id: 'p',
    name: 'Synthetic',
    visits: [{ id: 'v', staffId: 'owner', photos: [] }],
    appointments: [{ id: 'a', staffId: 'owner', notes: 'Before' }],
  };
  const after = structuredClone(patient);
  after.appointments[0].notes = 'After';
  const body = {
    revision: 1,
    patients: [{ id: 'p', before: structuredClone(patient), after }],
    services: [],
  };
  const strategy = createAppointmentPatchMutation(body);
  assert.ok(strategy);
  assert.equal(strategy.receiptBody, body);
  const next = strategy.build(
    { role: 'owner' },
    { revision: 2, patients: [patient], services: [] },
  );
  assert.equal(next.patients[0].visits, patient.visits);
  assert.equal(next.patients[0].appointments[0].notes, 'After');
  const changed = structuredClone(patient);
  changed.visits[0].notes = 'Concurrent history edit';
  assert.throws(
    () => strategy.build({ role: 'owner' }, { revision: 2, patients: [changed], services: [] }),
    (error) => error.status === 409,
  );
  const mixed = structuredClone(body);
  mixed.patients[0].after.visits[0].notes = 'Mixed edit';
  assert.equal(createAppointmentPatchMutation(mixed), null);
});

function narrowBody(store, legacy = false) {
  const before = store.readSelected(['p']).patients[0], after = structuredClone(before);
  after.appointments[0].notes = 'Delta write';
  if (legacy) return { revision: store.get('revision'), patients: [{ id: 'p', before, after }], services: [] };
  return { revision: store.get('revision'), patientId: 'p', changes: [{ id: 'a', before: before.appointments[0], after: after.appointments[0] }] };
}
function snapshotStrategy(store, body, legacy = false) {
  const strategy = legacy ? createAppointmentPatchMutation(body) : require('../src/server/modules/cabinet/appointment-commands.cjs').createAppointmentMutation(body);
  const before = store.readAppointmentMutation(strategy.appointmentRead, { role: 'owner' });
  if (before) strategy.acceptCompact(before);
  return { strategy, before };
}
test('schema2 typed appointment snapshot never hydrates history before point write; full reply reads it once', (t) => {
  const store = fixture(t, 2), body = narrowBody(store);
  const history = store.db.prepare("SELECT value FROM cabinet_patient_records WHERE kind='visit'").all();
  const ivs = new Set(history.map(({ value }) => Buffer.from(value).subarray(0, 12).toString('hex'))),
    original = crypto.createDecipheriv;
  let decoded = 0;
  crypto.createDecipheriv = function (algorithm, key, iv, ...rest) {
    if (ivs.has(Buffer.from(iv).toString('hex'))) decoded++;
    return original.call(this, algorithm, key, iv, ...rest);
  };
  try {
    store.transaction(() => {
      const { strategy, before } = snapshotStrategy(store, body);
      assert.ok(before);
      assert.equal(before.patients[0].visits.length, 0);
      assert.equal(decoded, 0);
      const next = strategy.build({ role: 'owner' }, before);
      const saved = store.write(next, { insideTransaction: true, changedIds: strategy.changedIds, preparedBefore: before });
      assert.equal(decoded, 30);
      assert.equal(saved.patients[0].visits.length, 30);
      assert.equal(saved.patients[0].appointments[0].notes, 'Delta write');
      assert.throws(() => store.write(next, { insideTransaction: true, changedIds: strategy.changedIds, preparedBefore: before }), /no longer current/);
    });
  } finally { crypto.createDecipheriv = original; }
  assert.deepEqual(store.db.prepare("SELECT value FROM cabinet_patient_records WHERE kind='visit'").all(), history);
});
test('legacy schema2 appointment PATCH verifies full history CAS in batches and never hydrates it again for write/reply', (t) => {
  const store = fixture(t, 2), body = narrowBody(store, true),
    unchanged = store.db.prepare("SELECT kind,id,position,value FROM cabinet_patient_records WHERE kind='visit'").all(),
    oldSummary = store.indexes.summaries({ role: 'owner' }, ['p'])[0];
  store.transaction(() => {
    const { strategy, before } = snapshotStrategy(store, body, true);
    assert.ok(before);
    const next = strategy.build({ role: 'owner' }, before);
    withNoPatientDecrypt(store, 2, () => {
      const saved = store.write(next, { insideTransaction: true, changedIds: strategy.changedIds, preparedBefore: before });
      assert.equal(saved.patients[0].visits, body.patients[0].before.visits);
      assert.equal(saved.patients[0].visits.length, 30);
    });
  });
  assert.deepEqual(store.db.prepare("SELECT kind,id,position,value FROM cabinet_patient_records WHERE kind='visit'").all(), unchanged);
  const summary = store.indexes.summaries({ role: 'owner' }, ['p'])[0];
  assert.equal(summary.visitCount, oldSummary.visitCount);
  assert.deepEqual(summary.lastVisit, oldSummary.lastVisit);
  const stale = narrowBody(store, true);
  stale.patients[0].before.visits[0].notes = 'Not actual before';
  stale.patients[0].after.visits[0].notes = 'Not actual before';
  stale.patients[0].after.appointments[0].notes = 'Another delta';
  assert.throws(() => store.transaction(() => snapshotStrategy(store, stale, true)), (error) => error.status === 409);
});
test('compact point writer rejects stale snapshots, profile/history changes; schema1/staff/completed retain full path', (t) => {
  const store = fixture(t, 2), body = narrowBody(store);
  let previous;
  store.transaction(() => { previous = snapshotStrategy(store, body); });
  assert.throws(() => store.transaction(() => store.write(previous.strategy.build({ role: 'owner' }, previous.before), { insideTransaction: true, changedIds: previous.strategy.changedIds, preparedBefore: previous.before })), /no longer current/);
  store.transaction(() => {
    const { strategy, before } = snapshotStrategy(store, body);
    const next = strategy.build({ role: 'owner' }, before);
    next.patients[0].name = 'Forbidden profile edit';
    assert.throws(() => store.write(next, { insideTransaction: true, changedIds: strategy.changedIds, preparedBefore: before }), /cannot change profile/);
  });
  const descriptor = require('../src/server/modules/cabinet/appointment-commands.cjs').createAppointmentMutation(body).appointmentRead;
  store.transaction(() => {
    assert.equal(store.readAppointmentMutation(descriptor, { role: 'cosmetologist' }), null);
    assert.equal(store.readAppointmentMutation({ ...descriptor, changes: [{ before: null, after: { status: 'completed' } }] }, { role: 'owner' }), null);
  });
  const legacy = fixture(t, 1);
  legacy.transaction(() => assert.equal(legacy.readAppointmentMutation(descriptor, { role: 'owner' }), null));
});

test('appointment delta never prunes photo ACL/active refs or rewrites history on reassignment/removal', (t) => {
  const store=fixture(t,2), photo=store.db.prepare('SELECT id,mime,active FROM photos').all(),
    refs=store.db.prepare('SELECT photo_id,patient_id,audience FROM cabinet_photo_refs').all(),
    counts=store.db.prepare('SELECT patient_id,photo_count FROM cabinet_patient_counts').all(),
    visits=store.db.prepare("SELECT id,position,value FROM cabinet_patient_records WHERE kind='visit'").all();
  const body=narrowBody(store);
  body.changes[0].after.staffId='other';
  store.transaction(()=>{
    const {strategy,before}=snapshotStrategy(store,body);
    store.write(strategy.build({role:'owner'},before),{insideTransaction:true,changedIds:strategy.changedIds,preparedBefore:before});
  });
  assert.equal(store.indexes.summaries({role:'cosmetologist',accountId:'other'},['p'])[0].visitCount,0);
  const before=store.readSelected(['p']).patients[0].appointments[0];
  const remove=require('../src/server/modules/cabinet/appointment-commands.cjs').createAppointmentMutation({revision:store.get('revision'),patientId:'p',changes:[{id:'a',before,after:null}]});
  store.transaction(()=>{
    const snapshot=store.readAppointmentMutation(remove.appointmentRead,{role:'owner'});remove.acceptCompact(snapshot);
    store.write(remove.build({role:'owner'},snapshot),{insideTransaction:true,changedIds:remove.changedIds,preparedBefore:snapshot});
  });
  assert.equal(store.indexes.summaries({role:'cosmetologist',accountId:'other'},['p']).length,0);
  assert.deepEqual(store.db.prepare('SELECT id,mime,active FROM photos').all(),photo);
  assert.deepEqual(store.db.prepare('SELECT photo_id,patient_id,audience FROM cabinet_photo_refs').all(),refs);
  assert.deepEqual(store.db.prepare('SELECT patient_id,photo_count FROM cabinet_patient_counts').all(),counts);
  assert.deepEqual(store.db.prepare("SELECT id,position,value FROM cabinet_patient_records WHERE kind='visit'").all(),visits);
  assert.equal(store.indexes.photoVisible('f'.repeat(32),{accountId:'owner'}),true);
});
test('an active appointment backlink cannot enter canonical history through the full writer', (t)=>{
  const store=fixture(t,2), before=store.readSelected(['p']);
  before.patients[0].visits[0].appointmentId='a';
  assert.throws(()=>store.write(before,{changedIds:{patients:['p'],services:[]}}),error=>error.status===400);
  assert.equal(store.readSelected(['p']).patients[0].visits[0].appointmentId,undefined);
});
