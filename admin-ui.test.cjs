const { assetPath } = require('./tests/helpers/interface-assets.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = __dirname;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for administrator UI');
    await pause(10);
  }
}
const org = (id, name = 'Тестовая студия') => ({
  id,
  name,
  ownerName: 'Анна',
  ownerEmail: 'owner@example.test',
  businessType: 'individual',
  city: 'Казань',
  phone: '+7 900 000-00-00',
  status: 'active',
  plan: 'free',
  subscriptionStatus: 'active',
  timeZone: 'Europe/Moscow',
  revision: 0,
  subscriptionRevision: 0,
  limits: { patients: 10, photos: 50, publicBooking: true, automaticNotifications: true },
  members: [],
  usage: { available: true, patients: 0, photos: 0 },
  lastActivityAt: null,
});
async function boot(t, handler) {
  const errors = [],
    calls = [],
    virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(fs.readFileSync(assetPath('admin.html'), 'utf8'), {
    url: 'http://127.0.0.1:4174/admin.html',
    runScripts: 'outside-only',
    virtualConsole,
  });
  t.after(() => dom.window.close());
  const { window } = dom,
    $ = (selector) => window.document.querySelector(selector);
  window.confirm = () => true;
  window.fetch = async (route, options = {}) => {
    calls.push({ route, options });
    const url = new URL(route, window.location.href);
    let result;
    if (url.pathname === '/api/auth/session')
      result = {
        user: {
          id: 'synthetic-admin',
          organizationId: null,
          displayName: 'Оператор',
          email: 'root@example.test',
          globalAdmin: true,
        },
      };
    else if (url.pathname === '/api/admin/overview')
      result = {
        accountsActive: 3,
        accountsTotal: 3,
        organizationsTotal: 2,
        organizationsSuspended: 0,
        supportNew: 1,
        supportOpen: 1,
        failedDeliveries: 0,
      };
    else result = await handler(url, options);
    return { ok: !result?.error, status: result?.status || 200, json: async () => result };
  };
  window.eval(fs.readFileSync(assetPath('admin.js'), 'utf8'));
  await until(() => !$('#admin-dashboard').hidden);
  return { window, $, calls, errors };
}

test('backup card distinguishes absent/incomplete protection and escapes unknown error/state strings', async (t) => {
  const { $, errors } = await boot(t, async (url) =>
    url.pathname === '/api/admin/system'
      ? {
          observedAt: Date.now(),
          version: 'synthetic',
          memoryMegabytes: 25,
          uptimeSeconds: 60,
          mailConfigured: false,
          support: {},
          queues: {},
          backups: {
            configured: true,
            health: 'incomplete',
            remoteConfigured: false,
            error: '<img onerror=alert(1)>',
            recent: [{ startedAt: Date.now(), state: '<script>bad</script>' }],
          },
        }
      : { items: [], total: 0 },
  );
  $('[data-admin-view="system"]').click();
  await until(() => $('.admin-backups'));
  assert.match($('.admin-backups').textContent, /Защита неполная/);
  assert.match($('.admin-backups').textContent, /не защищает от потери сервера/);
  assert.equal($('.admin-backups img'), null);
  assert.equal($('.admin-backups script'), null);
  assert.equal($('.admin-backups button'), null);
  assert.deepEqual(errors, []);
});

test('administrator loads only counts initially, searches on server and lazily expands one contact', async (t) => {
  const { $, calls, errors, window } = await boot(t, async (url) => {
    if (url.pathname === '/api/admin/organizations')
      return {
        items: url.searchParams.get('q') ? [org('o1')] : [org('o1'), org('o2', 'Вторая')],
        total: url.searchParams.get('q') ? 1 : 2,
      };
    if (url.pathname === '/api/admin/organization') return org(url.searchParams.get('id'));
    return { items: [], total: 0 };
  });
  assert.equal($('#admin-organizations').children.length, 0);
  assert.equal(
    calls.some((x) => x.route.startsWith('/api/admin/organizations')),
    false,
  );
  $('[data-admin-view="organizations"]').click();
  await until(() => $('#admin-organizations').children.length === 2);
  assert.equal(
    calls.some((x) => x.route.startsWith('/api/admin/organization?')),
    false,
  );
  const first = $('#admin-organizations details');
  first.open = true;
  await until(() => first.querySelector('[data-admin-command="profile"]'));
  const second = $('#admin-organizations details:nth-child(2)');
  second.open = true;
  await until(() => second.querySelector('[data-admin-command="profile"]'));
  assert.equal(first.open, false);
  $('#admin-org-search').value = 'Казань Анна';
  $('#admin-org-search').dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => $('#admin-org-result-count').textContent === 'Показано 1 из 1');
  assert.ok(
    calls.some((x) => new URL(x.route, 'http://synthetic').searchParams.get('q') === 'Казань Анна'),
  );
  assert.deepEqual(errors, []);
});

