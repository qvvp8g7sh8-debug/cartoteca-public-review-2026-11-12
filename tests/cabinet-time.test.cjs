const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom'),
  { zonedClock } = require('../src/shared/time-zone.cjs');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { startsAt } = require('../src/server/modules/notifications/appointments.cjs');
const root = path.resolve(__dirname, '..'),
  instant = Date.parse('2026-10-05T20:30:00Z');
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error('Cabinet time UI timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('one instant yields organization dates and minutes, including midnight, independently of device zone', () => {
  const old = process.env.TZ;
  try {
    for (const device of ['Asia/Yerevan', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = device;
      assert.deepEqual(zonedClock(instant, 'Europe/Moscow'), {
        date: '2026-10-05',
        hour: 23,
        minute: 30,
      });
      assert.deepEqual(zonedClock(instant, 'Europe/Samara'), {
        date: '2026-10-06',
        hour: 0,
        minute: 30,
      });
      assert.deepEqual(zonedClock(instant, 'Asia/Kamchatka'), {
        date: '2026-10-06',
        hour: 8,
        minute: 30,
      });
      const saved = { date: '2026-10-05', time: '23:30' };
      assert.equal(startsAt(saved, 'Europe/Moscow'), instant);
      assert.equal(saved.time, '23:30');
    }
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});

test('background zone refresh drops stale accounts, preserves editor drafts and keeps last zone on failure', async (t) => {
  const w = new JSDOM('<input id="draft" value="unchanged">', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  }).window;
  t.after(() => w.close());
  w.AbortController = AbortController;
  for (const file of [
    'src/shared/time-zone.cjs',
    'src/client/shared/format.js',
    'src/client/modules/cabinet-time.js',
  ])
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const state = {
      multiUser: true,
      timeZone: 'Europe/Moscow',
      account: { id: 'a' },
      calendarAnchorDate: new w.Date(2030, 0, 1),
      currentView: 'settings',
      editorMode: { kind: 'visit' },
    },
    actions = {
      normalizePatientPhoneText,
      request: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      invalidateDirectory() {},
      invalidateCalendarRead() {},
    };
  let finish;
  Object.assign(
    actions,
    w.createFormat(state, actions),
    w.createZonedClock(state, actions),
    w.createCabinetTime(state, actions),
  );
  const first = actions.refreshCabinetTimeZone({ force: true });
  state.account = { id: 'b' };
  finish({ timeZone: 'Asia/Kamchatka' });
  await first;
  assert.equal(state.timeZone, 'Europe/Moscow');
  const second = actions.refreshCabinetTimeZone({ force: true });
  finish({ timeZone: 'Europe/Samara' });
  await second;
  assert.equal(state.timeZone, 'Europe/Samara');
  assert.equal(actions.isoDate(state.calendarAnchorDate), '2030-01-01');
  assert.equal(w.document.querySelector('#draft').value, 'unchanged');
  actions.request = async () => {
    throw Error('Synthetic offline');
  };
  await actions.refreshCabinetTimeZone({ force: true });
  assert.equal(state.timeZone, 'Europe/Samara');
  assert.equal(state.editorMode.kind, 'visit');
});

