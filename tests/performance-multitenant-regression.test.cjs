const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('../storage.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const { createTenantPool } = require('../src/server/infrastructure/tenant-pool.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const { createSessions } = require('../src/server/modules/auth/sessions.cjs');
function laboratory(t, maxBytes = 1000000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-multitenant-regression-'));
  const budget = createReadCacheBudget({ maxBytes }),
    stores = [];
  t.after(() => {
    for (const store of stores) if (store.db.isOpen) store.close();
    assert.equal(budget.stats().bytes, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    budget,
    open(id) {
      const store = createStorage(path.join(root, id), { readCacheBudget: budget });
      stores.push(store);
      return store;
    },
  };
}
const appointment = (id, staffId = 'staff-a') => ({
  id,
  date: '2030-01-01',
  time: '23:45',
  duration: 30,
  staffId,
  service: 'Synthetic',
});
const patient = (id, name) => ({
  id,
  name,
  phone: '+79990000001',
  createdBy: 'owner',
  visits: [],
  appointments: [appointment(id + '-a')],
});
const current = (organizationId, role = 'owner', accountId = 'owner') => ({
  organizationId,
  role,
  accountId,
});
const url = new URL('http://synthetic/?today=2030-01-01');
function save(store, patients, ids = patients.map((row) => row.id), extra = {}) {
  return store.write(
    { revision: store.get('revision'), patients, services: [] },
    { changedIds: { patients: ids, services: [] }, ...extra },
  );
}
test('budget eviction, cross-connection refresh and reopen never reuse another tenant or staff projection', (t) => {
  const lab = laboratory(t, 2200),
    a = lab.open('a'),
    b = lab.open('b');
  for (const [store, name] of [
    [a, 'Tenant A'],
    [b, 'Tenant B'],
  ]) {
    const record = patient('same-id', name);
    record.appointments.push(appointment('same-id-b', 'staff-b'));
    store.write({
      revision: 0,
      patients: [record],
      services: [{ id: 'same-service', name, duration: '30', price: 0 }],
    });
  }
  for (let round = 0; round < 4; round++) {
    for (const [store, org, name] of [
      [a, 'a', 'Tenant A'],
      [b, 'b', 'Tenant B'],
    ]) {
      assert.equal(directoryPage(store, current(org), url).directory[0].name, name);
      assert.deepEqual(
        directoryPage(
          store,
          current(org, 'cosmetologist', 'staff-a'),
          url,
        ).directory[0].appointments.map((row) => row.id),
        ['same-id-a'],
      );
      assert.deepEqual(
        directoryPage(
          store,
          current(org, 'cosmetologist', 'staff-b'),
          url,
        ).directory[0].appointments.map((row) => row.id),
        ['same-id-b'],
      );
      assert.equal(store.readServices()[0].name, name);
      assert.ok(lab.budget.stats().bytes <= 2200);
    }
  }
  assert.ok(lab.budget.stats().evictions > 0);
  const otherConnection = lab.open('a'),
    changed = otherConnection.readSelected(['same-id']).patients[0];
  changed.name = 'Fresh tenant A';
  changed.appointments = changed.appointments.filter((row) => row.staffId !== 'staff-a');
  save(otherConnection, [changed]);
  assert.equal(directoryPage(a, current('a'), url).directory[0].name, 'Fresh tenant A');
  assert.equal(directoryPage(a, current('a', 'cosmetologist', 'staff-a'), url).directory.length, 0);
  a.close();
  const reopened = lab.open('a');
  assert.equal(directoryPage(reopened, current('a'), url).directory[0].name, 'Fresh tenant A');
  otherConnection.close();
  assert.equal(directoryPage(reopened, current('a'), url).directory[0].name, 'Fresh tenant A');
  assert.equal(directoryPage(b, current('b'), url).directory[0].name, 'Tenant B');
});
test('leased tenant survives pool pressure and failed close remains accounted until retry', () => {
  let fail = true;
  const pool = createTenantPool({
    limit: 1,
    open(id) {
      return {
        id,
        close() {
          if (id === 'a' && fail) throw Error('Synthetic close error');
        },
      };
    },
  });
  const a = pool.lease(),
    b = pool.lease();
  assert.equal(a.get('a').id, 'a');
  assert.equal(b.get('b').id, 'b');
  assert.equal(pool.stats().connections, 2);
  assert.equal(pool.stats().pinned, 2);
  assert.throws(() => a.release(), /Synthetic close error/);
  assert.equal(pool.stats().connections, 2);
  assert.equal(pool.stats().closeErrors, 1);
  assert.equal(b.get('b').id, 'b');
  fail = false;
  b.release();
  assert.equal(pool.stats().connections, 1);
  assert.equal(pool.stats().closes, 1);
  pool.close();
  assert.equal(pool.stats().connections, 0);
});
test('appointment-only delta preserves photo visibility and bounded SQL writes regardless of visit history', async (t) => {
  const lab = laboratory(t),
    store = lab.open('delta');
  const png = await require('sharp')({
    create: { width: 1, height: 1, channels: 3, background: '#aabbcc' },
  })
    .png()
    .toBuffer();
  const record = patient('one', 'Synthetic');
  record.visits = Array.from({ length: 250 }, (_, index) => ({
    id: 'v-' + index,
    date: '2020-01-01',
    procedure: 'Synthetic',
    staffId: 'staff-a',
    photos: index ? [] : [{ data: 'data:image/png;base64,' + png.toString('base64') }],
  }));
  record.appointments.push(appointment('unchanged'));
  store.write({ revision: 0, patients: [record], services: [] });
  const state = store.readSelected(['one']).patients[0],
    photoId = state.visits[0].photos[0].data.split('/').pop();
  const refs = store.db.prepare('SELECT rowid,* FROM cabinet_photo_refs').all();
  const visits = store.db
    .prepare("SELECT rowid,* FROM cabinet_record_ids WHERE kind='visit'")
    .all();
  const unchanged = store.db
    .prepare("SELECT value FROM cabinet_appointments WHERE id='unchanged'")
    .get().value;
  state.appointments[0].staffId = 'staff-b';
  state.appointments[0].duration = 5;
  save(store, [state]);
  assert.deepEqual(store.db.prepare('SELECT rowid,* FROM cabinet_photo_refs').all(), refs);
  assert.deepEqual(
    store.db.prepare("SELECT rowid,* FROM cabinet_record_ids WHERE kind='visit'").all(),
    visits,
  );
  assert.deepEqual(
    store.db.prepare("SELECT value FROM cabinet_appointments WHERE id='unchanged'").get().value,
    unchanged,
  );
  assert.equal(store.indexes.photoVisible(photoId, { accountId: 'staff-a' }), true);
  assert.equal(store.indexes.photoVisible(photoId, { accountId: 'staff-b' }), false);
  assert.ok(
    !store.calendarSnapshot('2030-01-02', '2030-01-02', { staffId: 'staff-b' }).appointments.length,
  );
  const beforeSql = store.statementStats().misses;
  const changes = () => store.db.prepare('SELECT total_changes() n').get().n;
  const beforeChanges = changes();
  state.appointments[0].notes = 'Only one indexed appointment changes';
  save(store, [state]);
  assert.equal(
    store.statementStats().misses,
    beforeSql,
    'Same mutation shape reuses prepared statements',
  );
  const updatedRows = changes() - beforeChanges;
  assert.ok(updatedRows <= 20, '250 historical visits must not be rewritten');
  t.diagnostic(
    'One appointment edit with 250 visits: SQL changed rows=' +
      updatedRows +
      ', new prepared statements=' +
      (store.statementStats().misses - beforeSql),
  );
  state.visits[0].staffId = 'staff-b';
  save(store, [state]);
  assert.equal(store.indexes.photoVisible(photoId, { accountId: 'staff-a' }), false);
  assert.equal(store.indexes.photoVisible(photoId, { accountId: 'staff-b' }), true);
  assert.equal(store.photo(photoId).mime, 'image/png');
});
test('mixed full/delta move, deletion and rollback leave no ghost appointment dates or contacts', (t) => {
  const lab = laboratory(t),
    store = lab.open('moves');
  store.write({
    revision: 0,
    patients: [patient('one', 'First'), patient('two', 'Second')],
    services: [],
  });
  const [one, two] = store.readSelected(['one', 'two']).patients;
  two.appointments.push(one.appointments.pop());
  two.name = 'Changed contact';
  two.phone = '+79990000002';
  save(store, [one, two]);
  const moved = store
    .calendarSnapshot('2030-01-01', '2030-01-02')
    .appointments.find((row) => row.id === 'one-a');
  assert.equal(moved.patientId, 'two');
  assert.equal(moved.patientPhone, '+79990000002');
  const snapshot = store.read(),
    indexes = store.db.prepare('SELECT * FROM cabinet_appointments ORDER BY id').all();
  two.appointments = [];
  assert.throws(
    () =>
      store.transaction(() => {
        save(store, [two], undefined, { insideTransaction: true });
        throw Error('Synthetic rollback');
      }),
    /Synthetic rollback/,
  );
  assert.deepEqual(store.read(), snapshot);
  assert.deepEqual(
    store.db.prepare('SELECT * FROM cabinet_appointments ORDER BY id').all(),
    indexes,
  );
  save(store, [], ['two']);
  assert.equal(store.calendarSnapshot('2030-01-01', '2030-01-02').appointments.length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM cabinet_days').get().n, 0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
test('prepared session queries see role changes and revocation committed by another connection', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-session-prepare-'));
  const file = path.join(root, 'synthetic.sqlite'),
    db = new DatabaseSync(file),
    other = new DatabaseSync(file);
  t.after(() => {
    other.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE platform_sessions(token_hash TEXT,id TEXT,account_id TEXT,organization_id TEXT,expires_at INTEGER,value TEXT DEFAULT '{}');
    CREATE TABLE accounts(id TEXT,value TEXT,global_admin INTEGER,status TEXT);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT);
    CREATE TABLE organizations(id TEXT,status TEXT);`);
  db.prepare('INSERT INTO accounts VALUES(?,?,0,?)').run(
    'account',
    JSON.stringify({ email: 'synthetic@example.test', displayName: 'Synthetic' }),
    'active',
  );
  db.prepare('INSERT INTO organizations VALUES(?,?)').run('org', 'active');
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('org', 'account', 'owner', 'active');
  db.prepare('INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,expires_at) VALUES(?,?,?,?,?)').run(
    'token',
    'session',
    'account',
    'org',
    Date.now() + 60000,
  );
  const originalPrepare = db.prepare.bind(db);
  let selected = 0;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (/^SELECT/.test(sql.trim())) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        selected++;
        return get(...args);
      };
    }
    return statement;
  };
  const { session } = createSessions({ db, open: JSON.parse, tokenHash: (value) => value, crypto });
  const read = () => {
    const before = selected,
      current = session('token');
    assert.equal(selected - before, 1, 'each authority check executes one fresh joined SELECT');
    return current;
  };
  assert.equal(read().role, 'owner');
  other.exec("UPDATE memberships SET role='cosmetologist'");
  assert.equal(read().role, 'cosmetologist');
  other.prepare('UPDATE accounts SET value=?,global_admin=1').run(
    JSON.stringify({ email: 'new@example.test', displayName: 'Changed synthetic name' }),
  );
  const renamed = read();
  assert.equal(renamed.email, 'new@example.test');
  assert.equal(renamed.displayName, 'Changed synthetic name');
  assert.equal(renamed.globalAdmin, true);
  other.exec("UPDATE memberships SET status='disabled'");
  assert.equal(read(), null);
  other.exec("UPDATE memberships SET status='active'; UPDATE organizations SET status='disabled'");
  assert.equal(read(), null);
  other.exec("UPDATE organizations SET status='active'; UPDATE accounts SET status='disabled'");
  assert.equal(read(), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM platform_sessions').get().n, 0);
});
test('501 calendar contacts use bounded batches, exact staff filtering and no contact reads for occupancy', (t) => {
  const lab = laboratory(t),
    store = lab.open('calendar');
  const patients = Array.from({ length: 501 }, (_, index) => {
    const record = patient('p-' + index, 'Synthetic ' + index);
    record.appointments[0].staffId = index % 2 ? 'staff-b' : 'staff-a';
    return record;
  });
  store.write({ revision: 0, patients, services: [] });
  const prepare = store.db.prepare.bind(store.db),
    batches = [];
  store.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (/^SELECT.*FROM cabinet_summaries /.test(sql)) {
      for (const method of ['all', 'get']) {
        const execute = statement[method].bind(statement);
        statement[method] = (...args) => {
          batches.push({ sql, args });
          return execute(...args);
        };
      }
    }
    return statement;
  };
  const occupancy = store.calendarSnapshot('2030-01-01', '2030-01-02', {
    includeNames: false,
  }).appointments;
  assert.equal(occupancy.length, 501);
  assert.equal(batches.length, 0);
  assert.ok(
    occupancy.every((row) => row.patientName === undefined && row.patientPhone === undefined),
  );
  const named = store.calendarSnapshot('2030-01-01', '2030-01-02').appointments;
  assert.equal(named.length, 501);
  assert.equal(batches.length, 3);
  assert.ok(batches.every((batch) => JSON.parse(batch.args[0]).length <= 200));
  const misses = store.statementStats().misses;
  batches.length = 0;
  store.calendarSnapshot('2030-01-01', '2030-01-02');
  assert.equal(batches.length, 3);
  assert.equal(store.statementStats().misses, misses);
  batches.length = 0;
  const staff = store.calendarSnapshot('2030-01-01', '2030-01-02', {
    staffId: 'staff-a',
  }).appointments;
  assert.equal(staff.length, 251);
  assert.equal(batches.length, 2);
  assert.ok(
    batches
      .flatMap((batch) => JSON.parse(batch.args[0]))
      .every((id) => Number(id.slice(2)) % 2 === 0),
  );
  const changed = store.readSelected(['p-0']).patients[0];
  changed.phone = '+79990000099';
  save(store, [changed]);
  const fresh = store
    .calendarSnapshot('2030-01-01', '2030-01-02')
    .appointments.find((row) => row.patientId === 'p-0');
  assert.equal(fresh.patientPhone, '+79990000099');
  t.diagnostic(
    'Calendar contacts: 501 patients=3 SQL batches; 251 staff-visible patients=2; occupancy=0 contact reads',
  );
});
test('selected cards and services retain ordered duplicate semantics in 200-ID batches and after rollback', (t) => {
  const lab = laboratory(t),
    store = lab.open('selected');
  store.write({
    revision: 0,
    patients: Array.from({ length: 501 }, (_, index) =>
      patient('p-' + index, 'Synthetic ' + index),
    ),
    services: Array.from({ length: 501 }, (_, index) => ({
      id: 's-' + index,
      name: 'Service ' + index,
      duration: '30',
      price: index,
    })),
  });
  const snapshot = store.read(),
    order = Array.from({ length: 501 }, (_, index) => (index * 113) % 501);
  order[200] = order[199];
  order[400] = order[399];
  const patientIds = order.map((index) => 'p-' + index),
    serviceIds = order.map((index) => 's-' + index);
  patientIds[250] = 'missing-patient';
  serviceIds[250] = 'missing-service';
  const expected = (rows, ids) => {
    const map = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => (map.has(id) ? [map.get(id)] : []));
  };
  const prepare = store.db.prepare.bind(store.db),
    batches = [];
  store.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (/^SELECT selected\.(?:id,\s*selected\.)?value FROM json_each\(\?\)/.test(sql)) {
      const execute = statement.all.bind(statement);
      statement.all = (...args) => {
        batches.push({ sql, ids: JSON.parse(args[0]) });
        return execute(...args);
      };
    }
    return statement;
  };
  const selected = store.readSelected(patientIds, serviceIds);
  assert.deepEqual(selected.patients, expected(snapshot.patients, patientIds));
  assert.deepEqual(selected.services, expected(snapshot.services, serviceIds));
  for (const table of ['patients', 'services']) {
    const reads = batches.filter((batch) => batch.sql.includes('JOIN ' + table + ' AS'));
    assert.equal(reads.length, 3);
    assert.deepEqual(
      reads.map((batch) => batch.ids.length),
      [200, 200, 101],
    );
  }
  const beforePrepare = store.statementStats().misses;
  assert.deepEqual(store.readSelected(patientIds, serviceIds), selected);
  assert.equal(store.statementStats().misses, beforePrepare);
  assert.equal(store.readSelected().patients.length, 0);
  assert.equal(store.readSelected(['missing-patient'], ['missing-service']).services.length, 0);
  assert.deepEqual(store.readSelected([patientIds[0]], [serviceIds[0]]).patients, [
    selected.patients[0],
  ]);
  const changedPatient = structuredClone(selected.patients[0]),
    changedService = structuredClone(selected.services[0]);
  changedPatient.name = 'Transactional patient';
  changedService.name = 'Transactional service';
  const writeChanges = (insideTransaction = false) =>
    store.write(
      {
        revision: store.get('revision'),
        patients: [changedPatient],
        services: [changedService],
      },
      {
        changedIds: { patients: [changedPatient.id], services: [changedService.id] },
        insideTransaction,
      },
    );
  assert.throws(
    () =>
      store.transaction(() => {
        writeChanges(true);
        const inside = store.readSelected(patientIds, serviceIds);
        assert.equal(inside.patients[0].name, 'Transactional patient');
        assert.equal(inside.services[0].name, 'Transactional service');
        throw Error('Synthetic selected rollback');
      }),
    /Synthetic selected rollback/,
  );
  assert.deepEqual(store.readSelected(patientIds, serviceIds), selected);
  writeChanges();
  const committed = store.readSelected(patientIds, serviceIds);
  assert.equal(committed.patients[0].name, 'Transactional patient');
  assert.equal(committed.services[0].name, 'Transactional service');
  t.diagnostic(
    'Selected records: 501 requested IDs = 3 SELECTs per table; order, boundary duplicates and rollback retained',
  );
});
