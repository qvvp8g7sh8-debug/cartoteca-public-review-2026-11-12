const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const root = path.resolve(__dirname, '..'),
  password = 'Synthetic-group-password-2026';
async function until(fn) {
  const end = Date.now() + 6000;
  while (!fn()) {
    if (Date.now() > end) throw Error('Group UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-groups-')),
    platform = createPlatformStore(path.join(dir, 'platform')),
    users = {},
    windows = [];
  for (const name of ['owner', 'other']) {
    users[name] = await platform.registerOwner({
      email: name + '@example.test',
      password,
      displayName: name,
      organizationName: name,
    });
    platform.verifyEmail(users[name].verificationToken);
  }
  for (const [name, role] of [
    ['staff', 'cosmetologist'],
    ['admin', 'salon_admin'],
  ]) {
    const invite = platform.createInvitation({
      organizationId: users.owner.organizationId,
      invitedBy: users.owner.accountId,
      role,
    });
    users[name] = await platform.acceptInvitation({
      token: invite.token,
      email: name + '@example.test',
      password,
      displayName: name,
    });
  }
  users.global = await platform.bootstrapGlobalAdmin({
    email: 'global@example.test',
    password,
    displayName: 'global',
  });
  platform.close();
  const storage = createStorage(path.join(dir, 'tenants', users.owner.organizationId));
  const visit = {
    id: 'v',
    date: '2020-01-01',
    type: 'Уход',
    procedure: 'Старая услуга',
    staffId: users.owner.accountId,
    serviceItems: [
      { id: 's', name: 'Старая услуга', category: 'care', product: '', duration: 30, price: 1000 },
    ],
    photos: [],
  };
  storage.write({
    revision: 0,
    patients: [
      {
        id: 'p',
        name: 'Вымышленный клиент',
        createdBy: users.owner.accountId,
        visits: [visit],
        appointments: [],
      },
    ],
    services: [
      {
        id: 's',
        name: 'Старая услуга',
        category: 'care',
        duration: '30 минут',
        product: '',
        price: 1000,
      },
    ],
  });
  storage.close();
  await require('./helpers/working-days.cjs').workingDays(dir, 'owner@example.test', password, [
    '2030-01-01',
  ]);
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    windows.forEach((w) => w.close());
    await new Promise((r) => server.close(r));
    assert.ok(
      path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
        path.basename(dir).startsWith('cartoteca-groups-'),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const contexts = new Map();
  const request = async (route, body, cookie = '', method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + route, {
      method,
      headers: {
        Origin: base,
        'X-Cartoteca-Request': '1',
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...contexts.get(cookie),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json(),
      issued = r.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && r.ok && issued)
      contexts.set(issued, authContextHeaders(data));
    return { status: r.status, data, cookie: issued };
  };
  const cookies = {};
  for (const name of Object.keys(users))
    cookies[name] = (
      await request('/api/auth/login', { email: name + '@example.test', password })
    ).cookie;
  async function ui(width) {
    const html = await (
        await fetch(base + '/index.html', { headers: { Cookie: cookies.owner } })
      ).text(),
      errors = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => {
      if (!e.message.includes('navigation')) errors.push(e.message);
    });
    const dom = new JSDOM(html, { url: base, runScripts: 'outside-only', virtualConsole: vc }),
      w = dom.window;
    windows.push(w);
    w.fetch = (url, opts = {}) =>
      fetch(base + url, {
        ...opts,
        headers: { ...opts.headers, Origin: base, Cookie: cookies.owner },
      });
    w.structuredClone = structuredClone;
    w.AbortController = AbortController;
    w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
    w.confirm = () => true;
    w.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    w.HTMLDialogElement.prototype.close = function (value = '') {
      this.returnValue = value;
      this.open = false;
      this.dispatchEvent(new w.Event('close'));
    };
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    return {
      w,
      $: (s) => w.document.querySelector(s),
      errors,
      submit() {
        w.document
          .querySelector('#editor-form')
          .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      },
    };
  }
  return { dir, users, cookies, request, visit, ui };
}
test('custom service groups are isolated, revision protected and persist without clinical changes', async (t) => {
  const f = await fixture(t),
    get = (name) => f.request('/api/service-groups', null, f.cookies[name]);
  assert.deepEqual((await get('owner')).data, {
    revision: 0,
    groups: [{ id: 'other', title: 'Другое' }],
  });
  assert.equal((await get('global')).status, 403);
  assert.equal(
    (await f.request('/api/service-groups', { revision: 0, title: 'Нельзя' }, f.cookies.staff))
      .status,
    403,
  );
  const before = (await f.request('/api/cabinet', null, f.cookies.owner)).data,
    created = await f.request(
      '/api/service-groups',
      { revision: 0, title: ' Мой уход ' },
      f.cookies.owner,
    );
  assert.equal(created.status, 201);
  assert.equal(created.data.groups[1].title, 'Мой уход');
  assert.equal((await get('staff')).data.groups.length, 2);
  assert.equal((await get('other')).data.groups.length, 1);
  assert.equal(
    (
      await f.request(
        '/api/service-groups',
        { revision: 0, title: 'Устаревший запрос' },
        f.cookies.admin,
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.request('/api/service-groups', { revision: 1, title: 'мой уход' }, f.cookies.owner))
      .status,
    409,
  );
  assert.equal(
    (
      await f.request(
        '/api/service-groups',
        { revision: 1, title: '', id: 'bad"' },
        f.cookies.owner,
      )
    ).status,
    400,
  );
  const second = await f.request(
    '/api/service-groups',
    { revision: 1, title: 'Мои консультации' },
    f.cookies.admin,
  );
  assert.equal(second.status, 201);
  const after = (await f.request('/api/cabinet', null, f.cookies.owner)).data;
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.patients, before.patients);
  assert.deepEqual(after.services, before.services);
  const other = (await f.request('/api/cabinet', null, f.cookies.other)).data;
  other.services = [
    {
      id: 'wrong',
      name: 'Нельзя',
      category: created.data.createdId,
      duration: '30 минут',
      price: 1000,
    },
  ];
  assert.equal((await f.request('/api/cabinet', other, f.cookies.other, 'PUT')).status, 400);
  const reopened = createPlatformStore(path.join(f.dir, 'platform'));
  try {
    assert.equal(reopened.serviceGroups(f.users.owner.organizationId).groups.length, 3);
    reopened.admin.updateProfile(f.users.global.accountId, f.users.owner.organizationId, {
      requestId: require('node:crypto').randomUUID(),
      expectedRevision: reopened.admin.organization(
        f.users.global.accountId,
        f.users.owner.organizationId,
      ).revision,
      changes: { name: 'New profile name' },
    });
    assert.equal(reopened.serviceGroups(f.users.owner.organizationId).groups.length, 3);
  } finally {
    reopened.close();
  }
});
test('only an empty custom group can be deleted, and a stale assignment cannot restore its reference', async (t) => {
  const f = await fixture(t);
  const remove = (name, id, revision) =>
    f.request('/api/service-groups', { id, revision }, f.cookies[name], 'DELETE');
  const getCabinet = () => f.request('/api/cabinet', null, f.cookies.owner);
  const created = await f.request(
    '/api/service-groups',
    { id: 'care', title: 'Уход', revision: 0 },
    f.cookies.owner,
  );
  assert.equal(created.status, 201);
  assert.equal((await remove('staff', 'care', 1)).status, 403);
  assert.equal((await remove('global', 'care', 1)).status, 403);
  assert.equal((await remove('other', 'care', 0)).status, 404);
  assert.equal((await remove('owner', 'care', 0)).status, 409);
  assert.equal((await remove('owner', 'missing', 1)).status, 404);
  for (const id of ['other', 'all']) assert.equal((await remove('owner', id, 1)).status, 400);
  assert.equal((await remove('owner', 'care', -1)).status, 400);

  const occupied = await remove('owner', 'care', 1);
  assert.equal(occupied.status, 409);
  assert.match(occupied.data.error, /Перенесите услуги/u);
  assert.deepEqual((await f.request('/api/service-groups', null, f.cookies.owner)).data, {
    revision: 1,
    groups: created.data.groups,
  });

  const before = (await getCabinet()).data;
  const moved = await f.request(
    '/api/cabinet',
    { ...before, services: before.services.map((service) => ({ ...service, category: 'other' })) },
    f.cookies.owner,
    'PUT',
  );
  assert.equal(moved.status, 200);
  const empty = (await getCabinet()).data;
  const removed = await remove('admin', 'care', 1);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, {
    revision: 2,
    groups: [{ id: 'other', title: 'Другое' }],
  });
  assert.deepEqual((await f.request('/api/service-groups', null, f.cookies.owner)).data, removed.data);
  assert.equal((await remove('owner', 'care', 2)).status, 404);

  const staleAssignment = await f.request(
    '/api/cabinet',
    { ...empty, services: empty.services.map((service) => ({ ...service, category: 'care' })) },
    f.cookies.owner,
    'PUT',
  );
  assert.equal(staleAssignment.status, 400);
  const after = (await getCabinet()).data;
  assert.equal(after.revision, empty.revision);
  assert.deepEqual(after.services, empty.services);
  assert.deepEqual(after.patients, before.patients);
  assert.deepEqual(after.patients[0].visits[0], f.visit);
});
for (const width of [390, 1440])
  test(
    'default Other, own empty groups and service editor preserve draft and old visit at ' + width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h;
      $('[data-view="services"]').click();
      assert.equal($('#service-category-select').options.length, 2);
      assert.deepEqual(
        [...$('#service-category-select').options].map((o) => o.textContent),
        ['Все услуги', 'Без группы'],
      );
      assert.ok($('[data-select-service="s"]'));
      $('#toggle-service-edit').click();
      w.prompt = () => {
        throw Error('Group creation must not use browser prompt');
      };
      $('[data-add-service-group]').click();
      assert.ok($('#service-group-dialog').open);
      $('#service-group-dialog [data-group-cancel]').click();
      assert.equal($('#service-group-dialog'), null);
      assert.equal(
        (await f.request('/api/service-groups', null, f.cookies.owner)).data.groups.length,
        1,
      );
      $('[data-add-service-group]').click();
      $('#service-group-dialog input').value = '   ';
      $('#service-group-dialog form').dispatchEvent(
        new w.Event('submit', { bubbles: true, cancelable: true }),
      );
      assert.ok($('#service-group-dialog').open);
      assert.equal($('#service-group-dialog input').checkValidity(), false);
      $('#service-group-dialog input').value = '<Особый уход>';
      $('#service-group-dialog form').dispatchEvent(
        new w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await until(() => $('#service-category-select').options.length === 3);
      const groups = (await f.request('/api/service-groups', null, f.cookies.owner)).data,
        group = groups.groups[1];
      assert.equal($('#service-category-select').value, group.id);
      assert.equal($('#global-view img'), null);
      $('[data-new-service-category]').click();
      assert.equal($('[name="category"]').value, group.id);
      $('[name="name"]').value = 'Новая услуга';
      const price = $('[name="price"]');
      assert.equal(price.step, 'any');
      assert.equal(price.inputMode, 'decimal');
      assert.equal(price.checkValidity(), false);
      price.value = '-1';
      assert.equal(price.checkValidity(), false);
      for (const value of ['1', '123', '2517.35']) {
        price.value = value;
        assert.equal(price.checkValidity(), true, value);
      }
      $('#editor [data-add-service-group]').click();
      assert.equal($('[name="name"]').value, 'Новая услуга');
      $('#service-group-dialog input').value = 'Вторая группа';
      $('#service-group-dialog form').dispatchEvent(
        new w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await until(() => $('[name="category"]').options.length === 3);
      assert.equal($('[name="name"]').value, 'Новая услуга');
      assert.equal($('[name="price"]').value, '2517.35');
      const selected = $('[name="category"]').value;
      h.submit();
      await until(() => !$('#editor').open);
      const saved = (await f.request('/api/cabinet', null, f.cookies.owner)).data;
      assert.equal(saved.services.at(-1).category, selected);
      assert.equal(saved.services.at(-1).price, 2517.35);
      assert.deepEqual(saved.patients[0].visits[0], f.visit);
      $('[data-edit-service="' + saved.services.at(-1).id + '"]').click();
      assert.equal($('[name="price"]').value, '2517.35');
      $('[name="price"]').value = '2999.99';
      assert.equal($('[name="price"]').checkValidity(), true);
      h.submit();
      await until(() => !$('#editor').open);
      assert.equal(
        (await f.request('/api/cabinet', null, f.cookies.owner)).data.services.at(-1).price,
        2999.99,
      );
      const next = await f.ui(width);
      next.$('[data-view="services"]').click();
      assert.equal(next.$('#service-category-select').options.length, 4);
      assert.equal(next.w.document.querySelectorAll('.service-select-card').length, 2);
      next.$('[data-select-service="' + saved.services.at(-1).id + '"]').click();
      next.$('#create-appointment-from-services').click();
      await until(() => next.$('#editor').open);
      next.$('[name="patientId"]').value = 'p';
      next.$('[name="date"]').value = '2030-01-01';
      next.$('[name="time"]').value = '12:00';
      next.submit();
      await until(() => !next.$('#editor').open);
      const result = (await f.request('/api/cabinet', null, f.cookies.owner)).data;
      assert.equal(
        result.patients[0].appointments[0].serviceItems[0].categoryTitle,
        'Вторая группа',
      );
      assert.equal(result.patients[0].appointments[0].serviceItems[0].price, 2999.99);
      assert.deepEqual(result.patients[0].visits[0], f.visit);

      next.$('[data-view="services"]').click();
      next.$('#toggle-service-edit').click();
      const groupSelect = next.$('#service-category-select');
      assert.equal(next.$('[data-delete-service-group]'), null);
      groupSelect.value = group.id;
      groupSelect.dispatchEvent(new next.w.Event('change', { bubbles: true }));
      assert.equal(next.$('#service-category-select'), groupSelect);
      next.$('[data-delete-service-group]').click();
      assert.equal(next.$('#action-confirmation').open, true);
      next.$('#action-confirmation [data-confirm-cancel]').click();
      assert.equal(groupSelect.value, group.id);
      next.$('[data-delete-service-group]').click();
      next.$('#action-confirmation [data-confirm-accept]').click();
      await until(() => next.$('#service-category-select').options.length === 3);
      assert.equal(next.$('#service-category-select').value, 'all');
      assert.equal(next.$('#toggle-service-edit').getAttribute('aria-pressed'), 'true');
      assert.equal(next.$('[data-delete-service-group]'), null);
      assert.deepEqual(h.errors, []);
      assert.deepEqual(next.errors, []);
    },
  );
