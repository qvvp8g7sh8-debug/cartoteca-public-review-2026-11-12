const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/core/session-startup.js'),
  'utf8',
);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const session = deferred(),
    cabinet = deferred(),
    workspace = deferred(),
    access = deferred();
  const calendar = deferred(),
    push = deferred();
  const calls = [],
    state = {},
    status = { hidden: false };
  let visible = false;
  const actions = new Proxy(
    {
      request(url) {
        calls.push(url);
        return url === '/api/auth/session'
          ? session.promise
          : url.startsWith('/api/cabinet')
            ? cabinet.promise
            : access.promise;
      },
      loadWorkspace() {
        calls.push('workspace');
        return workspace.promise;
      },
      canManageTeam: () => true,
      loadCalendarRecords() {
        calls.push('calendar');
        assert.equal(state.workspaceReady, true);
        assert.equal(state.teamAccess, undefined);
        assert.deepEqual(state.data, []);
        return calendar.promise;
      },
      setView() {
        calls.push('render');
      },
      openStaffPushTarget() {
        assert.equal(visible, true);
        return push.promise;
      },
      $: () => status,
    },
    { get: (object, key) => object[key] || (() => {}) },
  );
  const redirects = [];
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: {
      body: {
        classList: {
          remove() {
            visible = true;
          },
        },
      },
    },
    location: {
      hash: '',
      replace(value) {
        redirects.push(value);
      },
    },
    URLSearchParams,
  });
  vm.runInContext(source, context);
  return {
    session,
    cabinet,
    workspace,
    access,
    calendar,
    push,
    calls,
    state,
    status,
    redirects,
    visible: () => visible,
    api: context.createSessionStartup(state, actions),
  };
}
test('startup waits for server session before starting protected reads', async () => {
  const f = fixture(),
    pending = f.api.initialize();
  assert.deepEqual(f.calls, ['/api/auth/session']);
  f.session.resolve({ user: null });
  await pending;
  assert.deepEqual(f.calls, ['/api/auth/session']);
  assert.deepEqual(f.redirects, ['/']);
  assert.equal(f.visible(), false);
});
test('mandatory startup reads overlap and optional team access does not block calendar', async () => {
  const f = fixture(),
    pending = f.api.initialize();
  f.session.resolve({
    user: { id: 'synthetic', organizationId: 'synthetic-organization' },
    multiUser: true,
    lazyReads: true,
  });
  await flush();
  assert.deepEqual(f.calls, [
    '/api/auth/session',
    '/api/cabinet/bootstrap?paged=1&limit=20',
    'workspace',
  ]);
  f.cabinet.resolve({ patients: [], services: [], initialized: true, revision: 0 });
  await flush();
  assert.equal(f.calls.includes('calendar'), false);
  f.state.workspaceReady = true;
  f.workspace.resolve();
  await flush();
  assert.equal(f.calls.includes('calendar'), true);
  assert.equal(f.visible(), false);
  assert.equal(f.state.sessionReady, false);
  f.calendar.resolve();
  await flush();
  assert.equal(f.visible(), true);
  assert.equal(f.state.sessionReady, true);
  assert.equal(f.status.hidden, true);
  assert.equal(f.calls.filter((call) => call === 'render').length, 1);
  // A slow Push target cannot hold the already loaded calendar behind the loader.
  f.push.resolve();
  f.access.resolve({ members: [] });
  await pending;
});

test('initial calendar query applies records without causing an extra startup render', async () => {
  const calendarSource = fs.readFileSync(
    path.join(__dirname, '../src/client/core/cabinet-queries.js'),
    'utf8',
  );
  const state = {
    account: { id: 'synthetic' },
    lazyReads: true,
    currentView: 'calendar',
    calendarMode: 'week',
    calendarAnchorDate: new Date(2026, 9, 15),
    sessionReady: false,
  };
  let renders = 0,
    revision = 0;
  const actions = {
    isoDate: (date) => date.toISOString().slice(0, 10),
    weekStart: (date) => date,
    readBackground: async () => ({ appointments: [{ id: String(++revision) }] }),
    $: () => null,
    setView: () => renders++,
    updateCurrentTime() {},
    toast(message) {
      throw Error(message);
    },
  };
  const factory = vm.runInNewContext(calendarSource + '\ncreateCabinetQueries', { document: {} });
  const api = factory(state, actions);
  await api.loadCalendarRecords();
  assert.equal(state.calendarRecords[0].id, '1');
  assert.equal(api.calendarRecordsReady(), true);
  assert.equal(renders, 0);
  state.sessionReady = true;
  await api.loadCalendarRecords({ force: true });
  assert.equal(state.calendarRecords[0].id, '2');
  assert.equal(renders, 1);
});
