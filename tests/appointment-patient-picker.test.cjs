const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom'),
  { createStorage } = require('../storage.cjs'),
  { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const root = path.resolve(__dirname, '..');
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error('Patient picker timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function activeStyles(w, width) {
  const node = w.document.createElement('style');
  node.textContent =
    fs.readFileSync(assetPath('style.css'), 'utf8') +
    '\n' +
    fs.readFileSync(assetPath('ui-extra.css'), 'utf8');
  w.document.head.append(node);
  const flatten = (rules) =>
    [...rules].flatMap((rule) => {
      if (!rule.conditionText) return [rule.cssText];
      if (!rule.cssRules) return [];
      const limits = [...rule.conditionText.matchAll(/(min|max)-width:\s*(\d+)px/g)];
      return limits.every(([, kind, n]) =>
        kind === 'min' ? width >= Number(n) : width <= Number(n),
      )
        ? flatten(rule.cssRules)
        : [];
    });
  node.textContent = flatten(node.sheet.cssRules).join('\n');
  return (element) => w.getComputedStyle(element);
}
for (const width of [320, 390, 1440])
  test(
    '1200 clients: bounded search, phone/name choice, immediate plus, edit/card/service flows at width ' +
      width,
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-picker-')),
        platform = createPlatformStore(path.join(dir, 'platform'));
      const owner = await platform.registerOwner({
        email: 'picker@example.test',
        password: 'Synthetic-picker-password',
        displayName: 'Synthetic Owner',
        organizationName: 'Synthetic Clinic',
      });
      platform.verifyEmail(owner.verificationToken);
      const admin = await platform.bootstrapGlobalAdmin({
        email: 'admin@example.test',
        password: 'Synthetic-admin-password',
        displayName: 'Synthetic Admin',
      });
      platform.admin.updateSubscription(admin.accountId, owner.organizationId, {
        requestId: require('node:crypto').randomUUID(),
        expectedRevision: 0,
        reason: 'Синтетическая база 1200 клиентов',
        plan: 'free',
        limits: { ...platform.subscription(owner.organizationId).limits, patients: 2000 },
      });
      platform.close();
      const patients = Array.from({ length: 1200 }, (_, i) => ({
        id: 'p' + i,
        firstName: 'Клиент' + String(i).padStart(4, '0'),
        lastName: 'Фамилия',
        middleName: '',
        name: 'Клиент' + String(i).padStart(4, '0') + ' Фамилия',
        phone: '+7900' + String(i).padStart(7, '0'),
        birth: '',
        notes: 'Private synthetic history',
        allergies: '',
        createdBy: owner.accountId,
        visits: [],
        appointments: [],
      }));
      const storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
      storage.write({
        revision: 0,
        patients,
        services: [
          { id: 's', name: 'Консультация', category: 'other', duration: '30 минут', price: 1500 },
        ],
      });
      storage.close();
      await require('./helpers/working-days.cjs').workingDays(
        dir,
        'picker@example.test',
        'Synthetic-picker-password',
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
      const base = 'http://127.0.0.1:' + server.address().port,
        login = await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'picker@example.test',
            password: 'Synthetic-picker-password',
          }),
        });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0],
        context = authContextHeaders(await login.json());
      const errors = [],
        calls = [],
        vc = new VirtualConsole();
      vc.on('jsdomError', (e) => errors.push(e.message));
      const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
        url: base,
        runScripts: 'outside-only',
        virtualConsole: vc,
      }).window;
      t.after(async () => {
        w.close();
        await new Promise((r) => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
      });
      w.structuredClone = structuredClone;
      w.AbortController = AbortController;
      w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
      w.confirm = () => true;
      w.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new w.Event('close'));
      };
      w.fetch = (route, options = {}) => {
        calls.push(route);
        return fetch(base + route, {
          ...options,
          headers: { ...options.headers, Origin: base, Cookie: cookie },
        });
      };
      const $ = (s) => w.document.querySelector(s),
        type = (text) => {
          const field = $('#appointment-patient-search');
          field.value = text;
          field.dispatchEvent(new w.Event('input', { bubbles: true }));
        },
        submit = () =>
          $('#editor-form').dispatchEvent(
            new w.Event('submit', { bubbles: true, cancelable: true }),
          );
      require('./helpers/client-bundle.cjs').evaluateClient(w);
      await until(() => !w.document.body.classList.contains('app-loading'));
      $('[data-view="calendar"]').click();
      $('#calendar-new').click();
      await until(() => $('#editor').open && $('#appointment-patient-search'));
      assert.ok(!calls.some((route) => route.includes('picker=1')));
      assert.equal($('#appointment-patient').type, 'hidden');
      assert.equal($('#appointment-patient-results').hidden, true);
      assert.equal(w.document.querySelectorAll('#appointment-patient option').length, 0);
      assert.equal($('#appointment-patient-status').textContent, '');
      const computed = activeStyles(w, width);
      assert.equal(computed($('.appointment-patient-search-row')).display, 'grid');
      assert.match(
        computed($('.appointment-patient-search-row')).gridTemplateColumns,
        /^minmax\(0,\s*1fr\) 44px$/,
      );
      assert.equal(computed($('#appointment-patient-add')).width, '44px');
      type('Клиент');
      await until(
        () => w.document.querySelectorAll('[data-appointment-patient-index]').length === 10,
      );
      assert.match($('#appointment-patient-status').textContent, /1200/);
      assert.doesNotMatch(
        $('#appointment-patient-results').textContent,
        /Private synthetic history/,
      );
      type('Фамилия Клиент1199');
      await until(() => $('[data-appointment-patient-index]')?.textContent.includes('Клиент1199'));
      $('[data-appointment-patient-index]').click();
      assert.equal($('#appointment-patient').value, 'p1199');
      assert.equal($('#appointment-patient-results').hidden, true);
      assert.match($('#appointment-patient-status').textContent, /\+7 \(900\) 000-11-99/);
      type('8 (900) 000-11-99');
      assert.equal($('#appointment-patient').value, '');
      await until(() => $('[data-appointment-patient-index]')?.textContent.includes('Клиент1199'));
      $('#appointment-patient-search').dispatchEvent(
        new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
      );
      $('#appointment-patient-search').dispatchEvent(
        new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      assert.equal($('#appointment-patient').value, 'p1199');
      type('Неттакогоклиента');
      await until(() => $('#appointment-patient-results').textContent.includes('Клиент не найден'));
      submit();
      await until(() => !$('#save-editor').disabled);
      assert.match($('#form-error').textContent, /Выберите/);
      $('#appointment-patient-add').click();
      assert.equal($('#appointment-patient').value, '__new__');
      assert.equal($('#appointment-patient-results').hidden, true);
      assert.equal($('#appointment-patient-search').disabled, true);
      assert.equal($('[name="newFirstName"]').required, false);
      assert.equal($('[name="newFirstName"]').closest('label').hidden, false);
      $('[name="newFirstName"]').value = 'Анна';
      $('[name="newLastName"]').value = 'Новая';
      $('[name="newMiddleName"]').value = 'Ивановна';
      $('[name="newPhone"]').value = '+79999999999';
      $('[name="date"]').value = '2030-01-01';
      $('[name="time"]').value = '10:00';
      const service = $('[data-appointment-service="s"]');
      service.closest('details').open = true;
      service.click();
      submit();
      await until(() => !$('#editor').open);
      const read = async () =>
        await (
          await fetch(base + '/api/cabinet', { headers: { Cookie: cookie, ...context } })
        ).json();
      let data = await read();
      assert.equal(data.patients.length, 1201);
      const created = data.patients.find((p) => p.firstName === 'Анна');
      assert.equal(created.name, 'Анна Ивановна Новая');
      assert.equal(created.appointments.length, 1);
      assert.equal(created.visits.length, 0);
      $('[data-appointment-id="' + created.appointments[0].id + '"]').click();
      await until(() => $('#editor').open && $('[data-edit-appointment-action]'));
      assert.match($('.appointment-action-summary strong').textContent, /Новая.*Анна/);
      $('[data-edit-appointment-action]').click();
      await until(
        () => $('#editor').open && $('#appointment-patient-search')?.value === created.name,
      );
      assert.equal($('#appointment-patient').value, created.id);
      assert.equal($('#appointment-patient-results').hidden, true);
      assert.equal($('[name="newFirstName"]').required, false);
      $('#appointment-patient-add').click();
      $('#appointment-patient-add').click();
      assert.equal($('#appointment-patient').value, created.id);
      assert.equal($('#appointment-patient-search').value, created.name);
      assert.equal($('[name="newFirstName"]').closest('label').hidden, true);
      $('#cancel-editor').click();
      $('[data-view="card"]').click();
      await until(() => $('#new-patient-appointment'));
      $('#new-patient-appointment').click();
      await until(() => $('#editor').open);
      assert.equal($('#appointment-patient').value, created.id);
      $('#cancel-editor').click();
      $('[data-view="services"]').click();
      $('[data-select-service="s"]').click();
      $('#create-appointment-from-services').click();
      await until(() => $('#editor').open);
      assert.ok($('#appointment-patient-search'));
      assert.equal($('#appointment-duration').value, '30');
      $('#cancel-editor').click();
      assert.ok(
        calls
          .filter(
            (route) => route.startsWith('/api/cabinet/directory?') && !route.includes('picker'),
          )
          .some((route) => route.includes('limit=10')),
      );
      assert.ok(!calls.some((route) => route.includes('picker=1')));
      assert.deepEqual(errors, []);
    },
  );