test('stale directory responses cannot overwrite current search and show-more appends without duplicate rows', async (t) => {
  let resume;
  const { $, window } = await boot(t, async (url) => {
    if (url.searchParams.get('q') === 'old')
      return new Promise((resolve) => {
        resume = () => resolve({ items: [org('old')], total: 1 });
      });
    if (url.searchParams.get('cursor')) return { items: [org('new'), org('more')], total: 2 };
    if (url.searchParams.get('q') === 'new')
      return { items: [org('new', 'Новый результат')], total: 2, nextCursor: 'next' };
    return { items: [], total: 0 };
  });
  $('[data-admin-view="organizations"]').click();
  $('#admin-org-search').value = 'old';
  $('#admin-org-search').dispatchEvent(new window.Event('input'));
  await until(() => resume);
  $('#admin-org-search').value = 'new';
  $('#admin-org-search').dispatchEvent(new window.Event('input'));
  await until(() => $('[data-id="new"]'));
  resume();
  await pause(30);
  assert.equal($('[data-id="old"]'), null);
  $('#admin-org-more').click();
  await until(() => $('#admin-org-result-count').textContent === 'Показано 2 из 2');
  assert.equal($('#admin-organizations').children.length, 2);
});

test('an unsaved contact survives rejected navigation or closing; global account never gets recovery controls', async (t) => {
  const { $, window } = await boot(t, async (url) => {
    if (url.pathname === '/api/admin/organizations') return { items: [org('o1')], total: 1 };
    if (url.pathname === '/api/admin/organization') return org('o1');
    if (url.pathname === '/api/admin/accounts')
      return {
        items: [
          {
            id: 'root',
            email: 'root@example.test',
            displayName: '<script>bad</script>',
            globalAdmin: true,
            status: 'active',
          },
        ],
        total: 1,
      };
    if (url.pathname === '/api/admin/account')
      return {
        id: 'root',
        email: 'root@example.test',
        globalAdmin: true,
        memberships: [],
        sessions: 1,
        emailVerified: true,
      };
    return { items: [] };
  });
  $('[data-admin-view="organizations"]').click();
  await until(() => $('[data-id="o1"]'));
  $('[data-id="o1"]').open = true;
  await until(() => $('[name="city"]'));
  $('[name="city"]').value = 'Несохранённый город';
  $('[name="city"]').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.confirm = () => false;
  $('[data-admin-view="accounts"]').click();
  assert.equal($('[data-admin-section="organizations"]').hidden, false);
  $('[data-admin-close]').click();
  assert.equal($('[data-id="o1"]').open, true);
  window.confirm = () => true;
  $('[data-admin-view="accounts"]').click();
  await until(() => $('[data-id="root"]'));
  $('[data-id="root"]').open = true;
  await until(() => $('[data-id="root"]').textContent.includes('Системная'));
  assert.equal($('[data-admin-command="emailRecovery"]'), null);
  assert.equal($('script:not([src])'), null);
});

test('lost mutation response is reconciled through receipt and does not duplicate the command', async (t) => {
  let saved = false,
    writes = 0;
  const { $, window } = await boot(t, async (url, options) => {
    if (url.pathname === '/api/admin/organizations') return { items: [org('o')], total: 1 };
    if (url.pathname === '/api/admin/organization')
      return { ...org('o'), revision: saved ? 1 : 0, city: saved ? 'Тула' : 'Казань' };
    if (url.pathname === '/api/admin/organizations/update') {
      writes++;
      saved = true;
      throw Error('Synthetic lost response');
    }
    if (url.pathname === '/api/admin/operation') return { result: { ok: true, revision: 1 } };
    return { items: [] };
  });
  $('[data-admin-view="organizations"]').click();
  await until(() => $('[data-id="o"]'));
  $('[data-id="o"]').open = true;
  await until(() => $('[name="city"]'));
  $('[name="city"]').value = 'Тула';
  $('[data-admin-command="profile"]').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await until(() => $('#admin-message').textContent === 'Изменения сохранены.');
  assert.equal(writes, 1);
  assert.equal($('[name="city"]').value, 'Тула');
});

test('409 preserves local form and shows an explicit failure instead of success', async (t) => {
  const { $, window } = await boot(t, async (url) => {
    if (url.pathname === '/api/admin/organizations') return { items: [org('o')], total: 1 };
    if (url.pathname === '/api/admin/organization') return org('o');
    return { status: 409, error: 'Карточка изменилась' };
  });
  $('[data-admin-view="organizations"]').click();
  await until(() => $('[data-id="o"]'));
  $('[data-id="o"]').open = true;
  await until(() => $('[name="city"]'));
  $('[name="city"]').value = 'Сохранить черновик';
  $('[data-admin-command="profile"]').dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  await until(() => $('#admin-message').dataset.status === 'error');
  assert.equal($('[name="city"]').value, 'Сохранить черновик');
  assert.match($('#admin-message').textContent, /Карточка изменилась/);
});

test('email confirmation page never changes account merely on opening the link', async (t) => {
  const dom = new JSDOM(fs.readFileSync(assetPath('login.html'), 'utf8'), {
    url: 'http://127.0.0.1:4174/login.html#confirm-email-change=synthetic-token',
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom,
    $ = (selector) => window.document.querySelector(selector);
  let confirmations = 0;
  window.fetch = async (route) => ({
    ok: true,
    json: async () => {
      if (route === '/api/auth/session') return { multiUser: true, configured: true };
      confirmations++;
      return { ok: true };
    },
  });
  window.eval(fs.readFileSync(assetPath('login.js'), 'utf8'));
  await until(() => !$('#email-change-form').hidden);
  assert.equal(confirmations, 0);
  assert.equal(window.location.hash, '');
  $('#email-change-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => $('#email-change-form').hidden);
  assert.equal(confirmations, 1);
  assert.equal($('#auth-form').hidden, false);
  assert.match($('#extra-message').textContent, /подтверждена/);
});
