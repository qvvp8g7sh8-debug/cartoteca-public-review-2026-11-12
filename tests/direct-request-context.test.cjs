const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = (name) =>
  fs.readFileSync(path.join(__dirname, '../src/client/modules', name + '.js'), 'utf8');
const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});
const changed = () =>
  json({ error: 'Synthetic account context changed', code: 'AUTH_CONTEXT_CHANGED' }, 428);
const next = () => new Promise(setImmediate);
async function until(check) {
  for (let turn = 0; turn < 100; turn++) {
    if (check()) return;
    await next();
  }
  assert.fail('Synthetic caller did not settle');
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function assertContext(options, accountId, organizationId = '') {
  assert.equal(options.headers['X-Cartoteca-Account-Id'], accountId);
  assert.equal(options.headers['X-Cartoteca-Organization-Id'], organizationId);
}
function adminFixture(t, { readSession, respond } = {}) {
  const w = new JSDOM(
    '<section id="admin-loading"></section><section id="admin-setup"></section>' +
      '<section id="admin-created"></section><section id="admin-dashboard"></section>' +
      '<section id="admin-denied"><p></p></section><div id="admin-identity"></div><button id="admin-logout"></button>',
  ).window;
  const calls = [],
    redirects = [],
    reloads = [],
    rendered = [];
  let request;
  const account = {
    id: 'synthetic-admin-a',
    organizationId: null,
    globalAdmin: true,
    displayName: 'Synthetic admin',
    email: 'admin@synthetic.test',
  };
  vm.runInNewContext(source('admin/dashboard'), {
    document: w.document,
    window: w,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    location: {
      hash: '',
      pathname: '/admin.html',
      replace: (target) => redirects.push(target),
      reload: () => reloads.push(true),
    },
    fetch: async (route, options) => {
      calls.push({ route, options });
      if (route === '/api/auth/session')
        return readSession ? readSession() : json({ user: account });
      return respond ? respond(route, options) : json({ synthetic: true });
    },
    createAdminRecords: () => ({}),
    createAdminDetails: () => ({}),
    createAdminOverview: () => ({ renderOverview: (value) => rendered.push(value) }),
    createAdminLists: (context) => {
      request = context.request;
      return { config: {} };
    },
    createAdminVoice: () => ({ bind() {} }),
    createAdminMfaSettings: () => ({ bind() {} }),
    createAdminBilling: () => ({ bind() {}, loadOverview: async () => {}, load: async () => {} }),
    createAdminNavigation: () => ({ bind() {} }),
    bindAdminEvents() {},
  });
  t.after(() => w.close());
  return { calls, redirects, reloads, rendered, request, w };
}

test('admin private calls pin the session actor and a blank organization, overriding caller-supplied identity', async (t) => {
  const f = adminFixture(t);
  await until(() => f.rendered.length === 1);
  assert.equal(f.calls[0].route, '/api/auth/session');
  assert.equal(f.calls[0].options.headers['X-Cartoteca-Account-Id'], undefined);
  assertContext(f.calls[1].options, 'synthetic-admin-a');
  await f.request('/api/admin/command', {
    method: 'POST',
    body: '{}',
    headers: {
      'X-Cartoteca-Account-Id': 'synthetic-admin-b',
      'X-Cartoteca-Organization-Id': 'foreign-org',
    },
  });
  assertContext(f.calls[2].options, 'synthetic-admin-a');
  assert.equal(f.calls.filter((call) => call.route === '/api/auth/session').length, 1);
});

test('admin cannot send a private request before its bootstrap actor is known', async (t) => {
  const pending = deferred();
  const f = adminFixture(t, { readSession: () => pending.promise });
  await assert.rejects(f.request('/api/admin/command', { method: 'POST' }), {
    status: 428,
    code: 'AUTH_CONTEXT_CHANGED',
    unknown: false,
    outcomeUnknown: false,
  });
  assert.equal(f.calls.length, 1);
  pending.resolve(json({ user: null }));
  await next();
});

test('admin context rejection stops pending reads and later commands without unknown-operation recovery', async (t) => {
  const pending = deferred();
  const f = adminFixture(t, {
    respond: (route) =>
      route === '/api/admin/slow'
        ? pending.promise
        : route === '/api/admin/command'
          ? changed()
          : json({}),
  });
  await until(() => f.rendered.length === 1);
  const slow = f.request('/api/admin/slow');
  const rejectedSlow = assert.rejects(slow, { code: 'AUTH_CONTEXT_CHANGED', unknown: false });
  await assert.rejects(f.request('/api/admin/command', { method: 'POST', body: '{}' }), {
    status: 428,
    code: 'AUTH_CONTEXT_CHANGED',
    unknown: false,
    outcomeUnknown: false,
  });
  pending.resolve(json({ privateOldResult: true }));
  await rejectedSlow;
  assert.equal(
    f.calls.find((call) => call.route === '/api/admin/slow').options.signal.aborted,
    true,
  );
  const count = f.calls.length;
  await assert.rejects(f.request('/api/admin/command', { method: 'POST' }), {
    code: 'AUTH_CONTEXT_CHANGED',
  });
  assert.equal(f.calls.length, count);
  assert.deepEqual(f.redirects, ['/']);
  assert.equal(f.w.document.querySelector('#admin-dashboard').hidden, true);
});

function supportFixture(t, respond) {
  const w = new JSDOM('<section id="support-settings"></section>', { pretendToBeVisual: true })
    .window;
  const state = {
    multiUser: true,
    account: { id: 'synthetic-a', organizationId: 'synthetic-org-a' },
  };
  const calls = [],
    redirects = [];
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    esc: (value) => String(value),
    settingsHelpHtml: () => '',
  };
  const api = vm.runInNewContext(source('support-requests') + '\ncreateSupportRequests', {
    window: w,
    document: w.document,
    FormData: w.FormData,
    AbortSignal: { timeout: () => new AbortController().signal },
    location: { replace: (target) => redirects.push(target) },
    fetch: async (route, options) => {
      const call = { route, options, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      return respond ? respond(call) : json({ receipt: receipt() });
    },
  })(state, actions);
  actions.$('#support-settings').innerHTML = api.supportRequestFormHtml('', true);
  api.resetSupportRequestScope('synthetic-a:synthetic-org-a');
  t.after(() => {
    api.clearSupportReceipt();
    w.close();
  });
  return { state, api, calls, redirects, actions, w };
}
const receipt = (changes = {}) => ({
  id: '10000000-0000-4000-8000-000000000001',
  replyEmail: 'recipient@synthetic.test',
  state: 'resolved',
  deliveries: { email: 'sent' },
  messages: [],
  ...changes,
});
const question = { description: 'Synthetic support question', diagnostics: {} };

test('support captures its rendered scope and blocks a changed local actor until a fresh scope is rendered', async (t) => {
  const f = supportFixture(t);
  f.state.account = { id: 'synthetic-b', organizationId: 'synthetic-org-b' };
  await assert.rejects(f.api.sendSupportRequest(question), {
    status: 428,
    code: 'AUTH_CONTEXT_CHANGED',
  });
  assert.equal(f.calls.length, 0);
  f.api.resetSupportRequestScope('synthetic-b:synthetic-org-b');
  await f.api.sendSupportRequest(question);
  assertContext(f.calls[0].options, 'synthetic-b', 'synthetic-org-b');
  assert.equal(
    f.calls.some((call) => call.route === '/api/auth/session'),
    false,
  );
});

test('support mutation rejection is terminal and does not poll or repeat under the changed cookie', async (t) => {
  const f = supportFixture(t, () => changed());
  await assert.rejects(f.api.sendSupportRequest(question), {
    status: 428,
    code: 'AUTH_CONTEXT_CHANGED',
    outcomeUnknown: false,
  });
  assertContext(f.calls[0].options, 'synthetic-a', 'synthetic-org-a');
  await f.api.refreshSupportReceipt();
  await assert.rejects(f.api.sendSupportRequest(question), { code: 'AUTH_CONTEXT_CHANGED' });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.redirects, ['/']);
});

