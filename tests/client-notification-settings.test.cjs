const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/client-notification-settings.js'),
  'utf8',
);
const settle = () => new Promise((resolve) => setImmediate(resolve));

for (const width of [390, 1440])
  test(
    'common visibility confirms checkbox changes, rolls back cancel/failure and has no save button at ' +
      width,
    async (t) => {
      const w = new JSDOM('<section id="client-notification-settings"></section>', {
        runScripts: 'outside-only',
      }).window;
      t.after(() => w.close());
      Object.defineProperty(w, 'innerWidth', { value: width });
      w.eval(source);
      const state = { account: { id: 'owner', organizationId: 'org' }, busy: false };
      const posts = [];
      let decision = false,
        failure = false,
        saved = true,
        marks = 0;
      const actions = {
        $: (selector) => w.document.querySelector(selector),
        settingsHelpHtml: () => '<button type="button" aria-label="Пояснение">?</button>',
        confirmAction: async () => decision,
        markSettingsSaved: () => marks++,
        request: async (url, options) => {
          assert.equal(url, '/api/notifications/service-visibility');
          if (options) {
            const body = JSON.parse(options.body);
            posts.push(body);
            if (failure) throw Object.assign(Error('Состояние изменилось'), { status: 409 });
            assert.equal(body.expectedShowServices, saved);
            saved = body.showServices;
          }
          return { showServices: saved };
        },
      };
      const ui = w.createClientNotificationSettings(state, actions);
      ui.bindClientNotificationSettingsEvents();
      await ui.mountClientNotificationSettings();
      const form = actions.$('form'),
        field = form.elements.showServices;
      actions.$('#client-services-label').click();
      assert.equal(field.checked, true);
      assert.equal(actions.$('#client-services-label').closest('label'), null);
      assert.equal(form.querySelector('[type="submit"]'), null);
      field.click();
      await settle();
      assert.equal(posts.length, 0);
      assert.equal(field.checked, true);
      decision = true;
      field.click();
      await settle();
      assert.deepEqual(posts[0], { showServices: false, expectedShowServices: true });
      assert.equal(marks, 1);
      assert.match(form.textContent, /сохранена/);
      assert.equal(field.disabled, false);
      failure = true;
      field.click();
      await settle();
      assert.equal(form.dataset.showServices, 'false');
      assert.equal(field.checked, false);
      assert.match(form.textContent, /Состояние изменилось/);
      assert.equal(marks, 1);
      assert.equal(state.busy, false);
    },
  );

