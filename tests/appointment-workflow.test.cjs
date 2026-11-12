const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');
const root = path.resolve(__dirname, '..');
const oldVisit = {
  id: 'legacy-visit',
  date: '2020-01-01',
  procedure: 'Старая услуга',
  type: 'Уход',
  photos: [],
};
const services = [
  {
    id: 's1',
    name: 'Чистка',
    category: 'cleansing',
    product: 'Средство',
    duration: '60 минут',
    price: 2500,
  },
  {
    id: 's2',
    name: 'Консультация',
    category: 'consultation',
    product: '',
    duration: '30 минут',
    price: 1000,
  },
  {
    id: 's3',
    name: 'Консультация',
    category: 'consultation',
    product: 'Другой вариант',
    duration: '45 минут',
    price: 1500,
  },
];
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error('UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}
// Prepared for the next requested test stage: record -> inspector -> explicit editing.
async function editFromRecord(h, selector) {
  h.$(selector).click();
  await until(() => h.$('#editor [data-edit-appointment-action]'));
  assert.equal(h.$('#save-editor').hidden, true);
  h.$('[data-edit-appointment-action]').click();
  await until(() => h.$('#appointment-patient'));
  assert.equal(
    h.$(
      '#editor [data-complete-appointment],#editor [data-manual-confirm],#editor [data-appointment-outcome]',
    ),
    null,
  );
}
async function visitFromRecord(h, selector) {
  h.$(selector).click();
  await until(() => h.$('#editor [data-complete-appointment]'));
  assert.equal(h.$('#save-editor').hidden, true);
  const confirm = h.w.confirm;
  let confirmations = 0;
  h.w.confirm = () => {
    confirmations++;
    return false;
  };
  try {
    h.$('#editor [data-complete-appointment]').click();
    await until(() => h.$('.visit-form-grid'));
    assert.equal(
      confirmations,
      0,
      'visit form opens directly without an intermediate confirmation',
    );
  } finally {
    h.w.confirm = confirm;
  }
}
function pickVisitProcedure(h, id) {
  const select = h.$('#visit-procedure'),
    option = select.querySelector('[data-service-id="' + id + '"]');
  assert.ok(option);
  select.selectedIndex = [...select.options].indexOf(option);
  select.dispatchEvent(new h.w.Event('change', { bubbles: true }));
}
function addAppointmentProcedure(h, id) {
  const button = h.$('[data-appointment-service="' + id + '"]');
  assert.ok(button);
  if (button.disabled) return;
  h.$('#appointment-service').open = true;
  const group = button.closest('details');
  if (!group.open) group.querySelector('summary').click();
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(h.$('#appointment-service').open, false);
  assert.equal(group.open, true);
}
// JSDOM does not apply viewport media queries: flatten matching CSS rules explicitly.
// This checks the CSS contract, not real pixel layout or the phone keyboard.
function applyLayoutCss(h, width) {
  const style = h.w.document.createElement('style');
  style.textContent = ['style.css', 'ui-extra.css']
    .map((file) => fs.readFileSync(assetPath(file), 'utf8'))
    .join('\n');
  h.w.document.head.append(style);
  const flatten = (rules) =>
    [...rules].flatMap((rule) => {
      if (rule.type === 1) return [rule.cssText];
      if (rule.type !== 4) return [];
      const query = rule.conditionText;
      if (!/width/.test(query)) return [];
      const limits = [...query.matchAll(/(min|max)-width:\s*(\d+)px/g)];
      return limits.every(([, kind, size]) =>
        kind === 'max' ? width <= Number(size) : width >= Number(size),
      )
        ? flatten(rule.cssRules)
        : [];
    });
  const active = flatten(style.sheet.cssRules);
  style.textContent = active.join('\n');
  return (node) => h.w.getComputedStyle(node);
}
const { createSyntheticSeed, createFixtureTimer } = require('./helpers/synthetic-seed.cjs');
const workflowSeed = createSyntheticSeed({
  name: 'workflow',
  async prepare(dir) {
    let platform = createPlatformStore(path.join(dir, 'platform')),
      storage,
      server;
    try {
      const owner = await platform.registerOwner({
        email: 'workflow@example.test',
        password: 'Workflow-test-password-2026',
        displayName: 'Test',
        organizationName: 'Test',
      });
      platform.verifyEmail(owner.verificationToken);
      const groupLogin = await platform.login(
        'workflow@example.test',
        'Workflow-test-password-2026',
      );
      for (const [id, title] of [
        ['cleansing', 'Чистки'],
        ['consultation', 'Консультации'],
        ['laser', 'Лазерные услуги'],
        ['care', 'Уходовые услуги'],
      ])
        platform.createServiceGroup(groupLogin.token, {
          id,
          title,
          revision: platform.serviceGroups(owner.organizationId).revision,
        });
      storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
      storage.write({
        revision: 0,
        services,
        patients: [
          {
            id: 'p',
            name: 'Тестовый клиент',
            createdBy: owner.accountId,
            visits: [oldVisit],
            appointments: [],
          },
          { id: 'p2', name: 'Другой тестовый клиент', visits: [], appointments: [] },
        ],
      });
      storage.close();
      storage = null;
      platform.close();
      platform = null;
      await require('./helpers/working-days.cjs').workingDays(
        dir,
        'workflow@example.test',
        'Workflow-test-password-2026',
        ['2030-01-01', '2030-01-02', '2030-01-03', '2030-01-04', '2030-01-05'],
      );
      server = createMultiServer({ dataDir: dir, sendMail: async () => {}, telegramBot: null });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const base = 'http://127.0.0.1:' + server.address().port;
      const response = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
        body: JSON.stringify({
          email: 'workflow@example.test',
          password: 'Workflow-test-password-2026',
        }),
      });
      assert.equal(response.status, 200);
      const context = authContextHeaders(await response.json());
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie);
      return { owner, cookie, context };
    } finally {
      try {
        if (server?.listening) {
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
        }
      } finally {
        try {
          storage?.close();
        } finally {
          platform?.close();
        }
      }
    }
  },
});
test.after(() => workflowSeed.close());
async function fixture(t, { cabinetSchema = 1 } = {}) {
  const timing = createFixtureTimer(t, 'appointment-workflow');
  const copy = await workflowSeed.clone(),
    { dir } = copy,
    { owner, cookie, context } = copy.data,
    windows = [],
    outbox = [];
  let server;
  // JSDOM close() does not emit pagehide: cancel pending reads before shutdown.
  t.after(() =>
    timing.cleanup(async () => {
      try {
        windows.forEach((w) => {
          w.dispatchEvent(new w.Event('pagehide'));
          w.close();
        });
      } finally {
        try {
          if (server?.listening) {
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
          }
        } finally {
          copy.close();
        }
      }
    }),
  );
  if (cabinetSchema === 2) {
    for (const location of [dir, path.join(dir, 'tenants', owner.organizationId)]) {
      let store = createStorage(location);
      const data = store.read();
      try {
        require('../src/server/migrations/002-cabinet-records.cjs').migrateCabinetRecords(store);
        store.db.exec(require('../src/server/infrastructure/cabinet-history-index145.cjs').schema);
        store.close();
        store = createStorage(location, { cabinetSchema: 2 });
        store.transaction(() => {
          for (const patient of data.patients) {
            const rows = store.db
              .prepare(
                'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records WHERE patient_id=?',
              )
              .all(patient.id);
            const profile = store.db
              .prepare('SELECT value FROM patients WHERE id=?')
              .get(patient.id);
            store.historyIndex.syncPatient(patient, rows, profile.value);
          }
        });
      } finally {
        store.close();
      }
    }
  }
  server = createMultiServer({
    dataDir: dir,
    cabinetSchema,
    sendMail: async (email, url) => outbox.push({ email, url }),
    telegramBot: null,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const authContexts = new Map([[cookie, context]]);
  async function request(route, body, as = '') {
    if (body && route === '/api/auth/invitations/accept')
      body = { privacyConsent: true, privacyConsentVersion: PRIVACY_VERSION, ...body };
    const r = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: as,
        ...authContexts.get(as),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json(),
      cookie = r.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && r.status === 200)
      authContexts.set(cookie, authContextHeaders(data));
    return { status: r.status, data, cookie };
  }
  async function read(as = cookie) {
    return (await request('/api/cabinet', null, as)).data;
  }
  async function save(data, as = cookie) {
    const r = await fetch(base + '/api/cabinet', {
      method: 'PUT',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: as,
        ...authContexts.get(as),
      },
      body: JSON.stringify(data),
    });
    return { status: r.status, data: await r.json() };
  }
  async function patch(before, after, as = cookie) {
    const r = await fetch(base + '/api/cabinet/changes', {
      method: 'PATCH',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: as,
        ...authContexts.get(as),
      },
      body: JSON.stringify({
        revision: before.revision,
        patients: [
          { id: before.patients[0].id, before: before.patients[0], after: after.patients[0] },
        ],
        services: [],
      }),
    });
    return { status: r.status, data: await r.json() };
  }
  function seed(data) {
    const store = createStorage(path.join(dir, 'tenants', owner.organizationId));
    try {
      store.write(data);
    } finally {
      store.close();
    }
  }
  async function ui(width) {
    const errors = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e.message));
    const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
      url: base,
      runScripts: 'outside-only',
      virtualConsole: vc,
    }).window;
    windows.push(w);
    const requests = [];
    w.fetch = (route, options = {}) => {
      requests.push({
        route,
        method: options.method || 'GET',
        body: options.body,
        headers: options.headers,
      });
      return fetch(base + route, {
        ...options,
        headers: { ...options.headers, Origin: base, Cookie: cookie },
      });
    };
    w.AbortController = AbortController;
    w.structuredClone = structuredClone;
    w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
    w.confirm = () => true;
    require('./helpers/action-confirmation.cjs').installActionConfirmation(w);
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    return {
      w,
      errors,
      requests,
      $: (s) => w.document.querySelector(s),
      submit() {
        w.document
          .querySelector('#editor-form')
          .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      },
    };
  }
  timing.ready();
  return { dir, request, save, patch, seed, read, ui, cookie, owner, outbox };
}

