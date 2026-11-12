const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');
const root = path.resolve(__dirname, '..');
const password = 'Profile-test-password-2026';
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error('UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-profile-')),
    windows = [];
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'profile@example.test',
    password,
    displayName: 'Владелец',
    organizationName: 'Регистрационный салон',
    businessType: 'salon',
    city: 'Казань',
    phone: '+7 900 000-00-00',
  });
  platform.verifyEmail(owner.verificationToken);
  const other = await platform.registerOwner({
    email: 'other@example.test',
    password,
    displayName: 'Other',
    organizationName: 'Other Clinic',
  });
  platform.verifyEmail(other.verificationToken);
  const global = await platform.bootstrapGlobalAdmin({
    email: 'global@example.test',
    password,
    displayName: 'Admin',
  });
  platform.close();
  const outbox = [];
  const server = createMultiServer({
    dataDir: dir,
    sendMail: async (email, url) => outbox.push({ email, url }),
    telegramBot: null,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    windows.forEach((w) => w.close());
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  // These HTTP clients explicitly choose a synthetic actor by its login cookie.
  // Keep its original login DTO; never refresh identity before an action.
  const contexts = new Map();
  async function request(route, body, cookie = '') {
    const r = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie,
        ...contexts.get(cookie),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json(),
      nextCookie = r.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && r.ok && data.user && nextCookie)
      contexts.set(nextCookie, {
        'X-Cartoteca-Account-Id': data.user.id,
        'X-Cartoteca-Organization-Id': data.organizationId || '',
      });
    return {
      status: r.status,
      data,
      cookie: nextCookie,
    };
  }
  const login = await request('/api/auth/login', {
      email: 'profile@example.test',
      password,
    }),
    cookie = login.cookie;
  async function ui(width) {
    const errors = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e.message));
    const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
      url: base,
      runScripts: 'outside-only',
      virtualConsole: vc,
      pretendToBeVisual: true,
    }).window;
    windows.push(w);
    w.fetch = (route, opts = {}) =>
      fetch(base + route, {
        ...opts,
        headers: { ...opts.headers, Origin: base, Cookie: cookie },
      });
    w.AbortController = AbortController;
    w.structuredClone = structuredClone;
    w.matchMedia = (query) => ({
      matches: query.includes('min-width: 980px') ? width >= 980 : width <= 700,
      addEventListener() {},
    });
    w.confirm = () => true;
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    return { w, errors, $: (s) => w.document.querySelector(s) };
  }
  return { request, cookie, ui, owner, other, global, outbox };
}
for (const width of [390, 1440])
  test(
    'editable profile uses registration fields and avoids duplicate owner labels at width ' + width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width);
      h.$('[data-view="settings"]').click();
      await until(() => h.$('#account-profile-form'));
      await until(() => h.$('.team-members'));
      const blocks = [...h.w.document.querySelectorAll('.settings-accordion')];
      assert.deepEqual(
        blocks.map((b) => [
          b.querySelector('.settings-accordion-content').id,
          b.querySelector('.settings-tile-title').textContent,
        ]),
        [
          ['profile-settings', 'Мой профиль'],
          ['integrations-settings', 'Интеграции'],
          ['paid-services-settings', 'Пакеты и оплата'],
          ['team-settings', 'Сотрудники и доступ'],
          ['workspace-settings', 'Кабинеты и занятость'],
          ['online-booking-settings', 'Онлайн-запись'],
          ['telegram-settings', 'Напоминания клиентам'],
          ['support-settings', 'Техподдержка'],
          ['improvement-settings', 'Развитие Картотеки'],
        ],
      );
      for (const [index, block] of blocks.entries()) {
        assert.equal(block.open, width >= 980 && index === 0);
        assert.equal(block.querySelectorAll(':scope > summary').length, 1);
        if (!block.open) {
          let toggled = false;
          block.addEventListener(
            'toggle',
            () => {
              toggled = true;
            },
            { once: true },
          );
          block.querySelector('summary').click();
          await until(
            () => toggled && block.open && blocks.filter((item) => item.open).length === 1,
          );
        }
        assert.equal(block.open, true);
        if (block.querySelector('#telegram-settings'))
          await until(() => h.$('#telegram-settings-form'));
      }
      const profileBlock = h.$('#profile-settings').closest('details'),
        teamBlock = h.$('#team-settings').closest('details');
      await until(() => blocks.filter((b) => b.open).length === 1);
      if (!profileBlock.open) profileBlock.querySelector('summary').click();
      await until(() => profileBlock.open && blocks.filter((b) => b.open).length === 1);
      const form = h.$('#account-profile-form');
      assert.equal(h.$('#account-profile-name').textContent, 'Мой аккаунт');
      assert.equal(form.elements.displayName.value, 'Владелец');
      assert.equal(form.elements.organizationName.value, 'Регистрационный салон');
      assert.equal(form.elements.city.value, 'Казань');
      assert.equal(form.elements.phone.value, '+7 900 000-00-00');
      assert.equal(form.querySelector('[type="email"]').readOnly, true);
      form.elements.displayName.value = 'Тестовая Юлия';
      form.elements.organizationName.value = 'Студия';
      form.elements.city.value = 'Москва';
      form.elements.phone.value = '+7 900 111-11-11';
      assert.equal(form.elements.specialty.value, '');
      form.elements.specialty.value = 'Консультант';
      teamBlock.querySelector('summary').click();
      await until(() => teamBlock.open && !profileBlock.open);
      profileBlock.querySelector('summary').click();
      await until(() => profileBlock.open && !teamBlock.open);
      assert.equal(h.$('#account-profile-form'), form);
      assert.equal(form.elements.city.value, 'Москва');
      assert.equal(teamBlock.open, false);
      form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => h.$('#profile-message').textContent === 'Профиль сохранён');
      await until(() => h.$('#account-profile-name').textContent === 'Тестовая Юлия');
      assert.equal(teamBlock.open, false);
      assert.equal(profileBlock.open, true);
      assert.equal(h.$('#account-profile-name').textContent, 'Тестовая Юлия');
      assert.doesNotMatch(h.$('.team-members').textContent, /Тестовая Юлия/);
      assert.equal(
        (await f.request('/api/account/profile', null, f.cookie)).data.specialty,
        'Консультант',
      );
      teamBlock.querySelector('summary').click();
      await until(() => teamBlock.open && !profileBlock.open);
      const specialtyForm = h.$('[data-member-specialty="' + f.owner.accountId + '"]');
      assert.equal(specialtyForm, null);
      profileBlock.querySelector('summary').click();
      await until(() => profileBlock.open && !teamBlock.open);
      const ownProfile = h.$('#account-profile-form');
      ownProfile.elements.specialty.value = 'Тренер';
      ownProfile.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
      await until(
        () =>
          ownProfile.elements.expectedSpecialty.value === 'Тренер' &&
          !ownProfile.querySelector('[type="submit"]').disabled,
      );
      assert.equal(
        (await f.request('/api/account/profile', null, f.cookie)).data.specialty,
        'Тренер',
      );
      h.$('[data-view="calendar"]').click();
      await until(() => h.$('[data-view="calendar"]').getAttribute('aria-current') === 'page');
      h.$('[data-view="settings"]').click();
      await until(() => h.$('#account-profile-form'));
      assert.equal(h.$('#account-profile-form').elements.city.value, 'Москва');
      assert.equal(h.$('#account-profile-form').elements.specialty.value, 'Тренер');
      const reopened = [...h.w.document.querySelectorAll('.settings-accordion')];
      assert.ok(reopened.every((b, index) => b.open === (width >= 980 && index === 0)));
      assert.equal(
        (
          await f.request('/api/auth/login', {
            email: 'profile@example.test',
            password,
          })
        ).status,
        200,
      );
      assert.deepEqual(h.errors, []);
    },
  );