test('support drops a delayed old receipt after a local scope switch', async (t) => {
  const pending = deferred();
  const f = supportFixture(t, (call) =>
    call.options.method === 'POST' ? json({ receipt: receipt() }) : pending.promise,
  );
  await f.api.sendSupportRequest(question);
  const read = f.api.refreshSupportReceipt();
  assertContext(f.calls[1].options, 'synthetic-a', 'synthetic-org-a');
  f.state.account = { id: 'synthetic-b', organizationId: 'synthetic-org-b' };
  f.api.resetSupportRequestScope('synthetic-b:synthetic-org-b');
  pending.resolve(json({ receipt: receipt({ replyEmail: 'old-private-receipt@synthetic.test' }) }));
  await read;
  assert.equal(f.actions.$('#support-message').textContent, '');
  assert.doesNotMatch(f.w.document.body.textContent, /old-private-receipt/);
  assert.deepEqual(f.redirects, []);
});

test('support replies carry the displayed actor and treat context rejection as a known refusal', async (t) => {
  const f = supportFixture(t, (call) =>
    call.route === '/api/support/reply'
      ? changed()
      : json({ receipt: receipt({ state: 'waiting' }) }),
  );
  await f.api.sendSupportRequest(question);
  const form = f.actions.$('#support-reply-form');
  form.querySelector('textarea').value = 'Synthetic clarification';
  form.dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => f.redirects.length === 1 && !form.querySelector('button').disabled);
  const call = f.calls.find((value) => value.route === '/api/support/reply');
  assertContext(call.options, 'synthetic-a', 'synthetic-org-a');
  assert.match(f.actions.$('#support-reply-status').textContent, /Учётная запись изменилась/);
  assert.doesNotMatch(f.actions.$('#support-reply-status').textContent, /Повторите отправку/);
  assert.equal(f.calls.length, 2);
});

test('a restored administrator document hides old data and reloads without private probes', async (t) => {
  const f = adminFixture(t);
  await until(() => f.rendered.length === 1);
  f.w.document.body.classList.add('admin-page');
  const style = f.w.document.createElement('style');
  style.textContent = fs.readFileSync(assetPath('admin.css'), 'utf8');
  f.w.document.head.append(style);
  const dashboard = f.w.document.querySelector('#admin-dashboard'),
    loading = f.w.document.querySelector('#admin-loading');
  dashboard.textContent = 'Synthetic old A administrative content';
  loading.textContent = 'Synthetic loading';
  assert.notEqual(f.w.getComputedStyle(dashboard).display, 'none');
  const requests = f.calls.length;
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pageshow', { persisted: false }));
  assert.deepEqual(f.reloads, []);
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pageshow', { persisted: true }));
  assert.deepEqual(f.reloads, [true]);
  assert.equal(dashboard.hidden, true);
  assert.equal(f.w.getComputedStyle(dashboard).display, 'none');
  assert.equal(loading.hidden, false);
  assert.notEqual(f.w.getComputedStyle(loading).display, 'none');
  assert.equal(
    f.calls.length,
    requests,
    'Restore schedules a fresh document rather than issuing stale private reads',
  );
});
