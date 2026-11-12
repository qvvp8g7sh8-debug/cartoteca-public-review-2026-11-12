const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/client/core/events.js'), 'utf8');
const turn = () => new Promise(setImmediate);
async function until(check) {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await turn();
  }
  assert.fail('Synthetic logout did not settle');
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t, { confirm, disconnect, logout, storageWrite } = {}) {
  const w = new JSDOM(
    '<button id="logout-account">Logout</button><input id="search"><form id="editor-form"></form><div id="form-content"></div><div id="client-filters"></div><div class="name-sort"></div>',
    { url: 'https://synthetic.test/' },
  ).window;
  t.after(() => w.close());
  const state = { account: { id: 'A', organizationId: 'org-A' }, multiUser: true, busy: false };
  const calls = [],
    writes = [],
    redirects = [],
    resets = [],
    errors = [];
  let confirms = 0,
    disconnects = 0,
    rollbacks = 0;
  const actions = new Proxy(
    {
      $: (selector) => w.document.querySelector(selector),
      handleCalendarLoadNavigation: () => false,
      confirmSettingsLeave: () => {
        confirms++;
        return confirm ? confirm() : Promise.resolve(true);
      },
      resetAssistant: () => resets.push(state.account.id),
      disconnectPushOnLogout: () => {
        disconnects++;
        return disconnect ? disconnect() : Promise.resolve();
      },
      request: (route, options) => {
        calls.push({ route, options });
        return logout ? logout() : Promise.resolve({ ok: true });
      },
      rollback: () => {
        rollbacks++;
      },
      toast: (text) => errors.push(text),
      renderList() {},
      submit() {},
    },
    {
      get: (target, key) =>
        typeof key === 'string' && key.startsWith('bind') ? () => {} : target[key],
    },
  );
  const context = {
    window: w,
    document: w.document,
    Date,
    location: { replace: (url) => redirects.push(url), reload() {} },
    localStorage: {
      setItem: (key, value) => {
        writes.push({ key, value });
        storageWrite?.(key, value);
      },
    },
  };
  vm.runInNewContext(source, context);
  context.bindEvents(state, actions);
  return {
    w,
    state,
    calls,
    writes,
    redirects,
    resets,
    errors,
    actions,
    click: () => w.document.querySelector('#logout-account').click(),
    confirms: () => confirms,
    disconnects: () => disconnects,
    rollbacks: () => rollbacks,
    storage: (key, newValue) => w.dispatchEvent(new w.StorageEvent('storage', { key, newValue })),
  };
}

test('same actor logout writes only a scoped v2 marker and finishes normally', async (t) => {
  const f = fixture(t);
  f.click();
  await until(() => f.redirects.length === 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].route, '/api/auth/logout');
  assert.deepEqual(f.resets, ['A']);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].key, 'cartoteca-logout-v2');
  const marker = JSON.parse(f.writes[0].value);
  assert.equal(marker.accountId, 'A');
  assert.equal(marker.organizationId, 'org-A');
  assert.ok(Number.isFinite(marker.at) && marker.at > 0);
});

for (const change of ['account', 'organization']) {
  test(
    'logout intent is captured before a pending confirmation and stops after a local ' +
      change +
      ' switch',
    async (t) => {
      const pending = deferred(),
        f = fixture(t, { confirm: () => pending.promise });
      f.click();
      assert.equal(f.confirms(), 1);
      f.state.account = {
        id: change === 'account' ? 'B' : 'A',
        organizationId: change === 'account' ? 'org-A' : 'org-B',
      };
      f.state.busy = true;
      pending.resolve(true);
      await flush();
      assert.deepEqual(f.resets, []);
      assert.equal(f.disconnects(), 0);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.redirects, []);
      assert.equal(f.state.busy, true, 'An old handler must not release B ongoing work');
    },
  );
}

test('a local account switch during push disconnect prevents a later logout from targeting B', async (t) => {
  const pending = deferred(),
    f = fixture(t, { disconnect: () => pending.promise });
  f.click();
  await until(() => f.disconnects() === 1);
  f.state.account = { id: 'B', organizationId: 'org-B' };
  f.state.busy = true;
  pending.resolve();
  await flush();
  assert.deepEqual(f.resets, ['A']);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.redirects, []);
  assert.equal(f.state.busy, true);
});