for (const width of [390, 1440])
  test(
    'collapsed service groups add multiple calendar/card procedures, remove only one and preserve snapshots at width ' +
      width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h;
      $('[data-view="calendar"]').click();
      $('#calendar-new').click();
      await until(() => $('#appointment-patient'));
      assert.equal($('[data-add-appointment-procedure]'), null);
      assert.equal($('#appointment-service').tagName, 'DETAILS');
      assert.equal(w.document.querySelectorAll('#appointment-service details[open]').length, 0);
      assert.equal($('#appointment-service').open, false);
      $('#appointment-service').open = true;
      const groups = [
        ...w.document.querySelectorAll('#appointment-service .appointment-service-group'),
      ];
      groups[0].querySelector('summary').click();
      assert.equal(groups[0].open, true);
      groups[1].querySelector('summary').click();
      assert.equal(groups[0].open, false);
      assert.equal(groups[1].open, true);
      groups[1].querySelector('summary').click();
      assert.equal(groups[1].open, false);
      $('[name="patientId"]').value = 'p';
      $('[name="date"]').value = '2030-01-01';
      $('[name="time"]').value = '10:00';
      h.submit();
      await until(() => !$('#save-editor').disabled);
      assert.match($('#form-error').textContent, /услуг|услуг/);
      assert.equal($('#editor').open, true);
      addAppointmentProcedure(h, 's1');
      addAppointmentProcedure(h, 's2');
      addAppointmentProcedure(h, 's3');
      addAppointmentProcedure(h, 's3');
      assert.equal(w.document.querySelectorAll('.appointment-procedure-row').length, 3);
      assert.equal($('#appointment-duration').value, '135');
      assert.equal($('#appointment-service-value').value, 'Чистка + Консультация + Консультация');
      $('[data-remove-appointment-procedure="s1"]').click();
      assert.equal($('#appointment-duration').value, '75');
      $('#appointment-duration').value = '90';
      h.submit();
      await until(() => !$('#editor').open);
      let data = await f.read(),
        a = data.patients[0].appointments[0];
      assert.equal(a.duration, 90);
      assert.deepEqual(
        a.serviceItems.map((s) => s.id),
        ['s2', 's3'],
      );
      assert.equal(data.patients[0].visits.length, 1);
      data.services = data.services.filter((s) => s.id !== 's2');
      data.services.find((s) => s.id === 's3').name = 'Изменённая консультация';
      data.services.find((s) => s.id === 's3').price = 9999;
      assert.equal((await f.save(data)).status, 200);
      const next = await f.ui(width);
      next.$('[data-view="clients"]').click();
      next.$('[data-client-filter="all"]').click();
      await until(() => next.$('[data-patient="p"]'));
      next.$('[data-patient="p"]').click();
      await until(() => next.$('[data-card-appointment="' + a.id + '"]'));
      await editFromRecord(next, '[data-card-appointment="' + a.id + '"]');
      await until(() => next.$('#appointment-service'));
      assert.equal(next.$('#appointment-duration').value, '90');
      assert.equal(next.$('#appointment-service-value').value, 'Консультация + Консультация');
      addAppointmentProcedure(next, 's1');
      assert.equal(next.$('#appointment-duration').value, '135');
      next.submit();
      await until(() => !next.$('#editor').open);
      data = await f.read();
      a = data.patients[0].appointments[0];
      assert.deepEqual(
        a.serviceItems.map((s) => s.id),
        ['s2', 's3', 's1'],
      );
      assert.deepEqual(
        a.serviceItems.map((s) => s.price),
        [1000, 1500, 2500],
      );
      next.$('[data-complete-appointment="' + a.id + '"]').click();
      await until(() => next.$('.visit-form-grid'));
      assert.equal(next.w.document.querySelectorAll('.visit-procedure-row').length, 3);
      next.submit();
      await until(() => !next.$('#editor').open);
      data = await f.read();
      const visit = data.patients[0].visits.at(-1);
      assert.deepEqual(visit.serviceItems, a.serviceItems);
      assert.equal(visit.duration, 135);
      assert.equal(visit.procedure, a.service);
      assert.deepEqual(h.errors, []);
      assert.deepEqual(next.errors, []);
    },
  );
for (const width of [390, 1440])
  for (const entry of ['label', 'empty area'])
    test(
      'a rendered gap retains 45 minutes and saves after two short appointments via ' +
        entry +
        ' at width ' +
        width,
      async (t) => {
        const f = await fixture(t),
          data = await f.read();
        const snapshot = {
          id: 's1',
          name: 'Чистка',
          category: 'cleansing',
          categoryTitle: 'Чистки',
          description: '',
          duration: 60,
          price: 2500,
        };
        data.patients[0].appointments = [
          {
            id: 'short-one',
            date: '2030-01-01',
            time: '10:00',
            duration: 5,
            service: 'Чистка',
            serviceItems: [snapshot],
            staffId: f.owner.accountId,
          },
          {
            id: 'short-two',
            date: '2030-01-01',
            time: '10:10',
            duration: 5,
            service: 'Чистка',
            serviceItems: [snapshot],
            staffId: f.owner.accountId,
          },
          {
            id: 'next-hour',
            date: '2030-01-01',
            time: '11:00',
            duration: 60,
            service: 'Synthetic',
            staffId: f.owner.accountId,
          },
        ];
        assert.equal((await f.save(data)).status, 200);
        const h = await f.ui(width),
          { $, w } = h;
        $('[data-view="calendar"]').click();
        $('[data-calendar-mode="day"]').click();
        const date = w.document.createElement('button');
        date.dataset.calendarDate = '2030-01-01';
        w.document.body.append(date);
        date.click();
        date.remove();
        await until(() => $('[data-calendar-gap][data-gap-start="615"][data-gap-end="660"]'));
        const gap = $('[data-calendar-gap][data-gap-start="615"][data-gap-end="660"]'),
          slot = gap.parentElement;
        assert.equal(slot.dataset.slotTime, '10:00');
        assert.equal(gap.dataset.gapDuration, '45');
        if (entry === 'label') gap.click();
        else {
          slot.getBoundingClientRect = () => ({ top: 100, height: 96 });
          slot.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientY: 148 }));
        }
        await until(() => $('#appointment-patient'));
        assert.equal($('[name="time"]').value, '10:15');
        assert.equal($('#appointment-duration').value, '45');
        $('[name="patientId"]').value = 'p';
        addAppointmentProcedure(h, 's1');
        assert.equal($('#appointment-duration').value, '45');
        h.submit();
        await until(() => !$('#editor').open);
        const saved = await f.read();
        const created = saved.patients[0].appointments.find(
          (a) => !['short-one', 'short-two', 'next-hour'].includes(a.id),
        );
        assert.equal(created.time, '10:15');
        assert.equal(created.duration, 45);
        assert.equal(saved.patients[0].appointments.length, 4);
        for (const id of ['short-one', 'short-two']) {
          const short = saved.patients[0].appointments.find((a) => a.id === id);
          assert.equal(short.duration, 5);
          assert.equal(short.serviceItems[0].duration, 60);
        }
        assert.deepEqual(h.errors, []);
      },
    );