test('profile API isolates organizations, rejects privileged fields and preserves credentials and global clinical isolation', async (t) => {
  const f = await fixture(t),
    original = (await f.request('/api/account/profile', null, f.cookie)).data;
  assert.equal((await f.request('/api/account/profile')).status, 401);
  for (const extra of [
    { email: 'changed@example.test' },
    { role: 'owner' },
    { accountId: f.other.accountId },
    { organizationId: f.other.organizationId },
    { password: 'changed' },
    { globalAdmin: true },
  ]) {
    assert.equal(
      (await f.request('/api/account/profile', { displayName: 'Name', ...extra }, f.cookie)).status,
      400,
    );
  }
  assert.equal(
    (
      await f.request(
        '/api/account/profile',
        {
          displayName: 'Name',
          organization: { ...original.organization, legacyData: true },
        },
        f.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request('/api/account/profile', null, f.cookie)).data.account.displayName,
    'Владелец',
  );
  const updated = await f.request(
    '/api/account/profile',
    {
      displayName: 'Owner',
      organization: { name: 'New Clinic', city: 'New City', phone: '123' },
    },
    f.cookie,
  );
  assert.equal(updated.status, 200);
  assert.equal(Object.hasOwn(updated.data.organization, 'businessType'), false);
  const other = await f.request('/api/auth/login', {
    email: 'other@example.test',
    password,
  });
  assert.equal(
    (await f.request('/api/account/profile', null, other.cookie)).data.organization.name,
    'Other Clinic',
  );
  const global = await f.request('/api/auth/login', {
    email: 'global@example.test',
    password,
  });
  const profile = await f.request('/api/account/profile', null, global.cookie);
  assert.equal(profile.data.organization, null);
  assert.equal(profile.data.canEditOrganization, false);
  assert.doesNotMatch(JSON.stringify(profile.data), /passwordHash|salt|visits|patients|session/);
  assert.equal((await f.request('/api/cabinet', null, global.cookie)).status, 403);
  for (const role of ['salon_admin', 'cosmetologist']) {
    const email = role + '@example.test',
      invited = await f.request('/api/organization/invitations', { email, role }, f.cookie),
      token = new URL(f.outbox.at(-1).url).hash.split('=')[1];
    assert.equal(invited.status, 201);
    assert.equal(invited.data.inviteUrl, undefined);
    assert.equal(
      (
        await f.request('/api/auth/invitations/accept', {
          token,
          email,
          password,
          passwordConfirmation: password,
          displayName: 'Staff',
          privacyConsent: true,
          privacyConsentVersion: PRIVACY_VERSION,
        })
      ).status,
      200,
    );
    const login = await f.request('/api/auth/login', { email, password });
    assert.equal(
      (await f.request('/api/account/profile', { displayName: 'Staff New' }, login.cookie)).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          '/api/account/profile',
          { displayName: 'Staff New', organization: original.organization },
          login.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request('/api/account/profile', null, login.cookie)).data.account.displayName,
      'Staff New',
    );
    const contact = {
      displayName: 'Staff New',
      contactPhone: '8 (900) 000-00-01',
      expectedContactPhone: '',
    };
    const saved = await f.request('/api/account/profile', contact, login.cookie);
    assert.equal(saved.status, role === 'salon_admin' ? 200 : 403);
    if (role === 'salon_admin') {
      assert.equal(saved.data.contactPhone, '+79000000001');
      assert.equal(saved.data.canEditContactPhone, true);
      assert.equal(saved.data.organization.phone, updated.data.organization.phone);
      assert.equal((await f.request('/api/account/profile', contact, login.cookie)).status, 409);
      const cleared = await f.request(
        '/api/account/profile',
        {
          displayName: 'Staff New',
          contactPhone: '',
          expectedContactPhone: '+79000000001',
        },
        login.cookie,
      );
      assert.equal(cleared.status, 200);
      assert.equal(cleared.data.contactPhone, '');
    }
    await f.request('/api/auth/logout', {}, login.cookie);
    assert.equal(
      (await f.request('/api/account/profile', { displayName: 'Revoked' }, login.cookie)).status,
      401,
    );
  }
});
