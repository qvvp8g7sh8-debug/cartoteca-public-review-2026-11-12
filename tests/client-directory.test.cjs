const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { createStorage } = require('../storage.cjs'),
  { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '..'),
  pad = (i) => String(i).padStart(3, '0');
const patients = Array.from({ length: 130 }, (_, i) => ({
  id: 'p' + pad(i),
  name: 'Имя' + pad(i) + ' Фамилия' + pad(129 - i),
  phone: '555' + pad(i),
  createdBy: i % 2 ? 'staff' : 'owner',
  visits: [],
  appointments: [],
}));
const {
  normalizePatientPhoneText,
  patientNameParts,
  patientMatchesSearch,
} = require('../src/shared/patient-names.cjs');
const { isActiveAppointment } = require('../src/shared/appointment-status.cjs');
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error('Directory UI timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('non-paged compatible directory also reveals 20 per click and resets for search/sort/filter', (t) => {
  const w = new JSDOM(
    '<input id="search"><span id="count"></span><span id="list-result-count"></span><div id="patient-list"></div>',
    { runScripts: 'outside-only' },
  ).window;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  t.after(() => w.close());
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/clients.js'), 'utf8'));
  const state = {
      account: { id: 'owner' },
      pagedReads: false,
      currentView: 'clients',
      patientSort: 'first',
      clientFilter: 'all',
      data: patients,
    },
    $ = (s) => w.document.querySelector(s);
  const actions = {
    $,
    normalizePatientPhoneText,
    directoryView: () => null,
    clientRecords: () => patients,
    cabinetToday: () => '2026-10-04',
    cabinetTodayDate: () => new Date('2026-10-04T00:00:00'),
    isoDate: () => '2026-10-04',
    plural: () => 'клиентов',
    esc: (s) => s,
    initials: () => 'И',
    patientMatchesSearch,
    isActiveAppointment,
    patientNameParts,
    patientFullName: (p) => p.name,
    patientDesignationHtml: () => '',
    countVisits: () => 0,
  };
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/client-contact.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'src/client/shared/format.js'), 'utf8'));
  Object.assign(actions, w.createFormat(state, actions));
  Object.assign(actions, w.createClientContact(state, actions));
  const module = w.createClients(state, actions),
    count = () => w.document.querySelectorAll('[data-patient]').length;
  module.renderList();
  assert.equal(count(), 20);
  $('#directory-more').click();
  assert.equal(count(), 40);
  assert.equal($('#list-result-count').textContent, 'В списке: 130 клиентов');
  $('#search').value = '555129';
  module.renderList();
  assert.equal(count(), 1);
  assert.equal($('#directory-more'), null);
  assert.equal($('[data-patient]').dataset.patient, 'p129');
  $('#search').value = '';
  module.renderList();
  assert.equal(count(), 20);
  $('#directory-more').click();
  state.patientSort = 'last';
  module.renderList();
  assert.equal(count(), 20);
  assert.equal($('[data-patient]').dataset.patient, 'p129');
  $('#directory-more').click();
  state.clientFilter = 'inactive';
  module.renderList();
  assert.equal(count(), 20);
  while ($('#directory-more')) $('#directory-more').click();
  assert.equal(count(), 130);
  const local = structuredClone(patients.slice(0, 5));
  local[0].appointments = [{ date: '2026-10-03' }];
  local[1].appointments = [{ date: '2026-09-04', status: 'scheduled' }];
  local[2].appointments = [{ date: '2026-10-05' }];
  local[3].appointments = [{ date: '2026-10-03', status: 'cancelled' }];
  local[4].appointments = [{ date: '2026-10-03', status: 'no_show' }];
  actions.clientRecords = () => local;
  actions.isoDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  state.patientSort = 'first';
  state.clientFilter = 'recent';
  module.renderList();
  assert.deepEqual(
    [...w.document.querySelectorAll('[data-patient]')].map((row) => row.dataset.patient),
    ['p000', 'p001'],
  );
  state.clientFilter = 'inactive';
  module.renderList();
  assert.deepEqual(
    [...w.document.querySelectorAll('[data-patient]')].map((row) => row.dataset.patient),
    ['p002', 'p003', 'p004'],
  );
});