test('legacy appointment text survives adding another procedure, reopening and completion', async (t) => {
  const f = await fixture(t);
  let data = await f.read();
  data.patients[0].appointments = [
    {
      id: 'legacy-plan',
      date: '2030-01-01',
      time: '10:00',
      duration: 45,
      service: 'Услуга из прежней картотеки',
      staffId: f.owner.accountId,
    },
  ];
  assert.equal((await f.save(data)).status, 200);
  const h = await f.ui(390),
    { $ } = h;
  $('[data-view="clients"]').click();
  $('[data-client-filter="all"]').click();
  await until(() => $('[data-patient="p"]'));
  $('[data-patient="p"]').click();
  await until(() => $('[data-card-appointment="legacy-plan"]'));
  await editFromRecord(h, '[data-card-appointment="legacy-plan"]');
  await until(() => $('#appointment-service'));
  assert.ok($('[data-remove-appointment-legacy]'));
  addAppointmentProcedure(h, 's1');
  assert.equal($('#appointment-duration').value, '105');
  h.submit();
  await until(() => !$('#editor').open);
  await editFromRecord(h, '[data-card-appointment="legacy-plan"]');
  await until(() => $('#editor').open && $('#appointment-service'));
  assert.equal($('#appointment-service-value').value, 'Услуга из прежней картотеки + Чистка');
  assert.equal($('#appointment-duration').value, '105');
  assert.ok($('[data-remove-appointment-legacy]'));
  $('#cancel-editor').click();
  await until(() => !$('#editor').open);
  await visitFromRecord(h, '[data-card-appointment="legacy-plan"]');
  assert.equal($('[name="procedure"]').value, 'Услуга из прежней картотеки + Чистка');
  assert.equal($('[name="duration"]').value, '105');
  h.submit();
  await until(() => !$('#editor').open);
  data = await f.read();
  assert.equal(data.patients[0].visits.at(-1).procedure, 'Услуга из прежней картотеки + Чистка');
  assert.equal(data.patients[0].visits.at(-1).duration, 105);
  assert.deepEqual(h.errors, []);
});
for (const width of [390, 1440])
  test(
    'new calendar client uses separate names and edit preserves links and optional birth at width ' +
      width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h;
      $('[data-view="calendar"]').click();
      $('#calendar-new').click();
      await until(() => $('#appointment-patient'));
      assert.equal($('[name="newFirstName"]').closest('label').hidden, true);
      $('#appointment-patient-add').click();
      assert.equal($('#appointment-patient').value, '__new__');
      assert.equal($('[name="newFirstName"]').closest('label').hidden, false);
      $('[name="newFirstName"]').value = 'Анна';
      $('[name="newLastName"]').value = 'Морозова';
      $('[name="newMiddleName"]').value = 'Ивановна';
      $('[name="newPhone"]').value = '+70000000000';
      $('[name="date"]').value = '2030-01-01';
      $('[name="time"]').value = '10:00';
      addAppointmentProcedure(h, 's1');
      h.submit();
      await until(() => !$('#editor').open);
      const saved = (await f.read()).patients.find((p) => p.firstName === 'Анна');
      assert.ok(saved);
      assert.equal(saved.name, 'Анна Ивановна Морозова');
      assert.equal(saved.appointments.length, 1);
      $('[data-view="clients"]').click();
      await until(() => $('[data-patient="' + saved.id + '"]'));
      $('[data-patient="' + saved.id + '"]').click();
      await until(() => $('#edit-patient'));
      $('#edit-patient').click();
      assert.equal($('[name="lastName"]').value, 'Морозова');
      assert.equal($('[name="middleName"]').value, 'Ивановна');
      $('[name="middleName"]').value = '';
      $('[name="birth"]').value = '1990-01-02';
      h.submit();
      await until(() => !$('#editor').open);
      const edited = (await f.read()).patients.find((p) => p.id === saved.id);
      assert.equal(edited.name, 'Анна Морозова');
      assert.equal(edited.middleName, '');
      assert.equal(edited.birth, '1990-01-02');
      assert.deepEqual(edited.appointments, saved.appointments);
      assert.deepEqual(h.errors, []);
    },
  );