test('late visibility read and pending confirmation cannot cross account or detached form', async (t) => {
  const w = new JSDOM('<section id="client-notification-settings"></section>', {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  w.eval(source);
  const state = { account: { id: 'a', organizationId: 'o' }, busy: false };
  let answer,
    accept,
    posts = 0;
  const actions = {
    $: (selector) => w.document.querySelector(selector),
    settingsHelpHtml: () => '',
    markSettingsSaved() {},
    request: (url, options) =>
      options
        ? (posts++, Promise.resolve({ showServices: false }))
        : new Promise((resolve) => (answer = resolve)),
    confirmAction: () => new Promise((resolve) => (accept = resolve)),
  };
  const ui = w.createClientNotificationSettings(state, actions);
  const loading = ui.mountClientNotificationSettings();
  state.account.organizationId = 'other';
  answer({ showServices: true });
  await loading;
  assert.equal(actions.$('form'), null);
  const next = ui.mountClientNotificationSettings();
  answer({ showServices: true });
  await next;
  ui.bindClientNotificationSettingsEvents();
  const form = actions.$('form');
  form.elements.showServices.checked = false;
  form.elements.showServices.dispatchEvent(new w.Event('change', { bubbles: true }));
  form.remove();
  accept(true);
  await settle();
  assert.equal(posts, 0);
});
test('unknown checkbox delivery locks changes until an explicit state reload', async (t) => {
  const w = new JSDOM('<section id="client-notification-settings"></section>', {
    runScripts: 'outside-only',
  }).window;
  t.after(() => w.close());
  w.eval(source);
  let saved = true,
    posts = 0,
    confirmations = 0;
  const state = { account: { id: 'synthetic', organizationId: 'synthetic' }, busy: false };
  const actions = {
    $: (s) => w.document.querySelector(s),
    settingsHelpHtml: () => '',
    markSettingsSaved() {},
    confirmAction: async () => {
      confirmations++;
      return true;
    },
    request: async (url, options) => {
      if (options) {
        posts++;
        saved = false;
        throw Object.assign(Error('Synthetic timeout'), { outcomeUnknown: true });
      }
      return { showServices: saved };
    },
  };
  const ui = w.createClientNotificationSettings(state, actions);
  ui.bindClientNotificationSettingsEvents();
  await ui.mountClientNotificationSettings();
  const field = actions.$('[name=showServices]');
  field.click();
  await settle();
  assert.equal(posts, 1);
  assert.equal(field.disabled, true);
  assert.equal(state.busy, false);
  field.click();
  await settle();
  assert.equal(confirmations, 1);
  actions.$('[data-notification-retry]').click();
  await settle();
  assert.equal(actions.$('[name=showServices]').checked, false);
  assert.equal(actions.$('[name=showServices]').disabled, false);
});

test('visibility HTTP enforces manager roles, CSRF, organization scope, strict values and stale writes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-common-visibility-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const password = 'Synthetic-visibility-password-2026';
  const owner = await platform.registerOwner({
    email: 'owner@example.test',
    password,
    displayName: 'Owner',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  const other = await platform.registerOwner({
    email: 'other@example.test',
    password,
    displayName: 'Other',
    organizationName: 'Other',
  });
  platform.verifyEmail(other.verificationToken);
  for (const role of ['salon_admin', 'cosmetologist']) {
    const invitation = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    await platform.acceptInvitation({
      token: invitation.token,
      email: role + '@example.test',
      password,
      displayName: role,
    });
  }
  await platform.bootstrapGlobalAdmin({
    email: 'global@example.test',
    password,
    displayName: 'Global',
  });
  const server = createMultiServer({
    dataDir: dir,
    telegramBot: null,
    telegramAutostart: false,
    sendMail: null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    platform.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' };
  const cookies = {},
    contexts = {};
  for (const name of ['owner', 'other', 'salon_admin', 'cosmetologist', 'global']) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: name + '@example.test', password }),
    });
    assert.equal(response.status, 200);
    cookies[name] = response.headers.get('set-cookie').split(';')[0];
    contexts[name] = authContextHeaders(await response.json());
  }
  const route = '/api/notifications/service-visibility';
  const request = (name, body, overrides = {}) =>
    fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, Cookie: cookies[name] || '', ...contexts[name], ...overrides },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await request('anonymous')).status, 401);
  for (const name of ['cosmetologist', 'global']) {
    assert.equal((await request(name)).status, 403);
    assert.equal(
      (await request(name, { showServices: false, expectedShowServices: true })).status,
      403,
    );
  }
  const prior = platform.telegram.settings(owner.organizationId);
  const stale = { showServices: false, expectedShowServices: true };
  assert.equal((await request('owner', stale, { 'X-Cartoteca-Request': '' })).status, 403);
  for (const body of [
    { ...stale, timeZone: 'Europe/Samara' },
    { showServices: 'false', expectedShowServices: true },
    { showServices: false },
  ])
    assert.equal((await request('owner', body)).status, 400);
  assert.equal((await request('salon_admin', stale)).status, 200);
  assert.deepEqual(platform.telegram.settings(owner.organizationId), {
    ...prior,
    showServices: false,
  });
  assert.equal((await request('owner', stale)).status, 409);
  assert.equal((await (await request('other')).json()).showServices, true);
  assert.deepEqual(await (await request('owner')).json(), { showServices: false });
});