test('late lookup, close, plus and account changes cannot replace current results; keyboard and plain text remain safe', async (t) => {
  const w = new JSDOM(
    '<dialog id="editor" open><main id="form-content"></main></dialog><button id="outside">Outside</button>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.AbortController = AbortController;
  w.eval(
    fs.readFileSync(path.join(root, 'src/client/modules/appointment-patient-picker.js'), 'utf8'),
  );
  w.eval(fs.readFileSync(path.join(root, 'src/client/modules/patient-fields.js'), 'utf8'));
  const state = { account: { id: 'owner' }, editorMode: { kind: 'appointment' } },
    requests = [],
    actions = {
      $: (s) => w.document.querySelector(s),
      esc: (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      loadAppointmentDirectory: (q) => new Promise((resolve) => requests.push({ q, resolve })),
    };
  Object.assign(
    actions,
    require('../src/shared/patient-names.cjs').createPatientNames(),
    w.createPatientFields(state, actions),
  );
  w.eval(fs.readFileSync(path.join(root, 'src/client/shared/format.js'), 'utf8'));
  actions.formatPhone = w.createFormat(state, actions).formatPhone;
  const picker = w.createAppointmentPatientPicker(state, actions),
    mount = () => {
      actions.$('#form-content').innerHTML =
        picker.appointmentPatientPickerHtml() +
        '<label class="appointment-new-field" hidden><input name="newFirstName"></label>';
      picker.mountAppointmentPatientPicker();
    };
  mount();
  picker.bindAppointmentPatientPickerEvents();
  const type = (q) => {
    actions.$('#appointment-patient-search').value = q;
    actions.$('#appointment-patient-search').dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  type('old');
  await until(() => requests.length === 1);
  type('new');
  await until(() => requests.length === 2);
  requests[1].resolve({
    patients: [{ id: 'safe', name: '<img src=x onerror=x>', phone: '555' }],
    matched: 1,
  });
  await until(() => actions.$('[data-appointment-patient-index]'));
  requests[0].resolve({ patients: [{ id: 'old', name: 'Wrong' }], matched: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(actions.$('#appointment-patient-results').querySelector('img'), null);
  assert.doesNotMatch(actions.$('#appointment-patient-results').textContent, /Wrong/);
  actions.$('#outside').click();
  assert.equal(actions.$('#appointment-patient-results').hidden, true);
  type('plus');
  await until(() => requests.length === 3);
  actions.$('#appointment-patient-add').click();
  requests[2].resolve({ patients: [{ id: 'late', name: 'Wrong' }], matched: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(actions.$('#appointment-patient').value, '__new__');
  assert.equal(actions.$('#appointment-patient-results').hidden, true);
  actions.$('#appointment-patient-add').click();
  type('other');
  await until(() => requests.length === 4);
  state.account = { id: 'another' };
  requests[3].resolve({ patients: [{ id: 'other', name: 'Wrong' }], matched: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(actions.$('[data-appointment-patient-index]'), null);
  mount();
  type('close');
  await until(() => requests.length === 5);
  actions.$('#editor').open = false;
  actions.$('#editor').dispatchEvent(new w.Event('close'));
  requests[4].resolve({ patients: [{ id: 'closed', name: 'Wrong' }], matched: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(actions.$('[data-appointment-patient-index]'), null);
});