for (const width of [390, 1440])
  test(
    'card/calendar/services share planned appointments and linked completion at width ' + width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h;
      $('[data-view="clients"]').click();
      $('[data-client-filter="all"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      await until(() => $('#new-patient-appointment'));
      $('#new-patient-appointment').click();
      await until(() => $('#appointment-patient'));
      assert.equal($('[name="patientId"]').value, 'p');
      assert.equal($('[name="reaction"]'), null);
      assert.equal($('#photo-input'), null);
      assert.equal(
        [...w.document.querySelectorAll('#appointment-service .appointment-service-group')].filter(
          (group) => group.querySelector('[data-appointment-service]'),
        ).length,
        2,
      );
      $('[name="date"]').value = '2030-01-01';
      $('[name="time"]').value = '11:15';
      addAppointmentProcedure(h, 's1');
      assert.equal($('#appointment-duration').value, '60');
      h.submit();
      await until(() => !$('#editor').open);
      let data = await f.read(),
        a = data.patients[0].appointments[0];
      assert.equal(data.patients[0].visits.length, 1);
      assert.deepEqual(data.patients[0].visits[0], oldVisit);
      assert.equal(a.status, 'scheduled');
      assert.equal(a.serviceItems[0].id, 's1');
      assert.ok($('[data-card-appointment="' + a.id + '"]'));
      $('[data-view="calendar"]').click();
      assert.ok($('[data-appointment-id="' + a.id + '"]'));
      await editFromRecord(h, '[data-appointment-id="' + a.id + '"]');
      assert.equal($('[name="time"]').value, '11:15');
      $('[name="time"]').value = '12:15';
      h.submit();
      await until(() => !$('#editor').open);
      $('[data-view="clients"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      assert.match($('.patient-appointments').textContent, /12:15/);
      $('[data-view="services"]').click();
      $('[data-select-service="s2"]').click();
      $('[data-service-category-tab="cleansing"]').click();
      $('[data-select-service="s1"]').click();
      $('#create-appointment-from-services').click();
      await until(() => $('#editor').open && $('#appointment-patient'));
      assert.equal($('#appointment-duration').value, '90');
      $('[name="patientId"]').value = 'p';
      $('[name="date"]').value = '2030-01-01';
      $('[name="time"]').value = '14:00';
      h.submit();
      await until(() => !$('#editor').open);
      data = await f.read();
      const combined = data.patients[0].appointments[1];
      assert.equal(combined.serviceItems.length, 2);
      assert.deepEqual(
        combined.serviceItems.map((s) => s.id),
        ['s1', 's2'],
      );
      assert.equal(combined.duration, 90);
      assert.equal(data.patients[0].visits.length, 1);
      // Catalogue edits cannot rewrite an existing appointment's services/prices.
      data.services[0].name = 'Новое название';
      data.services[0].price = 9999;
      assert.equal((await f.save(data)).status, 200);
      // Reload only this synthetic UI, to obtain the new cabinet revision.
      const next = await f.ui(width);
      next.$('[data-view="clients"]').click();
      next.$('[data-client-filter="all"]').click();
      await until(() => next.$('[data-patient="p"]'));
      next.$('[data-patient="p"]').click();
      await until(() => next.$('[data-card-appointment="' + combined.id + '"]'));
      await editFromRecord(next, '[data-card-appointment="' + combined.id + '"]');
      assert.equal(next.$('#appointment-duration').value, '90');
      assert.match(next.$('#appointment-service-value').value, /Чистка/);
      next.$('#cancel-editor').click();
      await until(() => !next.$('#editor').open);
      await visitFromRecord(next, '[data-card-appointment="' + combined.id + '"]');
      assert.match(next.$('#dialog-title').textContent, /проведённое/);
      assert.equal(next.$('[name="reaction"]'), null);
      assert.equal(next.$('[name="type"]'), null);
      assert.equal(next.w.document.querySelectorAll('.visit-procedure-row').length, 2);
      pickVisitProcedure(next, 's3');
      assert.equal(next.w.document.querySelectorAll('.visit-procedure-row').length, 3);
      assert.equal(next.$('[name="duration"]').value, '135');
      next.$('[name="duration"]').value = '90';
      assert.equal(next.$('[name="product"]'), null);
      assert.equal(next.$('[name="duration"]').value, '90');
      next.$('[name="time"]').value = '14:15';
      next.$('[name="notes"]').value = 'Фактический результат';
      next.submit();
      await until(() => !next.$('#editor').open);
      data = await f.read();
      const finished = data.patients[0].appointments.find((x) => x.id === combined.id),
        v = data.patients[0].visits.find((x) => x.id === finished.completedVisitId);
      assert.equal(finished.status, 'completed');
      assert.equal(finished.date, v.date);
      assert.equal(finished.time, '14:15');
      assert.equal(finished.duration, 90);
      assert.equal(v.time, '14:15');
      assert.equal(v.duration, 90);
      assert.equal(v.appointmentId, finished.id);
      assert.equal(v.reaction, undefined);
      assert.equal(v.serviceItems[0].price, 2500);
      assert.equal(v.notes, 'Фактический результат');
      assert.deepEqual(data.patients[0].visits[0], oldVisit);
      assert.deepEqual(
        v.serviceItems.map((s) => s.id),
        ['s1', 's2', 's3'],
      );
      assert.deepEqual(finished.serviceItems, combined.serviceItems);
      assert.match(v.procedure, /Чистка \+ Консультация \+ Консультация/);
      assert.equal(next.$('[data-card-appointment="' + finished.id + '"]'), null);
      assert.match(next.$('#patient-print').textContent, /14:15/);
      next.$('[data-view="calendar"]').click();
      next.$('[data-calendar-mode="list"]').click();
      assert.match(next.$('[data-appointment-id="' + finished.id + '"]').textContent, /Проведено/);
      next.$('[data-appointment-id="' + finished.id + '"]').click();
      await until(() => next.$('#editor [data-complete-appointment]'));
      assert.match(next.$('#editor [data-complete-appointment]').textContent, /Открыть посещение/);
      assert.equal(next.$('#editor [data-edit-appointment-action]'), null);
      next.$('#editor [data-complete-appointment]').click();
      await until(() => next.$('#dialog-title').textContent === 'Изменить посещение');
      assert.equal(next.$('[name="notes"]').value, 'Фактический результат');
      next.$('#cancel-editor').click();
      assert.deepEqual(h.errors, []);
      assert.deepEqual(next.errors, []);
    },
  );

for (const width of [390, 1440])
  test(
    'manual visit supports multiple procedure snapshots, duplicates by name and safe retry at width ' +
      width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h;
      $('[data-view="clients"]').click();
      $('[data-client-filter="all"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      await until(() => $('#new-visit'));
      $('#new-visit').click();
      assert.equal($('[name="reaction"]'), null);
      assert.equal($('[name="type"]'), null);
      assert.equal($('.visit-duration-field').nextElementSibling, $('#visit-procedures-field'));
      assert.doesNotMatch($('#form-content').textContent, /Реакция после|Фото уменьшаются/);
      assert.match($('#photo-upload-help').textContent, /не более 6 фото/);
      assert.equal(w.document.querySelectorAll('#visit-procedure optgroup').length, 5);
      h.submit();
      assert.match($('#form-error').textContent, /Укажите услугу/);
      assert.equal($('#editor').open, true);
      pickVisitProcedure(h, 's2');
      pickVisitProcedure(h, 's3');
      assert.equal($('[name="duration"]').value, '75');
      pickVisitProcedure(h, 's3');
      assert.equal(w.document.querySelectorAll('.visit-procedure-row').length, 2);
      pickVisitProcedure(h, 's1');
      assert.equal($('[name="duration"]').value, '135');
      $('[data-remove-visit-procedure="s1"]').click();
      assert.equal($('[name="duration"]').value, '75');
      assert.equal($('[name="procedure"]').value, 'Консультация + Консультация');
      $('[name="recommendations"]').value = 'Рекомендации после встречи';
      $('[name="duration"]').value = '90';
      $('[name="notes"]').value = 'Два варианта консультации';
      const fetchBefore = w.fetch;
      w.fetch = (route, options = {}) =>
        route === '/api/cabinet/changes' && options.method === 'PATCH'
          ? Promise.reject(new Error('offline test'))
          : fetchBefore(route, options);
      h.submit();
      await until(() => $('[data-save-recovery="check"]'));
      assert.equal($('#editor').open, true);
      assert.equal(w.document.querySelectorAll('.visit-procedure-row').length, 2);
      assert.equal((await f.read()).patients[0].visits.length, 1);
      w.fetch = fetchBefore;
      $('[data-save-recovery="check"]').click();
      await until(() => $('[data-save-recovery="retry"]'));
      $('[data-save-recovery="retry"]').click();
      await until(() => !$('#editor').open);
      let data = await f.read(),
        visit = data.patients[0].visits[1];
      assert.equal(data.patients[0].appointments.length, 0);
      assert.deepEqual(data.patients[0].visits[0], oldVisit);
      assert.deepEqual(
        visit.serviceItems.map((s) => s.id),
        ['s2', 's3'],
      );
      assert.equal(visit.duration, 90);
      assert.equal(visit.recommendations, 'Рекомендации после встречи');
      assert.equal(visit.procedure, 'Консультация + Консультация');
      assert.equal(visit.type, undefined);
      assert.equal(visit.reaction, undefined);
      data.services.find((s) => s.id === 's2').name = 'Новое имя';
      data.services.find((s) => s.id === 's2').price = 9999;
      assert.equal((await f.save(data)).status, 200);
      const next = await f.ui(width);
      next.$('[data-view="clients"]').click();
      next.$('[data-client-filter="all"]').click();
      await until(() => next.$('[data-patient="p"]'));
      next.$('[data-patient="p"]').click();
      await until(() => next.$('[data-edit-visit="' + visit.id + '"]'));
      const edit = next.$('[data-edit-visit="' + visit.id + '"]');
      edit.closest('details').querySelector('summary').click();
      edit.click();
      assert.equal(next.w.document.querySelectorAll('.visit-procedure-row').length, 2);
      assert.equal(next.$('[name="duration"]').value, '90');
      assert.equal(next.$('[name="procedure"]').value, 'Консультация + Консультация');
      assert.equal(next.$('[name="recommendations"]').value, 'Рекомендации после встречи');
      next.submit();
      await until(() => !next.$('#editor').open);
      visit = (await f.read()).patients[0].visits[1];
      assert.equal(visit.serviceItems[0].name, 'Консультация');
      assert.equal(visit.serviceItems[0].price, 1000);
      assert.deepEqual(
        [...next.w.document.querySelectorAll('.print-service-row td:first-child')].map(
          (n) => n.textContent,
        ),
        ['Консультация', 'Консультация'],
      );
      assert.deepEqual(h.errors, []);
      assert.deepEqual(next.errors, []);
    },
  );
for (const width of [390, 1440])
  for (const change of ['rename', 'delete'])
    test(
      'completed visit preserves history after service ' + change + ' at width ' + width,
      async (t) => {
        const f = await fixture(t),
          h = await f.ui(width),
          { $, w } = h;
        $('[data-view="clients"]').click();
        $('[data-client-filter="all"]').click();
        await until(() => $('[data-patient="p"]'));
        $('[data-patient="p"]').click();
        await until(() => $('#new-visit'));
        $('#new-visit').click();
        pickVisitProcedure(h, 's2');
        $('[name="notes"]').value = 'Historical visit';
        h.submit();
        await until(() => !$('#editor').open);
        const before = await f.read(),
          savedVisits = structuredClone(before.patients[0].visits),
          savedVisit = savedVisits.at(-1);
        assert.equal(savedVisit.procedure, 'Консультация');
        assert.equal(savedVisit.duration, 30);
        assert.equal(savedVisit.serviceItems[0].price, 1000);

        $('[data-view="services"]').click();
        await until(() => $('#toggle-service-edit'));
        $('#toggle-service-edit').click();
        if (change === 'rename') {
          $('[data-edit-service="s2"]').click();
          await until(() => $('#form-content [name="name"]'));
          $('#form-content [name="name"]').value = 'Новое название консультации';
          $('#form-content [name="duration"]').value = '60';
          $('#form-content [name="price"]').value = '9999';
          h.submit();
          await until(() => !$('#editor').open);
        } else {
          $('[data-delete-service="s2"]').click();
          await until(() => !$('[data-delete-service="s2"]'));
        }
        const after = await f.read();
        if (change === 'rename') {
          const service = after.services.find((s) => s.id === 's2');
          assert.equal(service.name, 'Новое название консультации');
          assert.equal(service.price, 9999);
          assert.equal(service.duration, '60 минут');
        } else
          assert.equal(
            after.services.some((s) => s.id === 's2'),
            false,
          );
        assert.deepEqual(after.patients[0].visits, savedVisits);

        const reopened = await f.ui(width);
        reopened.$('[data-view="clients"]').click();
        reopened.$('[data-client-filter="all"]').click();
        await until(() => reopened.$('[data-patient="p"]'));
        reopened.$('[data-patient="p"]').click();
        await until(() => reopened.$('[data-edit-visit="' + savedVisit.id + '"]'));
        assert.deepEqual(
          [...reopened.w.document.querySelectorAll('.print-service-row td:first-child')].map(
            (n) => n.textContent,
          ),
          ['Консультация'],
        );
        const edit = reopened.$('[data-edit-visit="' + savedVisit.id + '"]');
        edit.closest('details').querySelector('summary').click();
        edit.click();
        assert.equal(reopened.$('[name="procedure"]').value, 'Консультация');
        assert.equal(reopened.$('[name="duration"]').value, '30');
        assert.equal(reopened.$('[name="notes"]').value, 'Historical visit');
        assert.equal(reopened.w.document.querySelectorAll('.visit-procedure-row').length, 1);
        reopened.submit();
        await until(() => !reopened.$('#editor').open);
        assert.deepEqual((await f.read()).patients[0].visits, savedVisits);
        assert.deepEqual(h.errors, []);
        assert.deepEqual(reopened.errors, []);
      },
    );

test('server enforces completion links, duplicate protection, immutable planned data and stale revisions', async (t) => {
  const f = await fixture(t);
  let data = await f.read();
  data.patients[0].appointments = [
    {
      id: 'a',
      date: '2030-01-01',
      time: '10:00',
      duration: 60,
      service: 'Чистка',
      staffId: f.owner.accountId,
    },
  ];
  assert.equal((await f.save(data)).status, 200);
  data = await f.read();
  function complete(d) {
    d.patients[0].appointments[0].status = 'completed';
    d.patients[0].appointments[0].completedVisitId = 'v';
    d.patients[0].visits.push({
      id: 'v',
      date: '2026-10-03',
      time: '10:15',
      duration: 60,
      procedure: 'Чистка',
      appointmentId: 'a',
      staffId: f.owner.accountId,
      photos: [],
    });
    return d;
  }
  let bad = complete(structuredClone(data));
  bad.patients[1].visits.push(bad.patients[0].visits.pop());
  assert.equal((await f.save(bad)).status, 400);
  bad = complete(structuredClone(data));
  bad.patients[0].visits.push({ ...bad.patients[0].visits.at(-1), id: 'duplicate' });
  assert.equal((await f.save(bad)).status, 400);
  bad = complete(structuredClone(data));
  bad.patients[0].visits.at(-1).time = '10:17';
  assert.equal((await f.save(bad)).status, 400);
  bad = complete(structuredClone(data));
  bad.patients[0].appointments[0].status = 'unknown';
  assert.equal((await f.save(bad)).status, 400);
  assert.equal((await f.save(complete(structuredClone(data)))).status, 200);
  assert.equal((await f.save(complete(structuredClone(data)))).status, 409);
  data = await f.read();
  assert.equal(data.patients[0].appointments[0].date, '2026-10-03');
  assert.equal(data.patients[0].appointments[0].time, '10:15');
  bad = structuredClone(data);
  bad.patients[0].appointments[0].time = '11:00';
  assert.equal((await f.save(bad)).status, 400);
  bad = structuredClone(data);
  bad.patients[0].visits.at(-1).notes = 'Дополненные результаты';
  assert.equal((await f.save(bad)).status, 200);
  assert.equal(
    (await f.request('/api/telegram/patient?patientId=p', null, f.cookie)).data.appointments.length,
    0,
  );
  assert.equal(
    (await f.request('/api/telegram/remind', { patientId: 'p', appointmentId: 'a' }, f.cookie))
      .status,
    400,
  );
});
for (const width of [390, 1440])
  test(
    'earlier actual visit moves calendar date/time on completion and owner correction at width ' +
      width,
    async (t) => {
      const f = await fixture(t);
      let data = await f.read();
      data.patients[0].appointments = [
        {
          id: 'early',
          date: '2030-01-05',
          time: '10:00',
          service: 'Чистка',
          duration: 60,
          status: 'scheduled',
          staffId: f.owner.accountId,
          serviceItems: [
            {
              id: 's1',
              name: 'Чистка',
              category: 'cleansing',
              product: 'Средство',
              duration: 60,
              price: 2500,
            },
          ],
        },
      ];
      assert.equal((await f.save(data)).status, 200);
      const h = await f.ui(width),
        { $ } = h;
      $('[data-view="clients"]').click();
      $('[data-client-filter="all"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      await until(() => $('[data-complete-appointment="early"]'));
      $('[data-complete-appointment="early"]').click();
      await until(() => $('#editor').open && $('.visit-form-grid'));
      $('[name="date"]').value = '2030-01-04';
      $('[name="time"]').value = '09:15';
      h.submit();
      await until(() => !$('#editor').open);
      data = await f.read();
      const completed = structuredClone(data.patients[0].appointments[0]);
      assert.equal(completed.date, '2030-01-04');
      assert.equal(completed.time, '09:15');
      assert.equal(completed.duration, 60);
      $('[data-view="calendar"]').click();
      await until(() => $('[data-appointment-id="early"]'));
      assert.equal(
        $('[data-appointment-id="early"]').closest('[data-slot-date]').dataset.slotDate,
        '2030-01-04',
      );
      await visitFromRecord(h, '[data-appointment-id="early"]');
      assert.equal($('[name="date"]').value, '2030-01-04');
      $('[name="date"]').value = '2030-01-03';
      $('[name="time"]').value = '08:30';
      h.submit();
      await until(() => !$('#editor').open);
      data = await f.read();
      const a = data.patients[0].appointments[0],
        v = data.patients[0].visits.find((v) => v.id === a.completedVisitId);
      assert.notEqual(a.confirmationKey, completed.confirmationKey);
      assert.deepEqual(a, {
        ...completed,
        date: '2030-01-03',
        time: '08:30',
        confirmationKey: a.confirmationKey,
      });
      assert.equal(v.date, a.date);
      assert.equal(v.time, a.time);
      assert.equal(v.appointmentId, a.id);
      $('[data-view="calendar"]').click();
      await until(() => $('[data-appointment-id="early"]'));
      assert.equal(
        $('[data-appointment-id="early"]').closest('[data-slot-date]').dataset.slotDate,
        '2030-01-03',
      );
      const fresh = await f.ui(width);
      fresh.$('[data-view="clients"]').click();
      fresh.$('[data-client-filter="all"]').click();
      await until(() => fresh.$('[data-patient="p"]'));
      fresh.$('[data-patient="p"]').click();
      await until(() => fresh.$('[data-edit-visit="' + v.id + '"]'));
      fresh.$('[data-edit-visit="' + v.id + '"]').click();
      assert.equal(fresh.$('[name="date"]').value, '2030-01-03');
      assert.equal(fresh.$('[name="time"]').value, '08:30');
      fresh.$('#cancel-editor').click();
      assert.deepEqual(h.errors, []);
      assert.deepEqual(fresh.errors, []);
    },
  );

test('PUT/PATCH align legacy completed links only when touched; immutable fields and stale writes stay protected', async (t) => {
  const f = await fixture(t);
  let data = await f.read();
  const p = data.patients[0];
  p.appointments = [
    {
      id: 'legacy-a',
      date: '2030-01-05',
      time: '10:00',
      duration: 60,
      service: 'Чистка',
      status: 'completed',
      completedVisitId: 'legacy-v',
      staffId: f.owner.accountId,
    },
  ];
  p.visits.push({
    id: 'legacy-v',
    date: '2030-01-04',
    time: '09:00',
    procedure: 'Чистка',
    appointmentId: 'legacy-a',
    staffId: f.owner.accountId,
    photos: [],
  });
  f.seed(data);
  data = await f.read();
  // Changing a different patient does not migrate old dates as a side effect.
  let next = structuredClone(data);
  next.patients[1].notes = 'Другая карточка';
  assert.equal((await f.save(next)).status, 200);
  data = await f.read();
  assert.equal(data.patients[0].appointments[0].date, '2030-01-05');
  next = structuredClone(data);
  next.patients[0].visits.at(-1).notes = 'Дополнение';
  next.patients[0].appointments[0].service = 'Подмена';
  assert.equal((await f.patch(data, next)).status, 400);
  assert.equal((await f.read()).patients[0].appointments[0].date, '2030-01-05');
  next = structuredClone(data);
  next.patients[0].visits.at(-1).notes = 'Дополнение';
  const saved = await f.patch(data, next);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.patients[0].appointments[0].date, '2030-01-04');
  assert.equal(saved.data.patients[0].appointments[0].time, '09:00');
  assert.equal((await f.patch(data, next)).status, 409);
  data = await f.read();
  next = structuredClone(data);
  next.patients[0].visits.at(-1).date = '2030-01-03';
  next.patients[0].visits.at(-1).time = '';
  assert.equal((await f.save(next)).status, 200);
  data = await f.read();
  assert.equal(data.patients[0].appointments[0].date, '2030-01-03');
  assert.equal(data.patients[0].appointments[0].time, '09:00');
  // Same-day and later actual dates do not alter the saved schedule.
  for (const date of ['2030-01-03', '2030-01-06']) {
    next = structuredClone(data);
    next.patients[0].visits.at(-1).date = date;
    next.patients[0].visits.at(-1).time = '11:00';
    assert.equal((await f.save(next)).status, 200);
    data = await f.read();
    assert.equal(data.patients[0].appointments[0].date, '2030-01-03');
    assert.equal(data.patients[0].appointments[0].time, '09:00');
  }
});

test('administrator and cosmetologist complete own appointments without deleting calendar records', async (t) => {
  const f = await fixture(t);
  for (const role of ['salon_admin', 'cosmetologist']) {
    const email = role + '@example.test',
      password = 'Staff-test-password-2026';
    const invited = await f.request('/api/organization/invitations', { email, role }, f.cookie);
    assert.equal(invited.status, 201);
    const token = new URL(f.outbox.at(-1).url).hash.split('=')[1];
    assert.equal(invited.data.inviteUrl, undefined);
    const accepted = await f.request('/api/auth/invitations/accept', {
      token,
      email,
      password,
      passwordConfirmation: password,
      displayName: 'Test Staff',
    });
    assert.equal(accepted.status, 200);
    const id = accepted.data.accountId,
      login = await f.request('/api/auth/login', { email, password });
    const {
      members,
      canEdit,
      canEditStaffRules,
      canEditRoomAssignments,
      canEditRoomOverlap,
      ...workspace
    } = (await f.request('/api/workspace', null, f.cookie)).data;
    workspace.rooms[0].staffMode = 'multiple';
    workspace.rooms[0].staffIds.push(id);
    assert.equal((await f.request('/api/workspace', workspace, f.cookie)).status, 200);
    await require('./helpers/working-days.cjs').workingDays(
      f.dir,
      'workflow@example.test',
      'Workflow-test-password-2026',
      ['2030-01-01'],
      [id],
    );
    let data = await f.read();
    data.patients[0].appointments.push({
      id: role,
      date: '2030-01-01',
      time: '12:00',
      service: 'Чистка',
      duration: 60,
      staffId: id,
    });
    const scheduled = await f.save(data);
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));
    data = await f.read(login.cookie);
    const p = data.patients.find((p) => p.id === 'p'),
      a = p.appointments.find((a) => a.id === role);
    a.status = 'completed';
    a.completedVisitId = 'visit-' + role;
    p.visits.push({
      id: a.completedVisitId,
      date: '2026-10-03',
      procedure: 'Чистка',
      appointmentId: a.id,
      staffId: id,
      photos: [],
    });
    assert.equal((await f.save(data, login.cookie)).status, 200);
    const completed = (await f.read()).patients[0].appointments.find((a) => a.id === role);
    assert.equal(completed.date, '2026-10-03');
    assert.equal(completed.time, '12:00');
    const changed = await f.read(login.cookie);
    changed.patients[0].visits.find((v) => v.id === 'visit-' + role).date = '2026-10-02';
    assert.equal((await f.save(changed, login.cookie)).status, 403);
    const before = await f.read(login.cookie);
    before.patients[0].visits = [];
    before.patients[0].appointments = [];
    assert.equal((await f.save(before, login.cookie)).status, 403);
    assert.equal(
      (await f.read()).patients[0].appointments.find((a) => a.id === role).status,
      'completed',
    );
  }
});
test('same-name service change uses selected id and failed completion preserves form without adding history', async (t) => {
  const f = await fixture(t);
  let data = await f.read();
  data.patients[0].appointments = [
    {
      id: 'a',
      date: '2030-01-01',
      time: '10:00',
      service: 'Консультация',
      duration: 30,
      staffId: f.owner.accountId,
      status: 'scheduled',
      serviceItems: [
        {
          id: 's2',
          name: 'Консультация',
          category: 'consultation',
          product: '',
          duration: 30,
          price: 1000,
        },
      ],
    },
  ];
  assert.equal((await f.save(data)).status, 200);
  const h = await f.ui(390);
  h.$('[data-view="clients"]').click();
  h.$('[data-client-filter="all"]').click();
  await until(() => h.$('[data-patient="p"]'));
  h.$('[data-patient="p"]').click();
  await until(() => h.$('[data-card-appointment="a"]'));
  await editFromRecord(h, '[data-card-appointment="a"]');
  h.$('[data-remove-appointment-procedure="s2"]').click();
  addAppointmentProcedure(h, 's3');
  assert.equal(h.$('#appointment-duration').value, '45');
  h.submit();
  await until(() => !h.$('#editor').open);
  data = await f.read();
  assert.equal(data.patients[0].appointments[0].serviceItems[0].id, 's3');
  assert.equal(data.patients[0].appointments[0].serviceItems[0].price, 1500);
  h.$('[data-complete-appointment="a"]').click();
  await until(() => h.$('#editor').open);
  h.$('[name="notes"]').value = 'Несохранённый результат';
  // Another tab saves first; a completion with the old revision must fail atomically.
  data.patients[0].appointments[0].notes = 'Другая вкладка';
  assert.equal((await f.save(data)).status, 200);
  h.submit();
  await until(() => h.$('[data-save-recovery="check"]'));
  assert.equal(h.$('#save-editor').disabled, true);
  h.$('[data-save-recovery="check"]').click();
  await until(() => h.$('[data-save-recovery="review"]'));
  assert.equal(h.$('[data-save-recovery="retry"]'), null);
  assert.equal(h.$('#editor').open, true);
  assert.equal(h.$('[name="notes"]').value, 'Несохранённый результат');
  data = await f.read();
  assert.equal(data.patients[0].visits.length, 1);
  assert.equal(data.patients[0].appointments[0].status, 'scheduled');
  h.$('#cancel-editor').click();
  await until(() => !h.$('#editor').open);
  assert.deepEqual(h.errors, []);
});