for (const result of ['success', 'error']) {
  test(
    'a late logout A ' + result + ' has no browser or UI effects after a local B switch',
    async (t) => {
      const pending = deferred(),
        f = fixture(t, { logout: () => pending.promise });
      f.click();
      await until(() => f.calls.length === 1);
      f.state.account = { id: 'B', organizationId: 'org-B' };
      f.state.busy = true;
      if (result === 'success') pending.resolve({ ok: true });
      else pending.reject(Error('Synthetic old A offline'));
      await flush();
      assert.deepEqual(f.resets, ['A']);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.redirects, []);
      assert.deepEqual(f.errors, []);
      assert.equal(f.rollbacks(), 0);
      assert.equal(f.state.busy, true);
    },
  );
}

for (const reason of ['context428', 'network']) {
  test(
    'a refused current actor logout creates no shared marker or automatic retry: ' + reason,
    async (t) => {
      const error =
        reason === 'context428'
          ? Object.assign(Error('Synthetic context changed'), {
              status: 428,
              code: 'AUTH_CONTEXT_CHANGED',
              outcomeUnknown: false,
            })
          : TypeError('Synthetic offline');
      const f = fixture(t, { logout: () => Promise.reject(error) });
      f.click();
      await until(() => f.errors.length === 1);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.redirects, []);
    },
  );
}

test('only a same actor scoped v2 storage marker synchronizes logout', (t) => {
  const f = fixture(t);
  f.storage(
    'cartoteca-logout-v2',
    JSON.stringify({ accountId: 'A', organizationId: 'org-A', at: Date.now() }),
  );
  assert.deepEqual(f.resets, ['A']);
  assert.deepEqual(f.redirects, ['/']);
});

for (const [name, key, value] of [
  ['foreign account', 'cartoteca-logout-v2', { accountId: 'B', organizationId: 'org-A', at: 1 }],
  [
    'foreign organization',
    'cartoteca-logout-v2',
    { accountId: 'A', organizationId: 'org-B', at: 1 },
  ],
  ['legacy key', 'cartoteca-logout', 12345],
  ['unscoped timestamp', 'cartoteca-logout-v2', 12345],
  ['null', 'cartoteca-logout-v2', null],
  ['missing organization', 'cartoteca-logout-v2', { accountId: 'A', at: 1 }],
  [
    'invalid timestamp',
    'cartoteca-logout-v2',
    { accountId: 'A', organizationId: 'org-A', at: '1' },
  ],
]) {
  test('logout storage ignores ' + name, (t) => {
    const f = fixture(t);
    f.storage(key, JSON.stringify(value));
    assert.deepEqual(f.resets, []);
    assert.deepEqual(f.redirects, []);
  });
}
test('logout storage ignores malformed JSON and removed markers', (t) => {
  const f = fixture(t);
  f.storage('cartoteca-logout-v2', '{broken');
  f.storage('cartoteca-logout-v2', null);
  assert.deepEqual(f.resets, []);
  assert.deepEqual(f.redirects, []);
});

test('a successful server logout still navigates when the scoped browser marker cannot be stored', async (t) => {
  for (const name of ['SecurityError', 'QuotaExceededError']) {
    const f = fixture(t, {
      storageWrite: () => {
        throw Object.assign(Error('Synthetic storage unavailable'), { name });
      },
    });
    f.click();
    await until(() => f.redirects.length || f.errors.length);
    assert.equal(f.calls.length, 1, 'The server logout is never repeated after a storage failure');
    assert.equal(f.calls[0].route, '/api/auth/logout');
    assert.deepEqual(f.redirects, ['/']);
    assert.deepEqual(f.errors, []);
    assert.equal(f.rollbacks(), 0);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].key, 'cartoteca-logout-v2');
    assert.equal(JSON.parse(f.writes[0].value).accountId, 'A');
    assert.deepEqual(f.resets, ['A']);
    assert.equal(f.state.account.id, 'A');
  }
});