test('HTTP and mobile/desktop UI use the same organization zone for owner/staff, without moving stored records', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-time-')),
    platform = createPlatformStore(path.join(dir, 'platform'));
  const password = 'Synthetic-time-password',
    owner = await platform.registerOwner({
      email: 'time-owner@example.test',
      password,
      displayName: 'Synthetic',
      organizationName: 'Synthetic',
    });
  platform.verifyEmail(owner.verificationToken);
  const invitation = platform.createInvitation({
    organizationId: owner.organizationId,
    invitedBy: owner.accountId,
    role: 'cosmetologist',
  });
  const staff = await platform.acceptInvitation({
    token: invitation.token,
    email: 'time-staff@example.test',
    password,
    displayName: 'Synthetic',
  });
  const other = await platform.registerOwner({
    email: 'time-other@example.test',
    password,
    displayName: 'Synthetic',
    organizationName: 'Other',
  });
  platform.verifyEmail(other.verificationToken);
  await platform.bootstrapGlobalAdmin({
    email: 'time-global@example.test',
    password,
    displayName: 'Synthetic',
  });
  const settings = {
    enabled: false,
    leadMinutes: 60,
    timeZone: 'Europe/Moscow',
    showServices: true,
  };
  platform.telegram.saveSettings(owner.organizationId, owner.accountId, settings);
  platform.telegram.saveSettings(other.organizationId, other.accountId, {
    ...settings,
    timeZone: 'Asia/Kamchatka',
  });
  const storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  const patient = {
    id: 'synthetic-p',
    name: 'Synthetic',
    createdBy: staff.accountId,
    visits: [],
    appointments: [
      {
        id: 'synthetic-a',
        date: '2026-10-05',
        time: '23:30',
        duration: 30,
        staffId: staff.accountId,
        service: 'Synthetic',
      },
    ],
  };
  storage.write({ revision: 0, patients: [patient], services: [] });
  storage.close();
  platform.close();
  const server = createMultiServer({
      dataDir: dir,
      sendMail: null,
      telegramBot: null,
      telegramAutostart: false,
      supportAutostart: false,
    }),
    windows = [];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    windows.forEach((w) => w.close());
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const authContexts = new Map();
  async function request(route, cookie = '', body) {
    const r = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: base,
        Cookie: cookie,
        ...authContexts.get(cookie),
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
  for (const role of ['owner', 'staff', 'other', 'global'])
    cookies.push(
      (await request('/api/auth/login', '', { email: 'time-' + role + '@example.test', password }))
        .cookie,
    );
  for (const cookie of cookies.slice(0, 2)) {
    assert.deepEqual((await request('/api/cabinet/time-zone', cookie)).data, {
      timeZone: 'Europe/Moscow',
    });
    assert.equal(
      (await request('/api/cabinet/bootstrap?paged=1&limit=20', cookie)).data.timeZone,
      'Europe/Moscow',
    );
  }
  assert.equal(
    (await request('/api/cabinet/time-zone', cookies[2])).data.timeZone,
    'Asia/Kamchatka',
  );
  assert.equal((await request('/api/cabinet/time-zone', cookies[3])).status, 403);
  assert.equal((await request('/api/cabinet/time-zone')).status, 401);
  assert.equal(
    (
      await request('/api/telegram/settings', cookies[1], {
        ...settings,
        timeZone: 'Europe/Samara',
      })
    ).status,
    403,
  );
  const old = process.env.TZ;
  process.env.TZ = 'Asia/Yerevan';
  try {
    for (const [width, index] of [
      [390, 0],
      [1440, 1],
    ]) {
      const errors = [],
        vc = new VirtualConsole();
      vc.on('jsdomError', (e) => errors.push(e.message));
      const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
        url: base,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        virtualConsole: vc,
      }).window;
      windows.push(w);
      const RealDate = w.Date;
      w.Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [instant]));
        }
        static now() {
          return instant;
        }
      };
      w.structuredClone = structuredClone;
      w.AbortController = AbortController;
      w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
      w.confirm = () => true;
      w.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      w.HTMLDialogElement.prototype.close = function () {
        this.open = false;
      };
      let zoneLoaded = '';
      w.fetch = async (route, options = {}) => {
        const response = await fetch(base + route, {
          ...options,
          headers: { ...options.headers, Origin: base, Cookie: cookies[index] },
        });
        if (route === '/api/cabinet/time-zone')
          zoneLoaded = (await response.clone().json()).timeZone;
        return response;
      };
      const $ = (s) => w.document.querySelector(s);
      require('./helpers/client-bundle.cjs').evaluateClient(w);
      try {
        await until(() => !w.document.body.classList.contains('app-loading'));
      } catch (e) {
        throw Error('Startup: ' + $('#load-status').textContent + ' / ' + errors.join(';'));
      }
      assert.match($('.mobile-date-caption').textContent, /5 октября 2026/);
      assert.doesNotMatch($('.mobile-date-caption').textContent, /6 октября/);
      if (width === 1440) {
        assert.equal($('.current-time span').textContent, '23:30');
        assert.equal($('.current-time').hidden, false);
        assert.match($('.global-subtitle').textContent, /UTC\+03:00/);
      }
      $('[data-calendar-next]').click();
      $('[data-calendar-today]').click();
      assert.match($('.mobile-date-caption').textContent, /5 октября/);
      $('#calendar-new').click();
      await until(() => $('#appointment-patient-search'));
      assert.equal($('[name="date"]').value, '2026-10-05');
      $('#cancel-editor').click();
      $('[data-view="clients"]').click();
      await until(() => $('[data-patient="synthetic-p"]'));
      $('[data-patient="synthetic-p"]').click();
      await until(() => $('#empty-new'));
      $('#empty-new').click();
      assert.equal($('[name="date"]').value, '2026-10-05');
      $('[name="notes"]').value = 'Unsaved draft';
      const updated = await request('/api/telegram/settings', cookies[0], {
        ...settings,
        timeZone: 'Europe/Samara',
      });
      assert.equal(updated.status, 200);
      w.dispatchEvent(new w.Event('focus'));
      await until(() => zoneLoaded === 'Europe/Samara');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal($('[name="date"]').value, '2026-10-05');
      assert.equal($('[name="notes"]').value, 'Unsaved draft');
      assert.equal($('#editor').open, true);
      $('#cancel-editor').click();
      $('[data-view="calendar"]').click();
      $('[data-calendar-today]').click();
      await until(() => $('.mobile-date-caption').textContent.includes('6 октября'));
      const saved = (await request('/api/cabinet/patient?id=synthetic-p', cookies[index])).data
        .patients[0];
      assert.equal(saved.appointments[0].date, '2026-10-05');
      assert.equal(saved.appointments[0].time, '23:30');
      assert.equal(saved.visits.length, 0);
      assert.deepEqual(errors, []);
      await request('/api/telegram/settings', cookies[0], settings);
    }
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});