for (const width of [320, 390, 700, 701, 1440])
  test(
    'visit forms use a stable mobile frame and internal scrolling at width ' + width,
    async (t) => {
      const f = await fixture(t),
        data = await f.read();
      data.patients[0].appointments = [
        {
          id: 'layout-appointment',
          date: '2030-01-01',
          time: '12:00',
          service: 'Консультация',
          duration: 30,
          status: 'scheduled',
        },
      ];
      const scheduled = await f.save(data);
      assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));
      const h = await f.ui(width),
        { $, w } = h,
        css = applyLayoutCss(h, width);
      $('[data-view="clients"]').click();
      $('[data-client-filter="all"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      await until(() => $('#new-visit'));
      function frame() {
        const dialog = css($('#editor')),
          content = css($('#form-content'));
        if (width <= 700) {
          assert.equal(dialog.position, 'fixed');
          assert.equal(dialog.inset, '8px');
          assert.equal(dialog.height, 'calc(100dvh - 16px)');
          assert.equal(dialog.overflow, 'hidden');
          assert.equal(css($('#editor-form')).display, 'grid');
          assert.equal(content.overflowY, 'auto');
          assert.equal(parseFloat(content.minHeight), 0);
          assert.equal(css($('.dialog-actions')).position, 'static');
          assert.equal(css(w.document.body).overflow, 'hidden');
        } else {
          assert.notEqual(dialog.height, 'calc(100dvh - 16px)');
          assert.notEqual(content.overflowY, 'auto');
        }
        return [dialog.height, dialog.width, dialog.inset];
      }
      for (const planned of [false, true]) {
        if (planned) {
          $('[data-complete-appointment="layout-appointment"]').click();
          await until(() => $('#editor').open);
        } else $('#new-visit').click();
        assert.match(
          $('#dialog-title').textContent,
          planned ? /Оформить проведённое посещение/ : /без записи/,
        );
        for (const fieldName of ['date', 'time']) {
          const input = $('.visit-form-grid [name="' + fieldName + '"]');
          assert.equal(input.type, fieldName);
          assert.equal(input.style.width, '');
          if (width <= 700) {
            const dimensions = css(input);
            assert.equal(dimensions.width, '100%');
            assert.equal(dimensions.maxWidth, '100%');
            assert.equal(dimensions.minWidth, '0px');
            assert.equal(dimensions.height, '46px');
            assert.equal(dimensions.minHeight, '46px');
            assert.equal(dimensions.maxHeight, '46px');
            assert.equal(dimensions.boxSizing, 'border-box');
            assert.equal(dimensions.appearance, 'none');
            assert.equal(dimensions.fontSize, '16px');
          }
          if (width <= 380)
            assert.equal(css(input.closest('.field')).gridColumn.replace(/\s/g, ''), '1/-1');
        }
        const visitTime = $('.visit-form-grid [name="time"]');
        visitTime.value = '23:45';
        assert.equal(visitTime.value, '23:45');
        assert.equal(visitTime.step, '300');
        const before = frame();
        pickVisitProcedure(h, 's1');
        pickVisitProcedure(h, 's3');
        const uploads = $('#upload-list');
        uploads.innerHTML = '<div class="upload-item">Тестовое фото</div>'.repeat(6);
        $('#form-error').textContent = 'Тестовая ошибка сохранения';
        $('[name="notes"]').value = 'Несохранённая заметка';
        $('[name="notes"]').focus();
        assert.deepEqual(frame(), before);
        assert.equal($('[name="notes"]').value, 'Несохранённая заметка');
        assert.equal($('.visit-form-grid [name="time"]').value, '23:45');
        assert.equal(css($('#visit-procedure')).fontSize, '16px');
        $('#cancel-editor').click();
        await until(() => !$('#editor').open);
      }
      // The mobile-only frame must stop applying to other editor kinds and on close.
      assert.notEqual(css(w.document.body).overflow, 'hidden');
      $('#new-patient-appointment').click();
      await until(() => $('#editor').open && $('#appointment-patient'));
      assert.notEqual(css($('#editor')).height, 'calc(100dvh - 16px)');
      $('#cancel-editor').click();
      assert.deepEqual(h.errors, []);
    },
  );

