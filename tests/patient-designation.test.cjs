const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createStorage } = require('../storage.cjs'),
  { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { patientFullName, patientSearchText } = require('../src/shared/patient-names.cjs');
const { validateState } = require('../src/server/modules/cabinet/validation.cjs'),
  { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const { authorizeCabinetChange } = require('../src/server/modules/access/cabinet-policy.cjs');
const { appointmentMessage } = require('../src/server/modules/notifications/telegram-messages.cjs');
const root = path.resolve(__dirname, '..');
const patient = (id, designation, createdBy = 'owner') => ({
  id,
  firstName: 'Анна',
  lastName: 'Морозова',
  middleName: 'Ивановна',
  name: 'Анна Ивановна Морозова',
  designation,
  phone: '+79000000000',
  createdBy,
  visits: [],
  appointments: [],
});
async function until(fn) {
  const deadline = Date.now() + 7000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error('Designation UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('designation is optional, bounded, internal and cannot change formal names or existing employee profile permissions', () => {
  const p = patient('p', 'тренер по фитнесу', 'staff'),
    before = { revision: 0, patients: [p], services: [] };
  assert.equal(patientFullName(p), 'Анна Ивановна Морозова');
  assert.match(patientSearchText(p), /тренер по фитнесу/);
  for (const designation of [undefined, '', 'тётя', 'x'.repeat(200)])
    assert.doesNotThrow(() => validateState({ ...before, patients: [{ ...p, designation }] }));
  for (const designation of [null, 5, {}, ['тётя'], 'x'.repeat(201)])
    assert.throws(
      () => validateState({ ...before, patients: [{ ...p, designation }] }),
      (e) => e.status === 400,
    );
  for (const designation of ['', undefined, 'тётя']) {
    const next = { ...before, patients: [{ ...p, designation }] };
    assert.throws(
      () => authorizeCabinetChange({ role: 'cosmetologist', accountId: 'staff' }, before, next),
      (e) => e.status === 403,
    );
    for (const role of ['owner', 'salon_admin'])
      assert.doesNotThrow(() => authorizeCabinetChange({ role }, before, next));
  }
  assert.doesNotThrow(() =>
    authorizeCabinetChange(
      { role: 'cosmetologist', accountId: 'staff' },
      { revision: 0, patients: [], services: [] },
      before,
    ),
  );
  const text = appointmentMessage(
    { organization: { name: 'Test salon' }, patient: p },
    {
      date: '2030-01-01',
      time: '10:00',
      duration: 30,
      service: 'Консультация',
      designation: p.designation,
    },
    {},
    { showServices: true },
  );
  assert.doesNotMatch(text, /тренер|фитнесу|Обозначение/);
  assert.match(text, /Консультация/);
});

test('designation survives encrypted summary/reopen, is searchable beyond the first page and respects staff scope without changing sort keys', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-designation-index-'));
  let storage = createStorage(dir);
  t.after(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const patients = Array.from({ length: 120 }, (_, i) => ({
    ...patient('p' + i, i === 119 ? 'тренер по фитнесу' : '', i % 2 ? 'staff' : 'other'),
    firstName: 'Имя' + String(i).padStart(3, '0'),
    name: 'Имя' + String(i).padStart(3, '0') + ' Ивановна Морозова',
  }));
  patients[0].designation = 'Скрытая служебная пометка';
  storage.write({ revision: 0, patients, services: [] });
  const user = (role) => ({
      role,
      accountId: role === 'cosmetologist' ? 'staff' : 'owner',
      organizationId: 'org',
    }),
    page = (role, params = {}) =>
      directoryPage(storage, user(role), new URL('http://test/?' + new URLSearchParams(params)));
  const order = page('owner').directory.map((p) => p.id);
  assert.equal(page('owner', { q: 'Имя119 фитнесу', limit: 10 }).directory[0].id, 'p119');
  assert.equal(page('cosmetologist', { q: 'Скрытая' }).matched, 0);
  assert.equal(
    page('cosmetologist', { q: 'тренер по фитнесу' }).directory[0].designation,
    'тренер по фитнесу',
  );
  const data = storage.read();
  data.patients[119].designation = 'тётя';
  storage.write(data);
  assert.equal(page('owner', { q: 'фитнесу' }).matched, 0);
  assert.equal(page('owner', { q: 'тётя' }).directory[0].id, 'p119');
  assert.deepEqual(
    page('owner').directory.map((p) => p.id),
    order,
  );
  storage.close();
  storage = createStorage(dir);
  assert.equal(page('owner', { q: 'тётя' }).directory[0].designation, 'тётя');
  assert.equal(storage.read().patients[119].name, patients[119].name);
});

for (const width of [320, 390, 1440])
  test(
    'internal designation works in client create/edit/clear, card and appointment choice, but not print, at width ' +
      width,
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-designation-ui-')),
        platform = createPlatformStore(path.join(dir, 'platform'));
      const owner = await platform.registerOwner({
        email: 'designation@example.test',
        password: 'Synthetic-designation-password',
        displayName: 'Synthetic Owner',
        organizationName: 'Synthetic Clinic',
      });
      platform.verifyEmail(owner.verificationToken);
      platform.close();
      const storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
      storage.write({
        revision: 0,
        patients: [
          patient('p0', 'тётя', owner.accountId),
          patient('p1', 'тренер по фитнесу', owner.accountId),
        ],
        services: [
          { id: 's', name: 'Консультация', category: 'other', duration: '30 минут', price: 1500 },
        ],
      });
      storage.close();
      await require('./helpers/working-days.cjs').workingDays(
        dir,
        'designation@example.test',
        'Synthetic-designation-password',
        ['2030-01-01'],
      );
      const server = createMultiServer({
        dataDir: dir,
        sendMail: null,
        telegramBot: null,
        telegramAutostart: false,
        supportAutostart: false,
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      const login = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'designation@example.test',
          password: 'Synthetic-designation-password',
        }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0],
        context = authContextHeaders(await login.json());
      const errors = [],
        vc = new VirtualConsole();
      vc.on('jsdomError', (e) => errors.push(e.message));
      const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
        url: base,
        runScripts: 'outside-only',
        virtualConsole: vc,
      }).window;
      t.after(async () => {
        w.dispatchEvent(new w.Event('pagehide'));
        w.close();
        await new Promise((r) => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
      });
      w.fetch = (route, options = {}) =>
        fetch(base + route, {
          ...options,
          headers: { ...options.headers, Origin: base, Cookie: cookie },
        });
      w.AbortController = AbortController;
      w.structuredClone = structuredClone;
      w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
      w.confirm = () => true;
      w.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new w.Event('close'));
      };
      const $ = (s) => w.document.querySelector(s),
        read = async () =>
          await (
            await fetch(base + '/api/cabinet', { headers: { Cookie: cookie, ...context } })
          ).json(),
        submit = () =>
          $('#editor-form').dispatchEvent(
            new w.Event('submit', { bubbles: true, cancelable: true }),
          ),
        type = (selector, text) => {
          const input = $(selector);
          input.value = text;
          input.dispatchEvent(new w.Event('input', { bubbles: true }));
        };
      require('./helpers/client-bundle.cjs').evaluateClient(w);
      await until(() => !w.document.body.classList.contains('app-loading'));
      $('[data-view="clients"]').click();
      $('[data-client-filter="all"]').click();
      type('#search', 'фитнесу');
      await until(
        () =>
          w.document.querySelectorAll('[data-patient]').length === 1 && $('[data-patient="p1"]'),
      );
      assert.equal($('.patient-designation').textContent, 'тренер по фитнесу');
      assert.equal($('#patient-list strong').textContent, 'Анна Ивановна Морозова');
      $('[data-patient="p1"]').click();
      await until(() => $('#edit-patient'));
      assert.equal(
        $('#detail .patient-card-designation').textContent,
        'Обозначение: тренер по фитнесу',
      );
      assert.doesNotMatch($('#patient-print').textContent, /тренер по фитнесу/);
      $('#edit-patient').click();
      assert.equal($('[name="designation"]').value, 'тренер по фитнесу');
      assert.equal($('[name="designation"]').required, false);
      const originalId = 'p1',
        before = (await read()).patients.find((p) => p.id === originalId);
      const internal = '<img src=x onerror=alert(1)> тренер';
      $('[name="designation"]').value = internal;
      submit();
      await until(() => !$('#editor').open && !$('#save-editor').disabled);
      let saved = (await read()).patients.find((p) => p.id === originalId);
      assert.equal(saved.designation, internal);
      assert.equal(saved.name, before.name);
      assert.deepEqual(saved.appointments, before.appointments);
      assert.deepEqual(saved.visits, before.visits);
      assert.equal($('#detail .patient-card-designation').textContent, 'Обозначение: ' + internal);
      assert.equal($('#detail .patient-card-designation img'), null);
      assert.doesNotMatch($('#patient-print').textContent, /onerror|тренер/);
      $('[data-view="clients"]').click();
      type('#search', 'onerror');
      await until(
        () =>
          $('[data-patient="p1"]') && w.document.querySelectorAll('[data-patient]').length === 1,
      );
      assert.equal($('.patient-designation').textContent, internal);
      assert.equal($('#patient-list .patient-designation img'), null);
      assert.equal($('#patient-list img[src="x"],#patient-list [onerror]'), null);
      $('[data-patient="p1"]').click();
      await until(() => $('#edit-patient'));
      $('#edit-patient').click();
      $('[name="designation"]').value = '';
      submit();
      await until(() => !$('#editor').open && !$('#save-editor').disabled);
      assert.equal((await read()).patients.find((p) => p.id === 'p1').designation, '');
      assert.equal($('#detail .patient-card-designation'), null);
      assert.doesNotMatch($('#detail').textContent, /Обозначение:/);
      $('[data-view="clients"]').click();
      $('#add-patient').click();
      $('[name="firstName"]').value = 'Юлия';
      $('[name="lastName"]').value = 'Новая';
      $('[name="designation"]').value = 'знакомая';
      submit();
      await until(() => !$('#editor').open && !$('#save-editor').disabled);
      saved = (await read()).patients.find((p) => p.firstName === 'Юлия');
      assert.equal(saved.designation, 'знакомая');
      assert.equal(saved.name, 'Юлия Новая');
      assert.equal($('#detail .patient-card-designation').textContent, 'Обозначение: знакомая');
      assert.doesNotMatch($('#patient-print').textContent, /знакомая/);
      $('[data-view="calendar"]').click();
      $('#calendar-new').click();
      await until(() => $('#editor').open && $('#appointment-patient-search'));
      type('#appointment-patient-search', 'тётя');
      await until(() => $('[data-appointment-patient-index]'));
      assert.equal($('#appointment-patient-results strong').textContent, 'Анна Ивановна Морозова');
      assert.equal($('#appointment-patient-results .patient-designation').textContent, 'тётя');
      $('[data-appointment-patient-index]').click();
      assert.equal($('#appointment-patient').value, 'p0');
      assert.match($('#appointment-patient-status').textContent, /тётя/);
      assert.equal($('#appointment-patient-search').value, 'Анна Ивановна Морозова');
      $('#appointment-patient-add').click();
      assert.equal($('[name="newDesignation"]').closest('label').hidden, false);
      $('[name="newFirstName"]').value = 'Ирина';
      $('[name="newLastName"]').value = 'Новая';
      $('[name="newDesignation"]').value = 'соседка';
      $('[name="date"]').value = '2030-01-01';
      $('[name="time"]').value = '10:00';
      $('[data-appointment-service="s"]').closest('details').open = true;
      $('[data-appointment-service="s"]').click();
      submit();
      await until(() => !$('#editor').open && !$('#save-editor').disabled);
      saved = (await read()).patients.find((p) => p.firstName === 'Ирина');
      assert.equal(saved.designation, 'соседка');
      assert.equal(saved.name, 'Ирина Новая');
      assert.equal(saved.appointments.length, 1);
      assert.equal(saved.visits.length, 0);
      assert.doesNotMatch(JSON.stringify(saved.appointments), /соседка|designation/);
      assert.deepEqual(errors, []);
    },
  );
