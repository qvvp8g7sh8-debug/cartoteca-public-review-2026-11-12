const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { assertLifecycleChange } = require('../src/server/modules/cabinet/lifecycle.cjs');
const { isActiveAppointment } = require('../src/shared/appointment-status.cjs');
const { assertSchedule, busyIntervals } = require('../src/server/modules/workspace/policy.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
const { createUiActionTracker } = require('./helpers/ui-action-tracker.cjs');
const root = path.resolve(__dirname, '..');
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error('Outcome UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-outcomes-')),
    windows = [],
    platform = createPlatformStore(path.join(dir, 'platform')),
    password = 'Outcome-test-password-2026';
  const owner = await platform.registerOwner({
    email: 'owner@example.test',
    password,
    displayName: 'Test',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  const accounts = { owner };
  for (const role of ['cosmetologist', 'salon_admin']) {
    const invite = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    accounts[role] = await platform.acceptInvitation({
      token: invite.token,
      email: role + '@example.test',
      password,
      displayName: 'Test',
    });
  }
  const other = await platform.registerOwner({
    email: 'other@example.test',
    password,
    displayName: 'Other',
    organizationName: 'Other',
  });
  platform.verifyEmail(other.verificationToken);
  platform.close();
  const store = createStorage(path.join(dir, 'tenants', owner.organizationId));
  const a = (id, date, staffId) => ({
    id,
    date,
    time: '10:00',
    duration: 60,
    service: 'Test',
    staffId,
    roomId: 'main',
    status: 'scheduled',
    notes: 'Original note',
  });
  store.write({
    revision: 0,
    services: [{ id: 's', name: 'Test', type: 'Другое', duration: '60 минут', price: 100 }],
    patients: [
      {
        id: 'p',
        name: 'Test client',
        createdBy: accounts.cosmetologist.accountId,
        visits: [],
        appointments: [
          a('future', '2035-01-01', accounts.cosmetologist.accountId),
          a('past', '2000-01-01', accounts.cosmetologist.accountId),
        ],
      },
      {
        id: 'other-p',
        name: 'Other client',
        createdBy: owner.accountId,
        visits: [],
        appointments: [a('owner-a', '2035-01-01', owner.accountId)],
      },
    ],
  });
  store.close();
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
    supportAutostart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    try {
      for (const { w, requests } of windows) {
        w.dispatchEvent(new w.Event('pagehide'));
        await requests.close();
        w.close();
      }
    } finally {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const authContexts = new Map();
  async function request(route, body, cookie = '', method) {
    const r = await fetch(base + route, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        Origin: base,
        Cookie: cookie,
        ...authContexts.get(cookie),
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json(),
      nextCookie = r.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && r.status === 200)
      authContexts.set(nextCookie, authContextHeaders(data));
    return { status: r.status, data, cookie: nextCookie };
  }
  const cookies = {};
  for (const name of ['owner', 'cosmetologist', 'salon_admin', 'other'])
    cookies[name] = (
      await request('/api/auth/login', { email: name + '@example.test', password })
    ).cookie;
  const read = async (role = 'owner') => (await request('/api/cabinet', null, cookies[role])).data;
  async function change(id, status, role = 'owner', method = 'PATCH', mutate = () => {}) {
    const before = await read(role),
      after = structuredClone(before),
      p = after.patients.find((p) => p.appointments.some((a) => a.id === id));
    p.appointments.find((a) => a.id === id).status = status;
    mutate(p);
    const body =
      method === 'PUT'
        ? after
        : {
            revision: before.revision,
            patients: [
              { id: p.id, before: before.patients.find((old) => old.id === p.id), after: p },
            ],
            services: [],
          };
    return request(
      method === 'PUT' ? '/api/cabinet' : '/api/cabinet/changes',
      body,
      cookies[role],
      method,
    );
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
    let offline = false;
    const requests = createUiActionTracker({
      window: w,
      fetch: (route, options) =>
        offline && ['/api/cabinet/changes', '/api/cabinet/appointments'].includes(route)
          ? Promise.reject(new Error('offline test'))
          : fetch(base + route, {
              ...options,
              headers: { ...options.headers, Origin: base, Cookie: cookies.owner },
            }),
    });
    windows.push({ w, requests });
    w.fetch = requests.fetch;
    const mutation = (trigger, ready) =>
      requests.action({ method: 'POST', path: '/api/cabinet/appointments', trigger, ready });
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
      mutation,
      setOffline: (value) => {
        offline = value;
      },
      $: (s) => w.document.querySelector(s),
    };
  }
  return { dir, accounts, cookies, read, change, request, ui };
}
test('PUT/PATCH close without visits, stamp actor/time, reject future no-show and protect immutable outcomes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.change('future', 'no_show')).status, 400);
  assert.equal(
    (
      await f.change('future', 'cancelled', 'owner', 'PATCH', (p) => {
        const a = p.appointments[0];
        a.outcomeAt = 1;
        a.outcomeBy = 'forged';
      })
    ).status,
    200,
  );
  let data = await f.read(),
    a = data.patients[0].appointments[0];
  assert.equal(a.status, 'cancelled');
  assert.equal(a.outcomeBy, f.accounts.owner.accountId);
  assert.ok(a.outcomeAt > 1);
  assert.equal(data.patients[0].visits.length, 0);
  assert.equal((await f.change('past', 'no_show', 'cosmetologist', 'PUT')).status, 200);
  data = await f.read();
  assert.equal(data.patients[0].appointments[1].outcomeBy, f.accounts.cosmetologist.accountId);
  for (const status of ['scheduled', 'completed', 'no_show'])
    assert.equal((await f.change('future', status)).status, 400);
  const body = structuredClone(data);
  body.patients[0].appointments[0].outcomeAt = 1;
  assert.equal((await f.request('/api/cabinet', body, f.cookies.owner, 'PUT')).status, 400);
  assert.equal((await f.change('owner-a', 'cancelled', 'salon_admin')).status, 200);
  assert.equal((await f.request('/api/cabinet/patient?id=p', null, f.cookies.other)).status, 404);
  const directory = await f.request('/api/cabinet/directory?limit=20', null, f.cookies.owner);
  assert.equal(directory.status, 200);
  assert.ok((await f.read()).patients.every((p) => p.visits.length === 0));
});
test('outcomes respect stale snapshots and reject confirmation/reminders; schedules and summaries ignore closed entries', async (t) => {
  const f = await fixture(t),
    before = await f.read();
  assert.equal((await f.change('future', 'cancelled')).status, 200);
  let data = await f.read();
  const a = data.patients[0].appointments[0];
  const stale = structuredClone(before);
  stale.patients[0].appointments[0].status = 'no_show';
  assert.equal((await f.request('/api/cabinet', stale, f.cookies.owner, 'PUT')).status, 400);
  const old = structuredClone(before.patients[0]),
    updated = structuredClone(old);
  updated.appointments[0].status = 'cancelled';
  assert.equal(
    (
      await f.request(
        '/api/cabinet/changes',
        {
          revision: before.revision,
          patients: [{ id: 'p', before: old, after: updated }],
          services: [],
        },
        f.cookies.owner,
        'PATCH',
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(
        '/api/appointments/confirmation',
        {
          patientId: 'p',
          appointmentId: 'future',
          confirmed: true,
          expectedFingerprint: a.confirmationKey,
        },
        f.cookies.owner,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        '/api/telegram/remind',
        { patientId: 'p', appointmentId: 'future' },
        f.cookies.owner,
      )
    ).status,
    400,
  );
  const status = await f.request('/api/telegram/patient?patientId=p', null, f.cookies.owner);
  assert.equal(
    status.data.appointments.find((a) => a.appointmentId === 'future').status,
    'cancelled',
  );
  const active = {
    id: 'replacement',
    date: a.date,
    time: a.time,
    duration: 60,
    roomId: 'main',
    staffId: a.staffId,
  };
  const settings = { enabled: true, rooms: [{ id: 'main', active: true, staffIds: [a.staffId] }] };
  assert.doesNotThrow(() =>
    assertSchedule(
      settings,
      { patients: [{ appointments: [a, active] }] },
      new Set([a.staffId]),
      'Europe/Moscow',
      0,
    ),
  );
  assert.deepEqual(
    busyIntervals(
      settings,
      { patients: [{ appointments: [a] }] },
      { role: 'cosmetologist', accountId: a.staffId },
      '2035-01-01',
      '2035-01-01',
    ),
    [],
  );
  assert.equal(isActiveAppointment(a), false);
});
test('no-show boundary is checked in the organization zone, not the device zone', () => {
  const a = { id: 'a', date: '2030-01-01', time: '10:00', status: 'scheduled' },
    before = { patients: [{ id: 'p', appointments: [a], visits: [] }] };
  const draft = () => ({
    patients: [{ id: 'p', appointments: [{ ...a, status: 'no_show' }], visits: [] }],
  });
  assert.throws(() =>
    assertLifecycleChange(before, draft(), {
      actorId: 'staff',
      timeZone: 'Europe/Moscow',
      now: Date.parse('2030-01-01T06:59:59Z'),
    }),
  );
  assert.doesNotThrow(() =>
    assertLifecycleChange(before, draft(), {
      actorId: 'staff',
      timeZone: 'Europe/Moscow',
      now: Date.parse('2030-01-01T07:00:00Z'),
    }),
  );
  assert.doesNotThrow(() =>
    assertLifecycleChange(before, draft(), {
      actorId: 'staff',
      timeZone: 'Asia/Yekaterinburg',
      now: Date.parse('2030-01-01T05:00:00Z'),
    }),
  );
});
test('staff cannot close a colleague appointment; closing immediately clears queued jobs and manual confirmation', async (t) => {
  const f = await fixture(t),
    before = await f.read(),
    p = before.patients.find((p) => p.id === 'other-p'),
    after = structuredClone(p);
  after.appointments[0].status = 'cancelled';
  assert.equal(
    (
      await f.request(
        '/api/cabinet/changes',
        { revision: before.revision, patients: [{ id: p.id, before: p, after }], services: [] },
        f.cookies.cosmetologist,
        'PATCH',
      )
    ).status,
    403,
  );
  const a = before.patients[0].appointments[0];
  assert.equal(
    (
      await f.request(
        '/api/appointments/confirmation',
        {
          patientId: 'p',
          appointmentId: a.id,
          confirmed: true,
          expectedFingerprint: a.confirmationKey,
        },
        f.cookies.owner,
      )
    ).status,
    200,
  );
  const platform = createPlatformStore(path.join(f.dir, 'platform'));
  try {
    platform.telegram.enqueue(
      f.accounts.owner.organizationId,
      'p',
      a,
      fingerprint(a, 'Europe/Moscow'),
      { chatId: '123' },
      Date.parse('2035-01-01T07:00:00Z'),
    );
    assert.equal(platform.telegram.counts(f.accounts.owner.organizationId).pending, 1);
  } finally {
    platform.close();
  }
  assert.equal((await f.change('future', 'cancelled')).status, 200);
  const inspect = createPlatformStore(path.join(f.dir, 'platform'));
  try {
    assert.equal(inspect.telegram.counts(f.accounts.owner.organizationId).cancelled, 1);
    assert.equal(
      inspect.appointmentConfirmations.read(
        f.accounts.owner.organizationId,
        'p',
        a,
        'Europe/Moscow',
      ),
      null,
    );
  } finally {
    inspect.close();
  }
  assert.equal((await f.read()).patients[0].appointments[0].manualConfirmedAt, null);
});
for (const width of [390, 1440])
  test(
    'card and calendar offer guarded outcomes and book again creates a separate record at ' + width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h;
      $('[data-view="clients"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      await until(() => $('[data-appointment-row="future"]'));
      assert.equal($('[data-appointment-row="future"] [data-appointment-outcome="no_show"]'), null);
      assert.ok($('[data-appointment-row="past"] [data-appointment-outcome="no_show"]'));
      w.confirm = () => false;
      $('[data-appointment-row="future"] [data-appointment-outcome="cancelled"]').click();
      assert.equal((await f.read()).patients[0].appointments[0].status, 'scheduled');
      w.confirm = () => true;
      h.setOffline(true);
      await assert.rejects(
        h.mutation(
          () => $('[data-appointment-row="future"] [data-appointment-outcome="cancelled"]').click(),
          () => $('[data-save-recovery="check"]'),
        ),
        { code: 'UI_ACTION_TRANSPORT' },
      );
      await until(() => $('[data-save-recovery="check"]'));
      assert.equal((await f.read()).patients[0].appointments[0].status, 'scheduled');
      h.setOffline(false);
      $('[data-save-recovery="check"]').click();
      await until(() => $('[data-save-recovery="retry"]'));
      // Match this POST, its consumed body, then the application result; no response-only acknowledgement.
      await h.mutation(
        () => $('[data-save-recovery="retry"]').click(),
        () => $('[data-book-again="p"]'),
      );
      assert.equal($('[data-appointment-row="future"]'), null);
      assert.match($('.appointment-outcome-history').textContent, /Отменена/);
      $('[data-book-again="p"]').click();
      await until(() => $('#appointment-patient'));
      assert.equal($('#save-editor').hidden, false);
      assert.equal($('[name="patientId"]').value, 'p');
      $('[name="date"]').value = '2035-01-02';
      $('[data-appointment-service="s"]').closest('details').open = true;
      $('[data-appointment-service="s"]').click();
      await h.mutation(
        () =>
          $('#editor-form').dispatchEvent(
            new w.Event('submit', { bubbles: true, cancelable: true }),
          ),
        () => !$('#editor').open,
      );
      const repeat = (await f.read()).patients[0].appointments.find((a) => a.date === '2035-01-02');
      assert.ok(repeat);
      assert.notEqual(repeat.id, 'future');
      assert.equal(isActiveAppointment(repeat), true);
      $('[data-card-appointment="past"]').click();
      await until(() => $('#editor .appointment-action-options [data-complete-appointment]'));
      assert.ok($('#editor .appointment-action-options [data-complete-appointment]'));
      assert.ok($('#editor .appointment-action-outcomes [data-appointment-outcome="no_show"]'));
      assert.ok($('#editor .appointment-action-options [data-open-appointment-patient]'));
      assert.equal(
        w.document.querySelectorAll('#editor [data-delete-appointment-action]').length,
        1,
      );
      for (const selector of [
        '[data-complete-appointment]',
        '[data-appointment-outcome=\"no_show\"]',
        '[data-open-appointment-patient]',
        '[data-delete-appointment-action]',
      ])
        assert.equal($('#editor ' + selector).closest('details'), null);
      assert.ok($('#editor details[data-notification-history]'));
      assert.equal($('#save-editor').hidden, true);
      await h.mutation(
        () => $('#editor [data-appointment-outcome="no_show"]').click(),
        () => !$('#editor').open && !$('[data-appointment-row="past"]'),
      );
      assert.equal((await f.read()).patients[0].visits.length, 0);
      assert.equal($('[data-appointment-row="past"]'), null);
      assert.match(
        w.document.querySelectorAll('.appointment-outcome-history')[0].parentElement.textContent,
        /Не пришёл/,
      );
      const data = await f.read();
      assert.equal(data.patients[0].appointments[1].status, 'no_show');
      assert.equal(data.patients[0].appointments[0].status, 'cancelled');
      assert.deepEqual(h.errors, []);
      $('[data-view="calendar"]').click();
      $('[data-calendar-mode="list"]').click();
      const choice = w.document.createElement('button');
      choice.dataset.overviewDate = '2000-01-01';
      w.document.body.append(choice);
      choice.click();
      choice.remove();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal($('#global-view [data-calendar-state][data-appointment-id="past"]'), null);
    },
  );
