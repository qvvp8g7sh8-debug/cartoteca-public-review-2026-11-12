const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { createStorage } = require('../storage.cjs'),
  { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
const { migrateCabinetIndexes } = require('../src/server/migrations/001-cabinet-indexes.cjs');
const { DatabaseSync } = require('node:sqlite');
const { JSDOM, VirtualConsole } = require('jsdom');
const patient = (id, staff) => ({
  id,
  name: 'Synthetic ' + id,
  phone: 'Test phone',
  createdBy: staff,
  allergies: 'PRIVATE ALLERGIES',
  notes: 'PRIVATE NOTES',
  visits: [
    {
      id: 'visit-' + id,
      date: '2020-01-01',
      staffId: staff,
      procedure: 'Test procedure',
      notes: 'PRIVATE HISTORY',
      photos: [],
    },
  ],
  appointments: [
    {
      id: 'appointment-' + id,
      date: '2030-01-01',
      time: '23:45',
      duration: 60,
      service: 'Test service',
      staffId: staff,
    },
  ],
});
function storageFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-query-')),
    store = createStorage(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}
test('encrypted indexes support staff summaries, cross-midnight range, record uniqueness and transactional rollback', (t) => {
  const { store } = storageFixture(t),
    patients = [patient('one', 'staff1'), patient('two', 'staff2')];
  store.write({ revision: 0, patients, services: [] });
  const summary = store.indexes.summaries({ role: 'cosmetologist', accountId: 'staff1' });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].id, 'one');
  assert.equal(summary[0].visitCount, 1);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|allergies|photos|staff2/);
  assert.equal(store.indexes.appointments('2030-01-02', '2030-01-02').length, 2);
  assert.equal(store.indexes.appointments('2029-12-31', '2029-12-31').length, 0);
  assert.throws(
    () => store.indexes.assertUnique([{ ...patients[0], visits: patients[1].visits }], ['one']),
    /уникальными/,
  );
  const before = store.read();
  assert.throws(
    () =>
      store.transaction(() => {
        store.write(
          {
            revision: before.revision,
            patients: [{ ...patients[0], name: 'Rollback' }],
            services: [],
          },
          { insideTransaction: true, changedIds: { patients: ['one'], services: [] } },
        );
        throw Error('Synthetic rollback');
      }),
    /rollback/,
  );
  assert.deepEqual(store.read(), before);
  assert.equal(
    store.indexes.summaries({ role: 'owner' }).find((p) => p.id === 'one').name,
    patients[0].name,
  );
  assert.throws(() => store.transaction(() => Promise.resolve()), /Asynchronous/);
  for (const table of ['cabinet_summaries', 'cabinet_appointments'])
    for (const row of store.db.prepare('SELECT value FROM ' + table).all())
      assert.doesNotMatch(
        Buffer.from(row.value).toString(),
        /Synthetic|Test service|2030-01-01|PRIVATE/,
      );
  for (const row of store.db.prepare('SELECT day_hash FROM cabinet_days').all())
    assert.match(row.day_hash, /^[a-f0-9]{64}$/);
});
test('calendar contacts are current read-only projections and occupancy remains anonymous', (t) => {
  const { store } = storageFixture(t),
    one = { ...patient('one', 'staff1'), phone: '+79001234567' },
    two = { ...patient('two', 'staff2'), phone: '+37499123456' };
  store.write({ revision: 0, patients: [one, two], services: [] });
  const scoped = store.calendarSnapshot('2030-01-01', '2030-01-02', {
    staffId: 'staff1',
  }).appointments;
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].patientPhone, one.phone);
  assert.doesNotMatch(JSON.stringify(scoped), /PRIVATE|\+37499123456/);
  const occupancy = store.calendarSnapshot('2030-01-01', '2030-01-02', {
    includeNames: false,
  }).appointments;
  assert.doesNotMatch(
    JSON.stringify(occupancy),
    /patientPhone|patientName|Synthetic|79001234567|37499123456/,
  );
  one.phone = '+79007654321';
  store.write(
    { revision: store.read().revision, patients: [one], services: [] },
    { changedIds: { patients: ['one'], services: [] } },
  );
  assert.equal(
    store.calendarSnapshot('2030-01-01', '2030-01-02', { staffId: 'staff1' }).appointments[0]
      .patientPhone,
    one.phone,
  );
  assert.equal(store.readSelected(['one']).patients[0].appointments[0].patientPhone, undefined);
  assert.equal(store.readSelected(['two']).patients[0].phone, two.phone);
});