for (const width of [390, 1440])
  test(
    'service categories switch explicitly without swipe and preserve selection at width ' + width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h,
        css = applyLayoutCss(h, width);
      $('[data-view="services"]').click();
      assert.equal(css($('.service-category-select')).display, width <= 700 ? 'block' : 'none');
      assert.equal(css($('.service-category-nav')).display, width <= 700 ? 'none' : 'flex');
      assert.equal($('#service-category-select').options.length, 6);
      $('[data-select-service="s2"]').click();
      const nav = $('.service-category-nav');
      nav.scrollTop = 600;
      nav.dispatchEvent(new w.Event('scroll'));
      await new Promise((r) => setTimeout(r, 180));
      assert.equal($('.service-category-nav'), nav);
      assert.equal($('#service-category-select').value, 'all');
      const select = $('#service-category-select'),
        bar = $('.service-selection-bar'),
        search = $('#service-search');
      select.focus();
      let categoryRefocus = 0;
      select.addEventListener('focus', () => categoryRefocus++);
      select.value = 'cleansing';
      select.dispatchEvent(new w.Event('change', { bubbles: true }));
      assert.equal($('#service-category-select'), select);
      assert.equal($('.service-selection-bar'), bar);
      assert.equal($('#service-search'), search);
      assert.equal(categoryRefocus, 0);
      assert.equal(w.document.activeElement === select, width > 700);
      assert.equal(
        $('[data-service-category-tab="cleansing"]').getAttribute('aria-pressed'),
        'true',
      );
      assert.equal($('[data-service-category-tab="all"]').getAttribute('aria-pressed'), 'false');
      assert.equal($('#service-category-select').value, 'cleansing');
      assert.ok($('[data-select-service="s1"]'));
      assert.equal(w.document.querySelectorAll('.selected-service-card').length, 1);
      $('[data-select-service="s1"]').click();
      assert.equal(w.document.querySelectorAll('.selected-service-card').length, 2);
      assert.match($('.service-selection-total').textContent, /1,5 часа|90 минут/);
      $('#create-appointment-from-services').click();
      await until(() => $('#editor').open && $('#appointment-patient'));
      assert.equal($('#appointment-duration').value, '90');
      $('#cancel-editor').click();
      $('#toggle-service-edit').click();
      assert.equal($('#service-category-select').value, 'cleansing');
      assert.ok($('[data-edit-service="s1"]'));
      const editSelect = $('#service-category-select');
      editSelect.focus();
      editSelect.value = 'consultation';
      editSelect.dispatchEvent(new w.Event('change', { bubbles: true }));
      assert.equal($('#service-category-select'), editSelect);
      assert.equal(w.document.activeElement === editSelect, width > 700);
      assert.ok($('[data-edit-service="s2"]'));
      assert.equal($('[data-edit-service="s1"]'), null);
      assert.deepEqual(h.errors, []);
    },
  );

