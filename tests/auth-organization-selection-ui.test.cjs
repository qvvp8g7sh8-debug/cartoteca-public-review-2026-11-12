const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const root = path.resolve(__dirname, '..');
const loginHtml = fs.readFileSync(path.join(root, 'src/client/modules/auth/login.html'), 'utf8');
const loginSource = fs.readFileSync(path.join(root, 'src/client/modules/auth/login.js'), 'utf8');
const sessionSource = fs.readFileSync(
  path.join(root, 'src/client/core/session-startup.js'),
  'utf8',
);
const user = { id: 'synthetic-member', organizationId: null, globalAdmin: false };
const anonymous = { multiUser: true, configured: true, user: null };
const noAccess = { ...anonymous, user, organizationAccess: 'none' };
const conflict = { ...anonymous, user, organizationAccess: 'conflict' };
const selected = { ...anonymous, user: { ...user, organizationId: 'synthetic-organization' } };
const publicAccount = { id: user.id, globalAdmin: false };
const password = 'Synthetic-account-access-password';
const invitationToken = 'synthetic-invitation-refresh-token';
const invitation = {
  email: 'recipient@organization.test',
  displayName: '',
  existingAccount: false,
  passwordSetupRequired: true,
  organizationName: 'Synthetic invitation organization',
  roleName: 'Администратор',
};
const nextTurn = () => new Promise(setImmediate);
async function until(condition, message) {
  for (let turn = 0; turn < 100; turn++) {
    if (condition()) return;
    await nextTurn();
  }
  assert.fail(message);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function json(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function fixture(
  t,
  {
    session = anonymous,
    login = { user: publicAccount, organizationId: selected.user.organizationId },
    loginStatus = 200,
    logout,
    readSession,
    readInvitation,
    accept,
    captureNavigation = false,
    url = 'https://organization.test/login.html',
  } = {},
) {
  const errors = [],
    calls = [],
    written = [],
    redirects = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const w = new JSDOM(loginHtml, {
    url,
    runScripts: 'outside-only',
    virtualConsole,
    pretendToBeVisual: true,
  }).window;
  let liveSession = session;
  const $ = (selector) => w.document.querySelector(selector);
  w.document.open = () => {};
  w.document.write = (html) => written.push(html);
  w.document.close = () => {};
  w.fetch = async (route, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, method, body, headers: options.headers || {} });
    if (route === '/api/auth/session') return json(readSession ? readSession() : liveSession);
    if (route === '/api/auth/invitations/info')
      return json(readInvitation ? readInvitation() : invitation);
    if (route === '/api/auth/invitations/accept')
      return accept ? accept(body) : json({ organizationId: selected.user.organizationId });
    if (route === '/api/auth/login') {
      if (loginStatus < 400)
        liveSession = {
          ...anonymous,
          user: {
            ...login.user,
            organizationId: login.organizationId ?? login.user?.organizationId,
          },
        };
      return json(login, loginStatus);
    }
    if (route === '/api/auth/logout') {
      const result = logout ? await logout(options) : json({ ok: true });
      if (result.ok) liveSession = anonymous;
      return result;
    }
    if (/^\/(index|admin)\.html\?signed-in=/.test(route)) {
      const title = route.startsWith('/admin') ? 'Управление · Картотека' : 'Картотека · кабинет';
      return {
        ok: true,
        text: async () => '<!doctype html><title>' + title + '</title><main>Opened</main>',
      };
    }
    throw Error('Unexpected synthetic request: ' + route);
  };
  t.after(() => {
    w.close();
    assert.deepEqual(errors, []);
  });
  if (captureNavigation) {
    w.syntheticAuthLocation = {
      get hash() {
        return w.location.hash;
      },
      get search() {
        return w.location.search;
      },
      get pathname() {
        return w.location.pathname;
      },
      replace: (value) => redirects.push(value),
      reload: () => redirects.push('reload'),
    };
    w.eval('{ const location = window.syntheticAuthLocation;\n' + loginSource + '\n}');
    delete w.syntheticAuthLocation;
  } else w.eval(loginSource);
  return {
    w,
    $,
    calls,
    written,
    redirects,
    submitLogin() {
      $('#auth-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    },
    posts(route) {
      return calls.filter((call) => call.method === 'POST' && call.route === route);
    },
    shells() {
      return calls.filter((call) => /^\/(index|admin)\.html\?signed-in=/.test(call.route));
    },
  };
}
async function readyProblem(h) {
  await until(
    () => !h.$('#account-access-problem').hidden,
    'Authenticated user without organization access must see a recoverable problem',
  );
}
async function submitCredentials(h) {
  await until(() => !h.$('#auth-form').hidden, 'Login form did not open');
  h.$('#auth-email').value = 'member@organization.test';
  h.$('#auth-password').value = password;
  h.submitLogin();
}
function assertNoOrganizationPicker(h) {
  assert.equal(h.$('#organization-form'), null);
  assert.equal(h.$('#organization-choice'), null);
  assert.equal(h.$('#account-access-problem').querySelector('select'), null);
  assert.equal(h.posts('/api/auth/select-organization').length, 0);
}

async function readyInvitation(h) {
  await until(
    () => h.$('#auth-submit').textContent === 'Принять приглашение',
    'Invitation acceptance form did not open',
  );
}
function submitInvitation(h) {
  h.$('#auth-name').value = 'Synthetic invitation recipient';
  h.$('#auth-password').value = password;
  h.$('#auth-repeat').value = password;
  h.$('#auth-privacy-consent').checked = true;
  h.submitLogin();
}

test('an unaccepted invitation survives a page reload without opening owner registration', async (t) => {
  const first = fixture(t, {
    url: 'https://organization.test/login.html#invite=' + invitationToken,
  });
  await readyInvitation(first);
  assert.equal(first.w.location.hash, '#invite=' + invitationToken);
  const reloaded = fixture(t, { url: first.w.location.href });
  await readyInvitation(reloaded);
  for (const h of [first, reloaded]) {
    assert.equal(h.w.location.hash, '#invite=' + invitationToken);
    assert.equal(h.$('#auth-switch').hidden, true);
    assert.equal(h.$('#auth-email').value, invitation.email);
    assert.equal(h.$('#auth-repeat-field').hidden, false);
    assert.equal(h.posts('/api/auth/invitations/info').length, 1);
    assert.equal(h.posts('/api/auth/invitations/info')[0].body.token, invitationToken);
    assert.equal(h.posts('/api/auth/register').length, 0);
    assert.equal(h.posts('/api/auth/invitations/accept').length, 0);
    assert.equal(h.shells().length, 0);
  }
});

test('a failed invitation acceptance keeps the URL context and the entered first-password fields', async (t) => {
  const h = fixture(t, {
    url: 'https://organization.test/login.html#invite=' + invitationToken,
    accept: () => json({ error: 'Синтетический отказ принятия.' }, 400),
  });
  await readyInvitation(h);
  submitInvitation(h);
  await until(
    () => h.$('#auth-error').textContent === 'Синтетический отказ принятия.',
    'Acceptance failure was hidden',
  );
  assert.equal(h.w.location.hash, '#invite=' + invitationToken);
  assert.equal(h.$('#auth-submit').textContent, 'Принять приглашение');
  assert.equal(h.$('#auth-name').value, 'Synthetic invitation recipient');
  assert.equal(h.$('#auth-password').value, password);
  assert.equal(h.$('#auth-repeat').value, password);
  assert.equal(h.posts('/api/auth/register').length, 0);
  const reloaded = fixture(t, { url: h.w.location.href });
  await readyInvitation(reloaded);
  assert.equal(reloaded.$('#auth-email').value, invitation.email);
  assert.equal(reloaded.posts('/api/auth/register').length, 0);
});

test('successful invitation acceptance clears the fragment before the ordinary login step', async (t) => {
  const h = fixture(t, { url: 'https://organization.test/login.html#invite=' + invitationToken });
  await readyInvitation(h);
  submitInvitation(h);
  await until(
    () => h.$('#extra-message').textContent.includes('Приглашение принято'),
    'Invitation was not accepted',
  );
  assert.equal(h.w.location.hash, '');
  assert.equal(h.$('#auth-submit').textContent, 'Войти');
  assert.equal(h.$('#auth-repeat-field').hidden, true);
  assert.equal(h.$('#auth-password').value, '');
  assert.equal(h.$('#auth-repeat').value, '');
  assert.equal(h.posts('/api/auth/invitations/accept').length, 1);
  assert.equal(h.posts('/api/auth/invitations/accept')[0].body.passwordConfirmation, password);
  assert.equal(h.posts('/api/auth/register').length, 0);
  assert.equal(h.shells().length, 0);
});

for (const existingAccount of [false, true])
  test(
    (existingAccount ? 'unfinished' : 'new') +
      ' invitation setup starts with a fresh identity despite old and current-owner names',
    async (t) => {
      const ownerName = 'Synthetic current owner';
      const h = fixture(t, {
        url: 'https://organization.test/login.html#invite=' + invitationToken,
        session: {
          ...selected,
          user: { ...selected.user, email: 'owner@organization.test', displayName: ownerName },
        },
        readInvitation: () => ({
          ...invitation,
          existingAccount,
          displayName: 'Synthetic stale recipient name',
        }),
      });
      h.$('#auth-name').value = ownerName;
      h.$('#auth-password').value = 'Synthetic-current-owner-password';
      h.$('#auth-repeat').value = 'Synthetic-current-owner-password';
      h.$('#auth-privacy-consent').checked = true;
      await readyInvitation(h);
      assert.equal(h.$('#auth-name').value, '');
      assert.equal(h.$('#auth-name').required, true);
      assert.equal(h.$('#auth-name').autocomplete, 'off');
      assert.equal(h.$('#auth-name').closest('label').hidden, false);
      assert.equal(h.$('#auth-password').value, '');
      assert.equal(h.$('#auth-repeat').value, '');
      assert.equal(h.$('#auth-privacy-consent').checked, false);
      assert.match(h.$('#extra-message').textContent, /owner@organization\.test/);
      assert.doesNotMatch(
        h.$('#auth-form').textContent,
        /Synthetic current owner|Synthetic stale recipient name/,
      );
      assert.equal(h.posts('/api/auth/invitations/accept').length, 0);
      assert.equal(h.posts('/api/auth/register').length, 0);
    },
  );

test('setup submits only the explicitly entered recipient name and the invitation email', async (t) => {
  const h = fixture(t, {
    url: 'https://organization.test/login.html#invite=' + invitationToken,
    readInvitation: () => ({ ...invitation, displayName: 'Synthetic obsolete name' }),
  });
  await readyInvitation(h);
  h.$('#auth-name').value = '  Synthetic chosen recipient  ';
  h.$('#auth-email').value = 'owner@organization.test';
  h.$('#auth-password').value = password;
  h.$('#auth-repeat').value = password;
  h.$('#auth-privacy-consent').checked = true;
  h.submitLogin();
  await until(
    () => h.$('#extra-message').textContent.includes('Приглашение принято'),
    'Explicit recipient identity was not accepted',
  );
  const body = h.posts('/api/auth/invitations/accept')[0].body;
  assert.equal(body.email, invitation.email);
  assert.equal(body.displayName, 'Synthetic chosen recipient');
  assert.equal(body.passwordConfirmation, password);
  assert.equal(body.password, password);
  assert.equal(h.$('#auth-email').value, invitation.email);
  assert.equal(h.$('#auth-name').value, '');
  assert.equal(h.posts('/api/auth/register').length, 0);
});

test('an established recipient keeps identity fields hidden and omits setup fields from acceptance', async (t) => {
  const h = fixture(t, {
    url: 'https://organization.test/login.html#invite=' + invitationToken,
    readInvitation: () => ({
      ...invitation,
      existingAccount: true,
      passwordSetupRequired: false,
      displayName: 'Synthetic established recipient',
    }),
  });
  await readyInvitation(h);
  assert.equal(h.$('#auth-name').value, '');
  assert.equal(h.$('#auth-name').required, false);
  assert.equal(h.$('#auth-name').closest('label').hidden, true);
  assert.equal(h.$('#auth-repeat-field').hidden, true);
  h.$('#auth-name').value = 'Synthetic unrelated autofill';
  h.$('#auth-email').value = 'owner@organization.test';
  h.$('#auth-password').value = password;
  h.$('#auth-repeat').value = 'Synthetic unrelated repeat';
  h.submitLogin();
  await until(
    () => h.$('#extra-message').textContent.includes('Приглашение принято'),
    'Established recipient could not accept without setup',
  );
  const body = h.posts('/api/auth/invitations/accept')[0].body;
  assert.equal(body.email, invitation.email);
  assert.equal(body.password, password);
  assert.equal(Object.hasOwn(body, 'displayName'), false);
  assert.equal(Object.hasOwn(body, 'passwordConfirmation'), false);
});

test('a programmatic setup submit cannot accept an invitation with a blank trimmed name', async (t) => {
  const h = fixture(t, { url: 'https://organization.test/login.html#invite=' + invitationToken });
  await readyInvitation(h);
  h.$('#auth-name').value = '  \t  ';
  h.$('#auth-password').value = password;
  h.$('#auth-repeat').value = password;
  h.$('#auth-privacy-consent').checked = true;
  h.submitLogin();
  assert.match(h.$('#auth-error').textContent, /Укажите своё имя/);
  assert.equal(h.posts('/api/auth/invitations/accept').length, 0);
  assert.equal(h.$('#auth-submit').disabled, false);
  assert.equal(h.$('#auth-password').value, password);
  assert.equal(h.w.document.activeElement, h.$('#auth-name'));
});

test('retrying the same invitation preserves an explicit draft through an info failure', async (t) => {
  let reads = 0;
  const h = fixture(t, {
    url: 'https://organization.test/login.html#invite=' + invitationToken,
    readInvitation: () => {
      if (++reads === 2) throw Error('Синтетическая ошибка проверки приглашения.');
      return {
        ...invitation,
        existingAccount: true,
        displayName: 'Synthetic stale draft replacement',
      };
    },
  });
  await readyInvitation(h);
  h.$('#auth-name').value = 'Synthetic explicit draft';
  h.$('#auth-password').value = password;
  h.$('#auth-repeat').value = password;
  h.$('#auth-privacy-consent').checked = true;
  h.$('#auth-retry').click();
  await until(() => !h.$('#auth-retry').hidden, 'Failed invitation info did not permit retry');
  assert.match(h.$('#auth-description').textContent, /Синтетическая ошибка проверки/);
  h.$('#auth-retry').click();
  await until(() => reads === 3 && !h.$('#auth-form').hidden, 'Same invitation did not recover');
  assert.equal(h.$('#auth-name').value, 'Synthetic explicit draft');
  assert.equal(h.$('#auth-password').value, password);
  assert.equal(h.$('#auth-repeat').value, password);
  assert.equal(h.$('#auth-privacy-consent').checked, true);
  assert.equal(h.posts('/api/auth/invitations/accept').length, 0);
});

for (const change of ['recipient email', 'setup classification'])
  test('a changed invitation ' + change + ' clears the previous recipient draft', async (t) => {
    let info = { ...invitation, existingAccount: true, displayName: 'Synthetic old recipient' };
    const h = fixture(t, {
      url: 'https://organization.test/login.html#invite=' + invitationToken,
      session: {
        ...selected,
        user: {
          ...selected.user,
          email: 'owner@organization.test',
          displayName: 'Synthetic owner',
        },
      },
      readInvitation: () => info,
    });
    await readyInvitation(h);
    h.$('#auth-name').value = 'Synthetic first recipient draft';
    h.$('#auth-password').value = password;
    h.$('#auth-repeat').value = password;
    h.$('#auth-privacy-consent').checked = true;
    info =
      change === 'recipient email'
        ? {
            ...info,
            email: 'another-recipient@organization.test',
            displayName: 'Synthetic other stale name',
          }
        : { ...info, passwordSetupRequired: false };
    h.$('#auth-retry').click();
    await until(
      () => h.posts('/api/auth/invitations/info').length === 2 && !h.$('#auth-form').hidden,
      'Changed invitation context did not open',
    );
    assert.equal(h.$('#auth-email').value, info.email);
    assert.equal(h.$('#auth-name').value, '');
    assert.equal(h.$('#auth-password').value, '');
    assert.equal(h.$('#auth-repeat').value, '');
    assert.equal(h.$('#auth-privacy-consent').checked, false);
    assert.equal(h.$('#auth-name').required, info.passwordSetupRequired);
    assert.equal(h.posts('/api/auth/invitations/accept').length, 0);
    assert.equal(h.posts('/api/auth/register').length, 0);
  });

test('one-account login opens its assigned organization without presenting or posting a choice', async (t) => {
  const h = fixture(t);
  await submitCredentials(h);
  await until(() => h.written.length === 1, 'Assigned organization was not opened');
  assert.deepEqual(
    h.posts('/api/auth/login').map((call) => call.body),
    [{ email: 'member@organization.test', password }],
  );
  assert.match(h.shells()[0].route, /^\/index\.html\?/);
  assertNoOrganizationPicker(h);
});

test('a conflicting account login remains on the login form with the server explanation', async (t) => {
  const message =
    'Для разных организаций используйте отдельные учётные записи. Обратитесь в поддержку.';
  const h = fixture(t, { login: { error: message }, loginStatus: 409 });
  await submitCredentials(h);
  await until(() => h.$('#auth-error').textContent === message, 'Conflict explanation was hidden');
  assert.equal(h.$('#auth-form').hidden, false);
  assert.equal(h.$('#account-access-problem').hidden, true);
  assert.equal(h.$('#auth-email').value, 'member@organization.test');
  assert.equal(h.$('#auth-password').value, password);
  assert.equal(h.$('#auth-submit').disabled, false);
  assert.equal(h.shells().length, 0);
  assertNoOrganizationPicker(h);
});

test('a login with no accessible organization shows the empty access problem', async (t) => {
  const h = fixture(t, { login: { user: publicAccount, organizationId: null } });
  await submitCredentials(h);
  await readyProblem(h);
  assert.match(h.$('#account-access-message').textContent, /нет доступной организации/);
  assert.equal(h.$('#auth-password').value, '');
  assert.equal(h.shells().length, 0);
  assertNoOrganizationPicker(h);
});

for (const [description, session, message] of [
  ['no accessible organization', noAccess, /нет доступной организации/],
  ['an organization conflict', conflict, /отдельная учётная запись/],
])
  test(
    'an existing session with ' + description + ' shows a problem instead of a cabinet picker',
    async (t) => {
      const h = fixture(t, { session });
      await readyProblem(h);
      assert.match(h.$('#account-access-message').textContent, message);
      assert.equal(h.$('#auth-form').hidden, true);
      assert.equal(h.$('#auth-retry').hidden, false);
      assert.equal(h.$('#account-switch-account').hidden, false);
      assert.equal(h.posts('/api/auth/login').length, 0);
      assert.equal(h.shells().length, 0);
      assertNoOrganizationPicker(h);
    },
  );

test('retry opens an existing session once the server restores its sole organization', async (t) => {
  let repaired = false;
  const h = fixture(t, { readSession: () => (repaired ? selected : noAccess) });
  await readyProblem(h);
  repaired = true;
  h.$('#auth-retry').click();
  await until(() => h.written.length === 1, 'Repaired session did not open its organization');
  assert.equal(h.posts('/api/auth/login').length, 0);
  assert.equal(h.shells().length, 1);
  assertNoOrganizationPicker(h);
});

test('retry after session expiry returns to the ordinary login form', async (t) => {
  let expired = false;
  const h = fixture(t, { readSession: () => (expired ? anonymous : noAccess) });
  await readyProblem(h);
  expired = true;
  h.$('#auth-retry').click();
  await until(() => !h.$('#auth-form').hidden, 'Expired session did not return to login');
  assert.equal(h.$('#account-access-problem').hidden, true);
  assert.equal(h.$('#auth-submit').textContent, 'Войти');
  assert.equal(h.shells().length, 0);
  assertNoOrganizationPicker(h);
});

test('switching accounts blocks duplicate logout, preserves a failed exit and permits a clean retry', async (t) => {
  const pending = deferred();
  let attempts = 0;
  const h = fixture(t, {
    session: conflict,
    logout: () => (++attempts === 1 ? pending.promise : json({ ok: true })),
  });
  await readyProblem(h);
  h.$('#auth-password').value = password;
  h.$('#auth-repeat').value = password;
  h.$('#account-switch-account').click();
  h.$('#account-switch-account').dispatchEvent(new h.w.Event('click'));
  assert.equal(h.posts('/api/auth/logout').length, 1);
  assert.equal(h.$('#account-switch-account').disabled, true);
  assert.equal(h.$('#auth-retry').disabled, true);
  pending.resolve(json({ error: 'Не удалось выйти.' }, 503));
  await until(
    () => h.$('#account-access-error').textContent.includes('Не удалось выйти.'),
    'Logout error was hidden',
  );
  assert.equal(h.$('#account-access-problem').hidden, false);
  assert.equal(h.$('#auth-form').hidden, true);
  assert.equal(h.$('#account-switch-account').disabled, false);
  h.$('#account-switch-account').click();
  await until(() => !h.$('#auth-form').hidden, 'Successful logout did not return to login');
  assert.equal(h.posts('/api/auth/logout').length, 2);
  assert.equal(h.$('#account-access-problem').hidden, true);
  assert.equal(h.$('#auth-password').value, '');
  assert.equal(h.$('#auth-repeat').value, '');
  assert.equal(h.$('#auth-email').readOnly, false);
  assert.equal(h.shells().length, 0);
  assertNoOrganizationPicker(h);
});

test('an old access page cannot log out the different account now stored in the shared cookie', async (t) => {
  const cookieAccount = 'synthetic-new-cookie-account';
  let completedLogouts = 0;
  const h = fixture(t, {
    session: noAccess,
    captureNavigation: true,
    logout: (options) => {
      if (options.headers['X-Cartoteca-Account-Id'] !== cookieAccount)
        return json({ code: 'AUTH_CONTEXT_CHANGED', error: 'Учётная запись изменилась.' }, 428);
      completedLogouts++;
      return json({ ok: true });
    },
  });
  await readyProblem(h);
  h.$('#account-switch-account').click();
  await until(
    () => h.$('#account-access-error').textContent.includes('Учётная запись изменилась'),
    'Stale logout did not show a terminal refusal',
  );
  const logout = h.posts('/api/auth/logout')[0];
  assert.equal(logout.headers['X-Cartoteca-Account-Id'], user.id);
  assert.equal(logout.headers['X-Cartoteca-Organization-Id'], '');
  assert.equal(completedLogouts, 0);
  assert.deepEqual(h.redirects, ['/']);
  h.$('#account-switch-account').click();
  await nextTurn();
  assert.equal(h.posts('/api/auth/logout').length, 1);
  assert.equal(h.calls.filter((call) => call.route === '/api/auth/session').length, 1);
  assert.equal(completedLogouts, 0);
});

test('an explicit credential login into another account never carries the old session context', async (t) => {
  const h = fixture(t, {
    session: noAccess,
    url: 'https://organization.test/login.html?switch-account=1',
    login: {
      user: { id: 'synthetic-chosen-account', globalAdmin: false },
      organizationId: 'synthetic-chosen-org',
    },
  });
  await until(() => !h.$('#auth-form').hidden, 'Explicit account login form did not open');
  h.$('#auth-email').value = 'chosen@organization.test';
  h.$('#auth-password').value = password;
  h.submitLogin();
  await until(
    () => h.written.length === 1,
    'Explicit credential login did not open the chosen account',
  );
  const login = h.posts('/api/auth/login')[0];
  assert.equal(login.body.email, 'chosen@organization.test');
  assert.equal(login.headers['X-Cartoteca-Account-Id'], undefined);
  assert.equal(login.headers['X-Cartoteca-Organization-Id'], undefined);
  assert.equal(h.posts('/api/auth/logout').length, 0);
});

test('the access problem never renders organization names or turns an unknown status into markup', async (t) => {
  const name = '<img src=x onerror="window.syntheticNameExecuted=true"> & private organization';
  const h = fixture(t, {
    session: {
      ...noAccess,
      organizationAccess: name,
      memberships: [
        { organizationId: 'synthetic-private', organizationName: name, status: 'active' },
      ],
    },
  });
  await readyProblem(h);
  assert.match(h.$('#account-access-message').textContent, /нет доступной организации/);
  assert.doesNotMatch(h.$('#account-access-problem').textContent, /private organization/);
  assert.equal(h.$('#account-access-problem').querySelector('img'), null);
  assert.equal(h.w.syntheticNameExecuted, undefined);
  assertNoOrganizationPicker(h);
});

for (const [description, session, page] of [
  ['a selected account organization', selected, 'index'],
  [
    'a global administrator without an organization',
    { ...noAccess, user: { ...user, globalAdmin: true } },
    'admin',
  ],
  ['a legacy single-user cabinet', { ...noAccess, multiUser: false }, 'index'],
])
  test(description + ' still opens its existing shell directly', async (t) => {
    const h = fixture(t, { session });
    await until(() => h.written.length === 1, 'Existing authenticated entry path did not open');
    assert.match(h.shells()[0].route, new RegExp('^/' + page + '\\.html\\?'));
    assertNoOrganizationPicker(h);
  });

for (const session of [noAccess, conflict])
  for (const hash of ['', '#staff-push=synthetic-target'])
    test(
      'app startup redirects before protected reads for ' +
        session.organizationAccess +
        ': ' +
        (hash || 'plain'),
      async () => {
        const calls = [],
          redirects = [],
          state = {};
        const createSession = vm.runInNewContext(sessionSource + '\ncreateSessionStartup', {
          URLSearchParams,
          location: { hash, replace: (value) => redirects.push(value) },
          window: { addEventListener() {} },
          document: { body: { classList: { remove() {} } } },
        });
        const actions = new Proxy(
          {
            request: async (route) => {
              calls.push(route);
              return session;
            },
            resetAssistant() {},
            $: () => null,
          },
          {
            get: (target, key) =>
              target[key] ||
              (() => {
                calls.push(String(key));
              }),
          },
        );
        await createSession(state, actions).initialize();
        assert.deepEqual(calls, ['/api/auth/session']);
        assert.deepEqual(redirects, ['/login.html' + hash]);
        assert.equal(state.sessionReady, false);
      },
    );

test('app startup sends a global administrator to admin without requiring an organization', async () => {
  const calls = [],
    redirects = [];
  const createSession = vm.runInNewContext(sessionSource + '\ncreateSessionStartup', {
    URLSearchParams,
    location: { hash: '', replace: (value) => redirects.push(value) },
    window: { addEventListener() {} },
    document: {},
  });
  const actions = new Proxy(
    {
      request: async (route) => {
        calls.push(route);
        return { ...noAccess, user: { ...user, globalAdmin: true } };
      },
      resetAssistant() {},
      $: () => null,
    },
    {
      get: (target, key) =>
        target[key] ||
        (() => {
          calls.push(String(key));
        }),
    },
  );
  await createSession({}, actions).initialize();
  assert.deepEqual(calls, ['/api/auth/session']);
  assert.deepEqual(redirects, ['/admin.html']);
});