test('partial mutation reads only selected rows, enforces global quotas and does not decrypt unrelated history', async (t) => {
  const { store } = storageFixture(t),
    patients = Array.from({ length: 100 }, (_, i) => patient('p' + i, 'owner'));
  store.write({ revision: 0, patients, services: [] });
  store.read = () => {
    throw Error('Whole cabinet read forbidden');
  };
  const current = { organizationId: 'org', accountId: 'owner', role: 'owner' };
  const platform = {
    notificationChannels: { enabled: () => false },
    workspaceIdentities: () => [{ accountId: 'owner', role: 'owner', status: 'active' }],
    workSchedules: { assertChanges() {} },
    subscription: () => ({ status: 'active', limits: { patients: 100, photos: 50 } }),
    withWriteLock: (fn) => fn(),
    session: () => current,
    assertWorkspaceSelection: () => {},
    assertServiceGroups() {},
    assertServiceCatalog() {},
    appointmentConfirmations: { invalidateChanges() {} },
    organizationTimeZone: () => 'Europe/Moscow',
  };
  const context = {
    current,
    platform,
    token: 'test',
    tenantStore: () => store,
    assertCurrent() {},
  };
  const p = store.readSelected(['p0']).patients[0],
    after = { ...p, notes: 'Changed' };
  const saved = await saveMutation(
    context,
    { revision: 0, patients: [{ id: p.id, before: p, after }], services: [] },
    { partial: true },
  );
  assert.equal(saved.patients.length, 1);
  assert.equal(store.readSelected(['p99']).patients[0].notes, 'PRIVATE NOTES');
  const added = { id: 'new', name: 'Synthetic', visits: [], appointments: [] };
  await assert.rejects(
    saveMutation(
      context,
      { revision: 0, patients: [{ id: 'new', before: null, after: added }], services: [] },
      { partial: true },
    ),
    (e) => e.status === 402,
  );
  const duplicate = { ...after, visits: [patients[99].visits[0]] };
  await assert.rejects(
    saveMutation(
      context,
      { revision: 0, patients: [{ id: p.id, before: after, after: duplicate }], services: [] },
      { partial: true },
    ),
    (e) => e.status === 400,
  );
});
test('migration creates a verified pre-index snapshot and preserves original encrypted rows', (t) => {
  const { store, dir } = storageFixture(t);
  store.write({ revision: 0, patients: [patient('p', 'owner')], services: [] });
  const original = store.db.prepare('SELECT value FROM patients').get().value;
  for (const table of [
    'cabinet_summaries',
    'cabinet_patient_counts',
    'cabinet_record_ids',
    'cabinet_appointments',
    'cabinet_days',
    'cabinet_photo_refs',
  ])
    store.db.exec('DROP TABLE ' + table);
  store.db.exec('PRAGMA user_version=0');
  assert.throws(
    () =>
      migrateCabinetIndexes({
        db: store.db,
        directory: dir,
        rebuild() {
          throw Error('Synthetic rebuild failure');
        },
      }),
    /rebuild failure/,
  );
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 0);
  assert.equal(
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cabinet_summaries'").get(),
    undefined,
  );
  migrateCabinetIndexes({ db: store.db, directory: dir, rebuild() {} });
  assert.deepEqual(store.db.prepare('SELECT value FROM patients').get().value, original);
  const backups = fs.readdirSync(path.join(dir, 'migration-backups'));
  assert.equal(backups.length, 2);
  for (const name of backups) {
    const snapshot = new DatabaseSync(path.join(dir, 'migration-backups', name, 'cabinet.sqlite'), {
      readOnly: true,
    });
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 0);
    assert.deepEqual(snapshot.prepare('SELECT value FROM patients').get().value, original);
    snapshot.close();
    assert.deepEqual(
      fs.readFileSync(path.join(dir, 'encryption.key')),
      fs.readFileSync(path.join(dir, 'migration-backups', name, 'encryption.key')),
    );
  }
});
test('bootstrap, selected card and calendar enforce organization and staff boundaries without loading clinical history', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-query-http-')),
    platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'query-owner@example.test',
    password: 'Query-test-password-2026',
    displayName: 'Test',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  const invitation = platform.createInvitation({
    organizationId: owner.organizationId,
    invitedBy: owner.accountId,
    role: 'cosmetologist',
  });
  const staff = await platform.acceptInvitation({
    token: invitation.token,
    email: 'query-staff@example.test',
    password: 'Query-test-password-2026',
    displayName: 'Test staff',
  });
  const other = await platform.registerOwner({
    email: 'query-other@example.test',
    password: 'Query-test-password-2026',
    displayName: 'Test',
    organizationName: 'Other',
  });
  platform.verifyEmail(other.verificationToken);
  await platform.bootstrapGlobalAdmin({
    email: 'query-admin@example.test',
    password: 'Query-test-password-2026',
    displayName: 'Test admin',
  });
  const storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  storage.write({
    revision: 0,
    patients: [patient('own', staff.accountId), patient('hidden', owner.accountId)],
    services: [],
  });
  const workspace = platform.workspaceSettings(owner.organizationId);
  // This scenario edits lazy cards, not occupancy: assign both specialists to separate protected rooms.
  platform.saveWorkspace(
    owner.organizationId,
    owner.accountId,
    {
      ...workspace,
      roomLayout: 'multiple',
      rooms: [
        workspace.rooms[0],
        { ...workspace.rooms[0], id: 'staff', name: 'Сотрудник', staffIds: [staff.accountId] },
      ],
    },
    () => storage.read(),
  );
  storage.close();
  platform.close();
  const windows = [],
    server = createMultiServer({ dataDir: dir, sendMail: null, telegramBot: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Closing JSDOM does not emit the browser pagehide event: stop/abort directory
  // refreshes through the real lifecycle before discarding the synthetic document.
  t.after(async () => {
    windows.forEach((w) => {
      w.dispatchEvent(new w.Event('pagehide'));
      w.close();
    });
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const authContexts = new Map();
  async function request(route, cookie = '', body) {
    const r = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Cookie: cookie,
        ...authContexts.get(cookie),
        Origin: base,
        'X-Cartoteca-Request': '1',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json(),
      nextCookie = r.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && r.status === 200)
      authContexts.set(nextCookie, authContextHeaders(data));
    return { status: r.status, data, cookie: nextCookie };
  }
  const cookies = [];
  for (const name of ['owner', 'staff', 'other', 'admin'])
    cookies.push(
      (
        await request('/api/auth/login', '', {
          email: 'query-' + name + '@example.test',
          password: 'Query-test-password-2026',
        })
      ).cookie,
    );
  const bootstrap = (await request('/api/cabinet/bootstrap', cookies[1])).data;
  assert.equal(bootstrap.lazyReads, true);
  assert.equal(bootstrap.patients.length, 0);
  assert.equal(bootstrap.directory.length, 1);
  assert.equal(bootstrap.directory[0].id, 'own');
  assert.doesNotMatch(JSON.stringify(bootstrap), /PRIVATE|hidden/);
  assert.match(
    JSON.stringify((await request('/api/cabinet/patient?id=own', cookies[1])).data),
    /PRIVATE HISTORY/,
  );
  assert.equal((await request('/api/cabinet/patient?id=hidden', cookies[1])).status, 404);
  assert.equal((await request('/api/cabinet/patient?id=own', cookies[2])).status, 404);
  assert.equal((await request('/api/cabinet/bootstrap', cookies[3])).status, 403);
  assert.equal((await request('/api/cabinet/bootstrap')).status, 401);
  const calendar = (
    await request('/api/cabinet/calendar?from=2030-01-01&to=2030-01-02', cookies[1])
  ).data;
  assert.equal(calendar.appointments.length, 1);
  assert.equal(calendar.appointments[0].patientId, 'own');
  assert.doesNotMatch(JSON.stringify(calendar), /PRIVATE HISTORY|hidden/);
  assert.equal(calendar.appointments[0].patientPhone, 'Test phone');
  assert.equal(
    (await request('/api/cabinet/calendar?from=2030-01-01&to=2030-01-02', cookies[3])).status,
    403,
  );
  assert.equal(
    (await request('/api/cabinet/calendar?from=2030-01-01&to=2031-01-01', cookies[0])).status,
    400,
  );
  assert.equal(
    (await request('/api/cabinet/calendar?from=2030-02-31&to=2030-03-02', cookies[0])).status,
    400,
  );
  const root = path.resolve(__dirname, '..');
  const until = async (fn) => {
    const deadline = Date.now() + 5000;
    while (!fn()) {
      if (Date.now() > deadline) throw Error('Lazy UI timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  for (const width of [390, 1440]) {
    const errors = [],
      calls = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e.message));
    const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
      url: base,
      runScripts: 'outside-only',
      virtualConsole: vc,
    }).window;
    windows.push(w);
    w.structuredClone = structuredClone;
    w.AbortController = AbortController;
    w.confirm = () => true;
    w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    w.fetch = (route, options = {}) => {
      calls.push(route);
      if (route === '/api/cabinet') throw Error('Full cabinet must not be loaded by lazy UI');
      return fetch(base + route, {
        ...options,
        headers: { ...options.headers, Origin: base, Cookie: cookies[0] },
      });
    };
    const $ = (selector) => w.document.querySelector(selector);
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    assert.ok(calls.some((url) => url.startsWith('/api/cabinet/bootstrap?paged=1')));
    assert.ok(calls.some((url) => url.startsWith('/api/cabinet/calendar?')));
    assert.ok(!calls.some((url) => url.startsWith('/api/cabinet/patient?')));
    $('[data-view="clients"]').click();
    $('[data-client-filter="all"]').click();
    await until(() => w.document.querySelectorAll('[data-patient]').length === 2);
    assert.equal(w.document.querySelectorAll('[data-patient]').length, 2);
    $('[data-patient="own"]').click();
    await until(() => $('#edit-patient'));
    assert.ok(calls.includes('/api/cabinet/patient?id=own'));
    $('#edit-patient').click();
    $('[name="notes"]').value = 'Saved lazy ' + width;
    $('#editor-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !$('#editor').open && !$('#save-editor').disabled);
    const saved = (await request('/api/cabinet', cookies[0])).data;
    assert.equal(saved.patients.length, 2);
    assert.equal(saved.patients.find((p) => p.id === 'hidden').notes, 'PRIVATE NOTES');
    assert.equal(saved.patients.find((p) => p.id === 'hidden').visits[0].notes, 'PRIVATE HISTORY');
    assert.equal(saved.patients.find((p) => p.id === 'own').notes, 'Saved lazy ' + width);
    assert.ok(!calls.includes('/api/cabinet'));
    assert.deepEqual(errors, []);
  }
});