for (const width of [390, 1440])
  test(
    'compact service catalogue searches without focus loss and retains cross-category selections at width ' +
      width,
    async (t) => {
      const f = await fixture(t),
        data = await f.read();
      data.services.push({
        id: 'long-service',
        name: 'Очень длинное название индивидуальной услуги с подробным описанием встречи',
        category: 'care',
        duration: '60 минут',
        description: 'Подробное описание',
        price: 3500,
      });
      assert.equal((await f.save(data)).status, 200);
      const h = await f.ui(width),
        { $, w } = h,
        css = applyLayoutCss(h, width);
      $('[data-view="services"]').click();
      assert.equal($('#service-category-select').value, 'all');
      const cards = [...w.document.querySelectorAll('.service-select-card')];
      assert.equal(cards.length, 4);
      for (const card of cards) {
        assert.equal(css(card).height, 'auto');
        assert.equal(css(card).minHeight, width >= 981 ? '52px' : '76px');
        assert.equal(css(card).display, 'flex');
      }
      assert.equal($('.service-category-panel-heading'), null);
      assert.equal(w.document.querySelectorAll('.service-category-count').length, 0);
      assert.equal(
        $('[data-select-service="long-service"] strong').title,
        data.services.at(-1).name,
      );
      assert.equal(
        css($('.service-category-content')).gridTemplateColumns,
        width <= 700 ? 'minmax(0,1fr)' : 'repeat(auto-fill,minmax(min(300px,100%),1fr))',
      );
      $('[data-select-service="s2"]').click();
      const input = $('#service-search'),
        bar = $('.service-selection-bar');
      input.focus();
      input.value = 'ЧИСТК';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.equal($('#service-search'), input);
      assert.equal(w.document.activeElement, input);
      assert.equal($('.service-selection-bar'), bar);
      assert.equal(w.document.querySelectorAll('[data-select-service]').length, 1);
      assert.ok($('[data-select-service="s1"]'));
      $('[data-select-service="s1"]').click();
      assert.equal($('#service-search').value, 'ЧИСТК');
      assert.equal(w.document.querySelectorAll('.selected-service-card').length, 2);
      $('#clear-service-search').click();
      assert.equal($('#service-search').value, '');
      assert.equal(w.document.activeElement, $('#service-search'));
      assert.equal($('#clear-service-search').hidden, true);
      const query = $('#service-search');
      query.value = 'подробное описание';
      query.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.ok($('[data-select-service="long-service"]'));
      query.value = '<img src=x onerror=alert(1)>';
      query.dispatchEvent(new w.Event('input', { bubbles: true }));
      assert.match($('.service-category-empty').textContent, /не найдены/);
      assert.equal($('#service-category-panel img'), null);
      $('#toggle-service-edit').click();
      assert.equal($('#service-search').value, '<img src=x onerror=alert(1)>');
      assert.equal($('#service-search').getAttribute('onerror'), null);
      $('#clear-service-search').click();
      assert.ok($('[data-edit-service="long-service"]'));
      assert.ok($('[data-delete-service="long-service"]'));
      for (const card of w.document.querySelectorAll('.service-edit-card')) {
        assert.equal(css(card).height, 'auto');
        assert.equal(css(card).minHeight, width >= 981 ? '52px' : '76px');
        assert.equal(
          css(card.querySelector('.service-row-meta')).display,
          width >= 981 ? 'grid' : 'flex',
        );
        assert.equal(css(card.querySelector('.service-row-main')).margin, '0px');
        assert.equal(css(card.querySelector('.service-card-price')).padding, '0px');
      }
      $('#toggle-service-edit').click();
      $('#create-appointment-from-services').click();
      await until(() => $('#editor').open && $('#appointment-patient'));
      assert.equal($('#appointment-duration').value, '90');
      $('#cancel-editor').click();
      $('[data-service-category-tab="laser"]').click();
      assert.match($('.service-category-empty').textContent, /пока нет/);
      $('[data-new-service-category="laser"]').click();
      assert.equal($('[name="category"]').value, 'laser');
      $('#cancel-editor').click();
      assert.deepEqual(h.errors, []);
    },
  );