test('more button requests are guarded while loading; failure preserves rows and can retry', async (t) => {
  const w = new JSDOM('<input id="search"><button id="directory-more"></button>', {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  w.AbortController = AbortController;
  w.eval(fs.readFileSync(path.join(root, 'src/client/core/client-directory.js'), 'utf8'));
  const state = {
      account: { id: 'owner' },
      pagedReads: true,
      patientSort: 'first',
      clientFilter: 'all',
      currentView: 'clients',
      directory: patients.slice(0, 20),
    },
    requests = [];
  const actions = {
      $: (s) => w.document.querySelector(s),
      cabinetToday: () => '2026-10-04',
      renderList: () => {},
      request: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    },
    module = w.createClientDirectory(state, actions);
  module.initializeDirectory({
    nextCursor: 'next',
    total: 130,
    matched: 130,
    counts: { all: 130 },
  });
  const loading = module.loadDirectoryMore();
  await module.loadDirectoryMore();
  assert.equal(requests.length, 1);
  assert.equal(module.directoryView().loading, true);
  requests[0].reject(Error('Synthetic network error'));
  await loading;
  assert.equal(state.directory.length, 20);
  assert.equal(module.directoryView().error, 'Synthetic network error');
  const retry = module.loadDirectoryMore();
  assert.equal(requests[1].url, requests[0].url);
  requests[1].resolve({
    directory: patients.slice(20, 40),
    nextCursor: 'next2',
    total: 130,
    matched: 130,
    counts: { all: 130 },
  });
  await retry;
  assert.equal(state.directory.length, 40);
  assert.equal(module.directoryView().error, '');
  assert.equal(module.directoryView().more, true);
});
test('directory pages/search/sort/filter are scoped, authenticated and reject stale or altered continuation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-directory-test-')),
    storage = createStorage(dir);
  t.after(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const data = structuredClone(patients);
  data[0].visits = [
    { id: 'v', date: '2026-10-01', procedure: 'Recent', staffId: 'owner', photos: [] },
  ];
  data[1].appointments = [
    { id: 'a', date: '2030-01-01', time: '12:00', staffId: 'staff', duration: 30 },
  ];
  for (const [index, date, status] of [
    [2, '2026-10-03', 'scheduled'],
    [3, '2026-09-04', 'scheduled'],
    [4, '2026-09-03', 'scheduled'],
    [5, '2026-10-05', 'scheduled'],
    [6, '2026-10-03', 'cancelled'],
    [7, '2026-10-03', 'no_show'],
  ])
    data[index].appointments = [
      {
        id: 'a' + index,
        date,
        time: '12:00',
        staffId: index % 2 ? 'staff' : 'owner',
        duration: 30,
        status,
      },
    ];
  storage.write({ revision: 0, patients: data, services: [] });
  const owner = { accountId: 'owner', role: 'owner', organizationId: 'org' },
    staff = { accountId: 'staff', role: 'cosmetologist', organizationId: 'org' };
  const url = (params) =>
      new URL('http://test/directory?' + new URLSearchParams({ today: '2026-10-04', ...params })),
    page = (user, params = {}) => directoryPage(storage, user, url(params));
  const first = page(owner);
  assert.equal(first.directory.length, 60);
  assert.equal(first.total, 130);
  assert.deepEqual(first.counts, { all: 130, appointment: 2, recent: 3, inactive: 126 });
  assert.equal(first.directory[0].id, 'p000');
  const second = page(owner, { cursor: first.nextCursor }),
    last = page(owner, { cursor: second.nextCursor });
  assert.equal(second.directory.length, 60);
  assert.equal(last.directory.length, 10);
  assert.equal(last.nextCursor, null);
  assert.equal(
    new Set([...first.directory, ...second.directory, ...last.directory].map((p) => p.id)).size,
    130,
  );
  assert.equal(page(owner, { q: '555129' }).directory[0].id, 'p129');
  assert.equal(page(owner, { sort: 'last' }).directory[0].id, 'p129');
  assert.equal(page(owner, { filter: 'recent' }).directory[0].id, 'p000');
  assert.deepEqual(
    page(owner, { filter: 'recent' }).directory.map((row) => row.id),
    ['p000', 'p002', 'p003'],
  );
  assert.deepEqual(
    page(staff, { filter: 'recent' }).directory.map((row) => row.id),
    ['p003'],
  );
  assert.ok(
    !page(owner, { filter: 'inactive' }).directory.some((row) =>
      ['p002', 'p003', 'p004'].includes(row.id),
    ),
  );
  assert.equal(page(owner, { filter: 'appointment' }).directory[0].id, 'p001');
  assert.equal(page(staff).total, 65);
  assert.doesNotMatch(JSON.stringify(page(staff)), /p000|Recent/);
  assert.throws(
    () => page(staff, { cursor: first.nextCursor }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => page(owner, { q: 'changed', cursor: first.nextCursor }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => page(owner, { cursor: first.nextCursor + 'changed' }),
    (e) => e.status === 400,
  );
  assert.throws(
    () => page(owner, { today: '2026-02-31' }),
    (e) => e.status === 400,
  );
  storage.write({ revision: 1, patients: data, services: [] });
  assert.throws(
    () => page(owner, { cursor: first.nextCursor }),
    (e) => e.status === 409,
  );
  const picker = page(staff, { picker: '1' });
  assert.equal(picker.patients.length, 65);
  assert.deepEqual(Object.keys(picker.patients[0]).sort(), ['id', 'name', 'phone']);
});
test('mobile/desktop directory shows 20 per click, never auto-loads and searches across the full database', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-directory-http-')),
    platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'directory@example.test',
    password: 'Synthetic-directory-password',
    displayName: 'Test',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  platform.close();
  const directoryPatients = structuredClone(patients);
  directoryPatients[1].appointments = [
    { id: 'future', date: '2030-01-01', time: '12:00', duration: 30, staffId: owner.accountId },
  ];
  const storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  storage.write({ revision: 0, patients: directoryPatients, services: [] });
  storage.close();
  const server = createMultiServer({
      dataDir: dir,
      sendMail: null,
      telegramBot: null,
      telegramAutostart: false,
    }),
    windows = [];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    windows.forEach((w) => w.close());
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port,
    login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'directory@example.test',
        password: 'Synthetic-directory-password',
      }),
    }),
    cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/cabinet/directory')).status, 401);
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
    w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
    w.confirm = () => true;
    w.IntersectionObserver = class {
      constructor() {
        throw Error('Automatic directory loading is forbidden');
      }
    };
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    w.fetch = (route, options = {}) => {
      calls.push(route);
      assert.notEqual(route, '/api/cabinet');
      return fetch(base + route, {
        ...options,
        headers: { ...options.headers, Origin: base, Cookie: cookie },
      });
    };
    const $ = (s) => w.document.querySelector(s),
      count = () => w.document.querySelectorAll('[data-patient]').length;
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    $('[data-view="clients"]').click();
    await until(() => count() === 1);
    assert.equal($('[data-client-filter="appointment"]').classList.contains('active'), true);
    assert.equal($('#count').textContent, 'Всего: 130');
    assert.equal($('#list-result-count').textContent, 'В списке: 1 клиент');
    $('[data-client-filter="all"]').click();
    await until(() => count() === 20);
    assert.equal($('#list-result-count').textContent, 'В списке: 130 клиентов');
    const initialCalls = calls.length;
    w.dispatchEvent(new w.Event('scroll'));
    w.dispatchEvent(new w.Event('resize'));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(count(), 20);
    assert.equal(calls.length, initialCalls);
    for (const expected of [40, 60, 80, 100, 120, 130]) {
      assert.equal($('#directory-more').textContent, 'Показать ещё 20');
      $('#directory-more').click();
      assert.equal($('#directory-more').disabled, true);
      $('#directory-more').click();
      await until(() => count() === expected && !$('#directory-more')?.disabled);
    }
    assert.equal($('#directory-tail'), null);
    $('[data-client-filter="appointment"]').click();
    await until(() => count() === 1);
    $('#search').value = '555129';
    $('#search').dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => count() === 0);
    assert.equal($('[data-client-filter="appointment"]').classList.contains('active'), true);
    $('[data-client-filter="all"]').click();
    await until(() => count() === 1 && $('[data-patient="p129"]'));
    $('[data-patient="p129"]').click();
    await until(() => $('#edit-patient'));
    assert.match($('#detail').textContent, /Имя129/);
    assert.ok(calls.includes('/api/cabinet/patient?id=p129'));
    $('[data-view="clients"]').click();
    await until(() => count() === 20);
    $('#directory-more').click();
    await until(() => count() === 40);
    $('[data-patient-sort="last"]').click();
    await until(
      () => count() === 20 && $('#patient-list strong')?.textContent.startsWith('Фамилия000'),
    );
    assert.equal($('#patient-list [data-patient]').dataset.patient, 'p129');
    $('[data-client-filter="inactive"]').click();
    await until(() => count() === 20 && !$('#directory-more')?.disabled);
    assert.equal($('#list-result-count').textContent, 'В списке: 130 клиентов');
    $('[data-view="calendar"]').click();
    $('#calendar-new').click();
    await until(() => $('#appointment-patient'));
    assert.equal($('#appointment-patient').type, 'hidden');
    assert.ok($('#appointment-patient-add'));
    $('#appointment-patient-search').value = '555129';
    $('#appointment-patient-search').dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => $('[data-appointment-patient-index]'));
    $('[data-appointment-patient-index]').click();
    assert.equal($('#appointment-patient').value, 'p129');
    assert.equal($('#appointment-patient-search').value, 'Имя129 Фамилия000');
    $('#cancel-editor').click();
    assert.ok(calls.some((route) => route.startsWith('/api/cabinet/directory?q=555129')));
    assert.ok(!calls.includes('/api/cabinet/directory?picker=1'));
    assert.deepEqual(errors, []);
    assert.ok(
      calls
        .filter((route) => route.startsWith('/api/cabinet/directory?'))
        .every(
          (route) =>
            new URL(base + route).searchParams.get('limit') === '20' ||
            new URL(base + route).searchParams.get('limit') === '10',
        ),
    );
  }
});
test('late searches cannot replace a newer query; changed revisions restart continuation without duplicates', async (t) => {
  const w = new JSDOM('<input id="search"><div id="directory-tail"></div>', {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  w.AbortController = AbortController;
  w.eval(fs.readFileSync(path.join(root, 'src/client/core/client-directory.js'), 'utf8'));
  const state = {
      account: { id: 'owner' },
      pagedReads: true,
      patientSort: 'first',
      clientFilter: 'all',
      currentView: 'clients',
      directory: [],
    },
    requests = [];
  let renders = 0;
  const actions = {
      $: (s) => w.document.querySelector(s),
      cabinetToday: () => '2026-10-04',
      renderList: () => {
        renders++;
      },
      request: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    },
    module = w.createClientDirectory(state, actions);
  module.initializeDirectory({ nextCursor: 'cursor', total: 1, matched: 1, counts: { all: 1 } });
  state.directory = [{ id: 'old' }];
  const first = module.loadDirectoryMore();
  actions.$('#search').value = 'new';
  module.directoryView();
  await until(() => requests.length === 2);
  requests[1].resolve({
    directory: [{ id: 'new' }],
    total: 2,
    matched: 1,
    counts: { all: 2 },
    nextCursor: 'fresh',
  });
  await until(() => state.directory[0]?.id === 'new');
  requests[0].resolve({ directory: [{ id: 'late' }], nextCursor: null });
  await first;
  assert.equal(state.directory.length, 1);
  assert.equal(state.directory[0].id, 'new');
  const continuation = module.loadDirectoryMore();
  const conflict = Error('changed');
  conflict.status = 409;
  requests[2].reject(conflict);
  await until(() => requests.length === 4);
  requests[3].resolve({
    directory: [{ id: 'restarted' }],
    total: 1,
    matched: 1,
    counts: { all: 1 },
    nextCursor: null,
  });
  await continuation;
  assert.equal(state.directory.length, 1);
  assert.equal(state.directory[0].id, 'restarted');
  assert.ok(renders >= 2);
  assert.ok(
    requests.every((r) => new URL('http://test' + r.url).searchParams.get('limit') === '20'),
  );
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/appointments.js'), 'utf8'));
  state.data = [];
  state.currentView = 'calendar';
  state.editorMode = null;
  state.lazyReads = true;
  let finish;
  const forms = w.createAppointments(state, {
    isClosedAppointment: require('../src/shared/appointment-status.cjs').isClosedAppointment,
    clientRecords: () => [],
    ensurePatient: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const opening = forms.openAppointmentForm({ patientId: 'late' });
  state.account = { id: 'different-account' };
  finish({ id: 'late' });
  await opening;
  assert.equal(state.editorMode, null);
  const nextOpening = forms.openAppointmentForm({ patientId: 'late' });
  const otherEditor = { kind: 'visit' };
  state.editorMode = otherEditor;
  finish({ id: 'late' });
  await nextOpening;
  assert.equal(state.editorMode, otherEditor);
});
