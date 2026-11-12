const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const read = (name) => fs.readFileSync('src/client/' + name, 'utf8');
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function schedulerFixture() {
  let now = 0,
    id = 0;
  const timers = new Map();
  const factory = vm.runInNewContext(read('core/read-scheduler.js') + '\ncreateReadScheduler', {
    AbortController,
    Date: { now: () => now },
    setTimeout(fn, ms) {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(key) {
      timers.delete(key);
    },
  });
  return {
    api: factory({}),
    advance(ms) {
      now += ms;
      for (const [key, row] of [...timers])
        if (row.at <= now) {
          timers.delete(key);
          row.fn();
        }
    },
  };
}

test('scheduler reserves capacity for user/calendar, dedups only inflight, and prioritizes queued user work', async () => {
  const { api } = schedulerFixture(),
    work = [],
    starts = [];
  const run = (name) => {
    starts.push(name);
    const item = deferred();
    work.push(item);
    return item.promise;
  };
  const background = api.scheduleRead(() => run('background'), {
    priority: 'background',
    key: 'bg',
  });
  const queuedBackground = api.scheduleRead(() => run('background2'), { priority: 'background' });
  const users = Array.from({ length: 3 }, (_, i) =>
    api.scheduleRead(() => run('user' + i), { key: 'u' + i }),
  );
  const joined = api.scheduleRead(
    () => {
      throw Error('duplicate');
    },
    { key: 'u0' },
  );
  assert.equal(joined, users[0]);
  const calendar = api.scheduleRead(() => run('calendar'), { priority: 'calendar' });
  const user = api.scheduleRead(() => run('next-user'));
  assert.deepEqual(starts, ['background', 'user0', 'user1', 'user2']);
  work[1].resolve('ok');
  await users[0];
  await flush();
  assert.equal(starts[4], 'next-user');
  work[4].resolve();
  await user;
  await flush();
  assert.equal(starts[5], 'calendar');
  for (const row of work) row.resolve();
  await flush();
  for (const row of work) row.resolve();
  await Promise.all([background, queuedBackground, ...users, calendar]);
  let calls = 0;
  await api.scheduleRead(() => ++calls, { key: 'u0' });
  assert.equal(calls, 1, 'settled reads never provide a TTL authority cache');
});

test('scheduler cancellation settles queue without starting it and holds nonabortable transport slots until settle', async () => {
  const { api } = schedulerFixture(),
    work = Array.from({ length: 4 }, deferred);
  const active = work.map((item) => api.scheduleRead(() => item.promise).catch((error) => error));
  let starts = 0;
  const queued = api
    .scheduleRead(() => {
      starts++;
    })
    .catch((error) => error);
  api.cancelReadTasks();
  const errors = await Promise.all([...active, queued]);
  assert.ok(errors.every((error) => error.outcomeUnknown === false));
  assert.equal(starts, 0);
  const later = api.scheduleRead(() => {
    starts++;
  });
  assert.equal(starts, 0, 'aborting nonabortable import cannot release physical slot');
  work[0].resolve();
  await flush();
  await later;
  assert.equal(starts, 1);
  work.slice(1).forEach((item) => item.resolve());
  await flush();
});

test('background failures and deadlines back off while foreground retries remain available', async () => {
  const f = schedulerFixture();
  let calls = 0;
  await assert.rejects(
    f.api.scheduleRead(
      () => {
        calls++;
        throw Error('offline');
      },
      { priority: 'background', key: 'scope/url' },
    ),
  );
  await assert.rejects(
    f.api.scheduleRead(
      () => {
        calls++;
      },
      { priority: 'background', key: 'scope/url' },
    ),
  );
  assert.equal(calls, 1);
  await f.api.scheduleRead(
    () => {
      calls++;
    },
    { key: 'scope/url' },
  );
  assert.equal(calls, 2);
  const hung = deferred();
  const timeout = f.api
    .scheduleRead(() => hung.promise, { priority: 'background', key: 'timeout', timeoutMs: 20 })
    .catch((error) => error);
  f.advance(21);
  assert.equal((await timeout).outcomeUnknown, false);
  await assert.rejects(
    f.api.scheduleRead(
      () => {
        calls++;
      },
      { priority: 'background', key: 'timeout' },
    ),
  );
  assert.equal(calls, 2);
  hung.resolve();
  await flush();
});

function startupFixture(t) {
  const w = new JSDOM('<body class="app-loading"><p id="load-status" role="status"></p></body>', {
    url: 'https://synthetic.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  }).window;
  t.after(() => w.close());
  const state = {
    serviceSeed: [],
    assistantGeneration: 0,
    calendarMode: 'week',
    calendarAnchorDate: new Date(2026, 10, 8),
    workspace: {},
    data: [],
  };
  const calls = [],
    handlers = new Map();
  const account = { id: 'synthetic', organizationId: 'synthetic-org', role: 'owner' };
  w.structuredClone = structuredClone;
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    resetAssistant() {},
    applyAssistantScope() {},
    applyCabinetTimeZone() {},
    applyServiceGroups() {},
    initializeDirectory() {},
    rememberCabinet() {},
    legacyData: () => null,
    canManageTeam: () => true,
    toast() {},
    scheduleSettingsLoad() {},
    scheduleAssistantLoad() {},
    isoDate: (date) => date.toISOString().slice(0, 10),
    weekStart: (date) => date,
    setView(view) {
      state.currentView = view;
      calls.push('render');
    },
  };
  w.fetch = (url, options) => {
    calls.push(url);
    const handler =
      handlers.get(url) ||
      [...handlers].find(([key]) => key.endsWith('*') && url.startsWith(key.slice(0, -1)))?.[1];
    const result = handler
      ? handler(options)
      : url === '/api/auth/session'
        ? { user: account, multiUser: true, lazyReads: true }
        : url.startsWith('/api/cabinet/bootstrap')
          ? { patients: [], directory: [], services: [], initialized: true, revision: 1 }
          : url === '/api/workspace'
            ? { rooms: [], staffRules: [], revision: 1 }
            : url.startsWith('/api/cabinet/calendar?')
              ? { appointments: [{ id: 'synthetic-event' }] }
              : { members: [] };
    return Promise.resolve(result).then((value) => ({
      ok: true,
      status: 200,
      json: async () => value,
    }));
  };
  for (const [file, factory] of [
    ['core/read-scheduler.js', 'createReadScheduler'],
    ['core/session.js', 'createSession'],
    ['core/background-refresh.js', 'createBackgroundRefresh'],
    ['modules/workspace-data.js', 'createWorkspaceData'],
    ['core/cabinet-queries.js', 'createCabinetQueries'],
    ['core/session-startup.js', 'createSessionStartup'],
  ]) {
    w.eval(read(file));
    Object.assign(actions, w[factory](state, actions));
  }
  return { w, state, calls, handlers, actions, account };
}

test('real startup modules use one attempt and show real calendar without waiting optional team access', async (t) => {
  const f = startupFixture(t),
    access = deferred();
  f.handlers.set('/api/organization/access', () => access.promise);
  const first = f.actions.initialize();
  assert.equal(first, f.actions.initialize());
  await first;
  assert.equal(f.state.sessionReady, true, f.w.document.querySelector('#load-status').textContent);
  assert.equal(f.state.calendarRecords[0].id, 'synthetic-event');
  assert.equal(f.calls.filter((route) => route === '/api/auth/session').length, 1);
  assert.ok(f.calls.indexOf('render') < f.calls.indexOf('/api/organization/access'));
  access.resolve({ members: [] });
  await flush();
});

for (const route of ['/api/workspace', '/api/cabinet/calendar'])
  test(
    'required ' + route + ' failure keeps app blocked and actionable retry restores it',
    async (t) => {
      const f = startupFixture(t);
      const exact = route.includes('calendar') ? route + '*' : route;
      f.handlers.set(exact, () => Promise.reject(Error('synthetic offline')));
      await f.actions.initialize();
      assert.equal(f.state.sessionReady, false);
      assert.equal(f.state.startupStatus, 'error');
      assert.equal(f.w.document.body.classList.contains('app-loading'), true);
      const retry = f.w.document.querySelector('#load-status button');
      assert.ok(retry);
      f.handlers.delete(exact);
      retry.click();
      await flush();
      assert.equal(
        f.state.sessionReady,
        true,
        f.w.document.querySelector('#load-status').textContent,
      );
      assert.equal(f.state.calendarRecords[0].id, 'synthetic-event');
    },
  );

test('pagehide interruption then pageshow resumes one read attempt and never replays writes', async (t) => {
  const f = startupFixture(t),
    hung = deferred();
  let first = true;
  f.handlers.set('/api/auth/session', () =>
    first ? ((first = false), hung.promise) : { user: f.account, multiUser: true, lazyReads: true },
  );
  const initial = f.actions.initialize();
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  f.w.dispatchEvent(new f.w.Event('pageshow'));
  await initial;
  await flush();
  assert.equal(f.state.sessionReady, true, f.w.document.querySelector('#load-status').textContent);
  assert.equal(f.calls.filter((url) => url === '/api/auth/session').length, 2);
  assert.equal(f.calls.filter((url) => url.startsWith('/api/cabinet/bootstrap')).length, 1);
  hung.resolve({ user: { id: 'stale' } });
  await flush();
  assert.equal(f.state.account.id, f.account.id);
});

test('queued reads cannot execute under a changed role/account, and explicit consumer abort does not poison shared reads', async (t) => {
  const f = startupFixture(t);
  f.state.account = { ...f.account };
  const work = Array.from({ length: 4 }, deferred);
  const blockers = work.map((item) => f.actions.scheduleRead(() => item.promise));
  const queued = f.actions.request('/api/synthetic-queued').catch((error) => error);
  f.state.account.role = 'cosmetologist';
  work[0].resolve();
  await flush();
  assert.equal((await queued).status, 428);
  assert.equal(f.calls.includes('/api/synthetic-queued'), false);
  work.slice(1).forEach((item) => item.resolve());
  await Promise.all(blockers);
  const pending = deferred();
  f.handlers.set('/api/synthetic-shared', () => pending.promise);
  const shared = f.actions.request('/api/synthetic-shared');
  const caller = new f.w.AbortController();
  const cancelled = f.actions
    .request('/api/synthetic-shared', { signal: caller.signal })
    .catch((error) => error);
  caller.abort();
  pending.resolve({ complete: true });
  assert.equal((await shared).complete, true);
  assert.equal((await cancelled).outcomeUnknown, false);
});

test('the fresh assistant scope takes the next slot without exceeding the read limit', async (t) => {
  const f = startupFixture(t);
  f.state.account = { ...f.account };
  const work = Array.from({ length: 4 }, deferred);
  const blockers = work.map((item) => f.actions.scheduleRead(() => item.promise));
  const ordinary = '/api/synthetic-read',
    scope = '/api/assistant/scope',
    ordinaryResponse = deferred(),
    controller = new f.w.AbortController();
  f.handlers.set(ordinary, () => ordinaryResponse.promise);
  f.handlers.set(scope, (options) => {
    assert.equal(options.headers['X-Cartoteca-Account-Id'], f.account.id);
    assert.equal(options.headers['X-Cartoteca-Organization-Id'], f.account.organizationId);
    return { enabled: true };
  });
  const ordinaryRead = f.actions.request(ordinary);
  const scopeRead = f.actions.request(scope, { assistantRequest: true, signal: controller.signal });
  assert.deepEqual(f.calls, [], 'all four read slots remain occupied');
  work[0].resolve();
  await flush();
  const firstStarted = f.calls[0];
  ordinaryResponse.resolve({ complete: true });
  work.slice(1).forEach((item) => item.resolve());
  assert.equal((await scopeRead).enabled, true);
  assert.equal((await ordinaryRead).complete, true);
  await Promise.all(blockers);
  t.diagnostic(JSON.stringify({ firstStarted, fetches: f.calls }));
  assert.equal(firstStarted, scope);
  assert.deepEqual(f.calls, [scope, ordinary]);
});

test('a cancelled or changed-context assistant scope never uses its queued read slot', async (t) => {
  for (const reason of ['cancel', 'role']) {
    const f = startupFixture(t);
    f.state.account = { ...f.account };
    const work = Array.from({ length: 4 }, deferred);
    const blockers = work.map((item) => f.actions.scheduleRead(() => item.promise));
    const controller = new f.w.AbortController();
    const pending = f.actions
      .request('/api/assistant/scope', { assistantRequest: true, signal: controller.signal })
      .catch((error) => error);
    if (reason === 'cancel') controller.abort();
    else f.state.account.role = 'cosmetologist';
    work.forEach((item) => item.resolve());
    const error = await pending;
    assert.equal(error.status, reason === 'role' ? 428 : undefined);
    assert.equal(error.outcomeUnknown, false);
    assert.deepEqual(f.calls, []);
    await Promise.all(blockers);
  }
});

test('startup deadline is finite, online retries READs, and a late timed-out response cannot replace current account', async (t) => {
  const f = startupFixture(t),
    late = deferred();
  f.handlers.set('/api/auth/session', () => late.promise);
  const request = f.actions.request;
  f.actions.request = (url, options) => request(url, { ...options, timeoutMs: 10 });
  await f.actions.initialize();
  assert.equal(f.state.sessionReady, false);
  assert.equal(f.state.startupStatus, 'error');
  f.handlers.delete('/api/auth/session');
  f.w.dispatchEvent(new f.w.Event('online'));
  await flush();
  assert.equal(f.state.sessionReady, true);
  late.resolve({ user: { id: 'stale-timeout' } });
  await flush();
  assert.equal(f.state.account.id, f.account.id);
});

test('initial nonpersisted pageshow cannot queue a second startup deadline or hide the first retry error', async (t) => {
  const f = startupFixture(t),
    late = deferred();
  f.handlers.set('/api/auth/session', () => late.promise);
  const request = f.actions.request;
  f.actions.request = (url, options) => request(url, { ...options, timeoutMs: 10 });
  const first = f.actions.initialize();
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pageshow', { persisted: false }));
  await first;
  await flush();
  assert.equal(f.calls.filter((url) => url === '/api/auth/session').length, 1);
  assert.equal(f.state.startupStatus, 'error');
  assert.equal(f.state.sessionReady, false);
  assert.ok(f.w.document.querySelector('#load-status button'));
  late.resolve({ user: null });
  await flush();
});

test('persisted pageshow retains failed startup recovery without a new document', async (t) => {
  const f = startupFixture(t);
  f.handlers.set('/api/auth/session', () => Promise.reject(Error('synthetic offline')));
  await f.actions.initialize();
  assert.equal(f.state.startupStatus, 'error');
  f.handlers.delete('/api/auth/session');
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pageshow', { persisted: true }));
  await flush();
  assert.equal(f.calls.filter((url) => url === '/api/auth/session').length, 2);
  assert.equal(f.state.sessionReady, true);
});

for (const status of [401, 428])
  test(
    'terminal startup authentication status ' + status + ' never loops on online/focus',
    async (t) => {
      const f = startupFixture(t);
      let count = 0;
      f.actions.request = async () => {
        count++;
        throw Object.assign(Error('synthetic terminal auth'), { status });
      };
      await f.actions.initialize();
      f.w.dispatchEvent(new f.w.Event('online'));
      f.w.dispatchEvent(new f.w.Event('focus'));
      await flush();
      assert.equal(count, 1);
      assert.equal(f.state.sessionReady, false);
      assert.equal(f.state.startupStatus, 'redirecting');
      assert.equal(f.w.document.querySelector('#load-status button'), null);
    },
  );

test('interrupted unknown legacy migration is never replayed by resumed startup', async (t) => {
  const f = startupFixture(t),
    migration = deferred();
  let writes = 0;
  f.handlers.set('/api/cabinet/bootstrap?paged=1&limit=20', () => ({
    patients: [],
    initialized: false,
    revision: 0,
  }));
  f.actions.legacyData = () => ({ patients: [] });
  f.actions.migrateLegacy = () => {
    writes++;
    return migration.promise;
  };
  const first = f.actions.initialize();
  await flush();
  assert.equal(writes, 1);
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  f.w.dispatchEvent(new f.w.Event('pageshow'));
  migration.reject(Object.assign(Error('unknown save'), { outcomeUnknown: true }));
  await first;
  await flush();
  assert.equal(writes, 1);
  assert.equal(f.state.sessionReady, true);
  assert.equal(f.calls.filter((url) => url.startsWith('/api/cabinet/bootstrap')).length, 2);
});

test('failed resume probe blocks flushes and ordinary polling until a successful fresh session', async (t) => {
  const f = startupFixture(t);
  await f.actions.initialize();
  let flushes = 0,
    calendar = 0;
  f.actions.flushCalendarRedraw = ({ presentationOnly = false } = {}) => {
    if (!presentationOnly) flushes++;
  };
  f.actions.loadCalendarRecords = () => {
    calendar++;
  };
  f.actions.bookingInboxInterval = () => 30000;
  f.actions.bookingInboxDeadline = () => Infinity;
  f.actions.bookingHealthInterval = () => 30000;
  f.actions.bookingHealthDeadline = () => Infinity;
  f.actions.refreshBookingHealth = () => {};
  f.actions.refreshBookingInbox = () => {};
  f.actions.refreshCabinetTimeZone = () => {};
  f.actions.loadCalendarSchedule = () => {};
  f.actions.syncVisibleTelegram = () => {};
  f.actions.loadRoomAvailability = () => {};
  f.actions.updateCurrentTime = () => {};
  f.actions.improvementsVisible = () => false;
  f.actions.earlyAccessVisible = () => false;
  f.handlers.set('/api/auth/session', () => Promise.reject(Error('offline')));
  await f.actions.refreshBackground({ reason: 'resume' });
  await f.actions.refreshBackground();
  assert.equal(flushes, 0);
  assert.equal(calendar, 0);
  f.handlers.delete('/api/auth/session');
  const now = f.w.Date.now();
  f.w.Date.now = () => now + 3000;
  await f.actions.refreshBackground();
  assert.equal(flushes, 1);
  assert.equal(calendar, 1);
});

test('fresh session reconciliation bypasses an occupied background import slot', async (t) => {
  const f = startupFixture(t),
    importWork = deferred();
  f.state.account = f.account;
  const background = f.actions.scheduleRead(() => importWork.promise, { priority: 'background' });
  const session = await f.actions.readBackground('/api/auth/session');
  assert.equal(session.user.id, f.account.id);
  assert.equal(f.calls.filter((url) => url === '/api/auth/session').length, 1);
  importWork.resolve();
  await background;
});

test('manual settings joins and promotes queued passive preload with the compatible resource URL', async (t) => {
  const w = new JSDOM(
    '<meta name="cartoteca-build" content="release-current"><meta name="cartoteca-resource-app-settings" content="resource-hash">',
    { runScripts: 'outside-only', pretendToBeVisual: true },
  ).window;
  t.after(() => w.close());
  w.requestAnimationFrame = (fn) => {
    queueMicrotask(fn);
    return 1;
  };
  const state = {
    account: { id: 'a', organizationId: 'o', role: 'owner' },
    settingsBundleId: 'bundle',
    sessionReady: true,
  };
  w.eval(read('core/read-scheduler.js'));
  const actions = w.createReadScheduler(state);
  const blocked = deferred(),
    first = actions.scheduleRead(() => blocked.promise, { priority: 'background' });
  const imports = [],
    module = deferred();
  const queued = deferred();
  let installed = 0;
  w.eval(read('core/deferred-settings.js'));
  const api = w.createDeferredSettings(
    state,
    {
      ...actions,
      toast() {},
      scheduleRead(run, options) {
        const task = actions.scheduleRead(run, options);
        if (options.priority === 'background' && options.key?.includes('settings'))
          queued.resolve();
        return task;
      },
    },
    () => installed++,
    (url) => {
      imports.push(url);
      return module.promise;
    },
  );
  api.scheduleSettingsLoad();
  await queued.promise;
  assert.equal(imports.length, 0, 'passive preload waits for the sole background slot');
  const manual = api.ensureSettings();
  assert.equal(
    imports.length,
    1,
    'manual intent upgrades queued passive load into foreground capacity',
  );
  assert.equal(imports[0], '/app-settings.js?v=resource-hash&build=release-current');
  module.resolve({ bundleId: 'bundle' });
  await manual;
  assert.equal(installed, 1);
  blocked.resolve();
  await first;
});

test('settings import cannot install after an in-flight role mutation of the same account object', async (t) => {
  const w = new JSDOM('<meta name="cartoteca-build" content="release-current">', {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  const state = {
    account: { id: 'a', organizationId: 'o', role: 'owner' },
    settingsBundleId: 'bundle',
  };
  const module = deferred();
  let installed = 0;
  w.eval(read('core/deferred-settings.js'));
  const api = w.createDeferredSettings(
    state,
    { toast() {} },
    () => installed++,
    () => module.promise,
  );
  const loading = api.ensureSettings();
  state.account.role = 'cosmetologist';
  module.resolve({ bundleId: 'bundle' });
  await assert.rejects(loading, /Учётная запись изменилась/);
  assert.equal(installed, 0);
});

test('point appointment consumer abort reaches transport and the next point read remains usable', async (t) => {
  const f = startupFixture(t),
    late = deferred();
  f.state.account = f.account;
  const url =
    '/api/cabinet/patient?id=synthetic-patient&view=appointment&appointmentId=synthetic-point&details=1';
  f.handlers.set(url, () => late.promise);
  const controller = new f.w.AbortController();
  const cancelled = f.actions
    .readAppointmentEditor('synthetic-patient', 'synthetic-point', {
      details: true,
      signal: controller.signal,
    })
    .catch((error) => error);
  controller.abort();
  assert.equal((await cancelled).outcomeUnknown, false);
  f.handlers.set(url, () => ({
    patient: { id: 'synthetic-patient' },
    appointment: { id: 'synthetic-point' },
  }));
  const result = await f.actions.readAppointmentEditor('synthetic-patient', 'synthetic-point', {
    details: true,
  });
  assert.equal(result.appointment.id, 'synthetic-point');
  late.resolve({ patient: { id: 'stale' } });
  await flush();
  assert.deepEqual(f.state.data, []);
});

test('failed mandatory startup cancels sibling reads before a fresh retry', async (t) => {
  const f = startupFixture(t),
    stale = deferred();
  const bootstrap = '/api/cabinet/bootstrap?paged=1&limit=20';
  f.handlers.set(bootstrap, () => stale.promise);
  f.handlers.set('/api/workspace', () => Promise.reject(Error('offline required workspace')));
  await f.actions.initialize();
  f.handlers.delete(bootstrap);
  f.handlers.delete('/api/workspace');
  await f.actions.initialize();
  assert.equal(f.state.sessionReady, true);
  assert.equal(f.calls.filter((url) => url === bootstrap).length, 2);
  stale.resolve({ patients: [{ id: 'stale' }], services: [], initialized: true, revision: 0 });
  await flush();
  assert.deepEqual(f.state.data, []);
});

test('optional status defaults share the background budget while explicit user and busy completion reads keep foreground capacity', async (t) => {
  for (const route of [
    '/api/cabinet/time-zone',
    '/api/telegram/patient?patientId=synthetic',
    '/api/max/patient?patientId=synthetic',
  ]) {
    const f = startupFixture(t),
      blocked = deferred();
    f.state.account = f.account;
    const preload = f.actions.scheduleRead(() => blocked.promise, { priority: 'background' });
    const optional = f.actions.request(route);
    await flush();
    assert.equal(f.calls.includes(route), false, route + ' waits for background budget');
    await f.actions.request('/api/synthetic-visible-user');
    assert.equal(f.calls.includes('/api/synthetic-visible-user'), true);
    const explicit = f.actions.request(route, { priority: 'user' });
    assert.equal(
      f.calls.filter((url) => url === route).length,
      1,
      'explicit user intent promotes the queued status',
    );
    await Promise.all([optional, explicit]);
    f.state.busy = true;
    await f.actions.request(route);
    assert.equal(
      f.calls.filter((url) => url === route).length,
      2,
      'post-write busy completion bypasses background preload',
    );
    blocked.resolve();
    await preload;
  }
});