test('161 actual schema2 inspector and editor use point snapshots and point POST while preserving full history', async (t) => {
  const f = await fixture(t, { cabinetSchema: 2 });
  const data = await f.read();
  const appointment = {
    id: 'point161',
    date: '2030-01-01',
    time: '10:00',
    duration: 30,
    staffId: f.owner.accountId,
    service: 'Услуга из прежней картотеки',
  };
  data.patients[0].appointments = [
    appointment,
    { ...appointment, id: 'unrelated161', time: '14:00' },
  ];
  const seeded = await f.save(data);
  assert.equal(seeded.status, 200, JSON.stringify(seeded.data));
  const h = await f.ui(390),
    { $ } = h;
  $('[data-view="clients"]').click();
  $('[data-client-filter="all"]').click();
  await until(() => $('[data-patient="p"]'));
  $('[data-patient="p"]').click();
  await until(() => $('[data-card-appointment="point161"]'));
  h.requests.length = 0;
  const pointDto = await f.request(
    '/api/cabinet/patient?id=p&view=appointment&appointmentId=point161&details=1',
    null,
    f.cookie,
  );
  assert.equal(pointDto.status, 200, JSON.stringify(pointDto.data));
  try {
    await editFromRecord(h, '[data-card-appointment="point161"]');
  } catch (error) {
    throw Error(
      error.message +
        ' ' +
        JSON.stringify({
          requests: h.requests.map((r) => ({ route: r.route, method: r.method })),
          errors: h.errors,
          tail: h.w.document.body.textContent.slice(-1800),
        }),
    );
  }
  $('[name="notes"]').value = 'Entity edit161';
  h.submit();
  await until(() => !$('#editor').open);
  await until(() => !$('#save-editor').disabled && $('[data-card-appointment="point161"]'));
  $('[data-card-appointment="point161"]').click();
  await until(
    () => $('#editor').open && $('.appointment-action-notes')?.textContent === 'Entity edit161',
  );
  $('#cancel-editor').click();
  await until(() => !$('#editor').open);
  assert.ok(
    h.requests.some(
      (r) => String(r.route).includes('view=appointment') && String(r.route).includes('details=1'),
    ),
  );
  assert.equal(
    h.requests.filter(
      (r) =>
        String(r.route).startsWith('/api/cabinet/patient?') && !String(r.route).includes('view='),
    ).length,
    0,
  );
  const posted = h.requests.find(
    (r) => r.method === 'POST' && r.route === '/api/cabinet/appointments',
  );
  assert.ok(posted);
  assert.equal(posted.headers['X-Cartoteca-Appointment-Response'], 'point-v1');
  assert.equal('patients' in JSON.parse(posted.body), false);
  const saved = await f.read();
  assert.deepEqual(saved.patients[0].visits, data.patients[0].visits);
  assert.equal(
    saved.patients[0].appointments.find((a) => a.id === 'point161').notes,
    'Entity edit161',
  );
  assert.equal(
    saved.patients[0].appointments.some((a) => a.id === 'unrelated161'),
    true,
  );
  assert.deepEqual(h.errors, []);
});
