const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs'),
  { createStorage } = require('../storage.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { PRIVACY_VERSION } = require('../src/shared/privacy-consent.cjs');
const { platformInspection } = require('./helpers/platform-inspection.cjs');
const root = path.resolve(__dirname, '..'),
  password = 'Synthetic-security-password-2026';
const photo =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==';
const token = (url) => decodeURIComponent(new URL(url).hash.split('=')[1]);
async function until(fn) {
  const end = Date.now() + 6000;
  while (!fn()) {
    if (Date.now() > end) throw Error('Security UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function fixture(t, { mail = true, production = false, lan = false, clinical = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-hardening-')),
    platform = createPlatformStore(path.join(dir, 'platform')),
    users = {},
    outbox = [],
    windows = [];
  users.owner = await platform.registerOwner({
    email: 'owner@example.test',
    password,
    displayName: 'Synthetic owner',
    organizationName: 'Synthetic clinic',
  });
  platform.verifyEmail(users.owner.verificationToken);
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
      displayName: 'Synthetic ' + name,
    });
  }
  const other = await platform.registerOwner({
    email: 'other@example.test',
    password,
    displayName: 'Other',
    organizationName: 'Other',
  });
  platform.verifyEmail(other.verificationToken);
  users.detached = await platform.registerOwner({
    email: 'detached@example.test',
    password,
    displayName: 'Detached recipient',
    organizationName: 'Inactive synthetic organization',
  });
  platform.verifyEmail(users.detached.verificationToken);
  const detachedDatabase = createPlatformDatabase(path.join(dir, 'platform'));
  try {
    detachedDatabase.db
      .prepare("UPDATE organizations SET status='suspended' WHERE id=?")
      .run(users.detached.organizationId);
    detachedDatabase.db
      .prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?")
      .run(users.detached.organizationId, users.detached.accountId);
  } finally {
    detachedDatabase.db.close();
  }
  const invite = platform.prepareEmailInvitation({
    organizationId: other.organizationId,
    actorId: other.accountId,
    role: 'cosmetologist',
    email: 'detached@example.test',
  });
  platform.finishEmailInvitation(
    {
      organizationId: other.organizationId,
      actorId: other.accountId,
      invitationId: invite.id,
      token: invite.token,
    },
    true,
  );
  if (clinical) {
    const clinic = createStorage(path.join(dir, 'tenants', users.owner.organizationId));
    clinic.write({
      revision: 0,
      services: [
        {
          id: 's',
          staffId: users.staff.accountId,
          name: 'Synthetic procedure',
          category: 'care',
          duration: '60 минут',
          price: 1000,
        },
      ],
      patients: [
        {
          id: 'p',
          name: 'Synthetic patient',
          createdBy: users.staff.accountId,
          visits: [
            {
              id: 'v',
              date: '2026-01-01',
              time: '10:00',
              duration: 60,
              procedure: 'Synthetic procedure',
              product: 'Saved product',
              notes: 'Saved note',
              staffId: users.staff.accountId,
              serviceItems: [
                {
                  id: 's',
                  name: 'Synthetic procedure',
                  category: 'care',
                  product: '',
                  duration: 60,
                  price: 1000,
                },
              ],
              photos: [{ data: photo, caption: 'До' }],
            },
          ],
          appointments: [],
        },
      ],
    });
    clinic.close();
  }
  platform.close();
  const delivery = { send: async () => {} },
    origin = production ? 'https://audit.example.test' : lan ? 'http://192.168.123.5:4174' : '';
  const server = createMultiServer({
    dataDir: dir,
    production,
    origin: production ? origin : '',
    additionalOrigins: lan ? [origin] : [],
    telegramBot: null,
    telegramAutostart: false,
    sendMail: mail
      ? async (email, url, meta) => {
          outbox.push({ email, url, ...meta });
          await delivery.send(email, url, meta);
        }
      : null,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port,
    requestOrigin = origin || base;
  t.after(async () => {
    windows.forEach((w) => w.close());
    await new Promise((r) => server.close(r));
    const target = path.resolve(dir);
    assert.ok(
      target.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
        path.basename(target).startsWith('cartoteca-hardening-'),
    );
    fs.rmSync(target, { recursive: true, force: true });
  });
  const contexts = new Map();
  const request = (route, body, cookie = '', method = body ? 'POST' : 'GET') =>
    new Promise((resolve, reject) => {
      if (body && route === '/api/auth/register')
        body = { privacyConsent: true, privacyConsentVersion: PRIVACY_VERSION, ...body };
      const req = http.request(
        base + route,
        {
          method,
          headers: {
            Host: new URL(requestOrigin).host,
            Origin: requestOrigin,
            'X-Cartoteca-Request': '1',
            'Content-Type': 'application/json',
            Cookie: cookie,
            ...contexts.get(cookie),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (x) => chunks.push(x));
          res.on('end', () => {
            const data = JSON.parse(Buffer.concat(chunks).toString()),
              issued = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (route === '/api/auth/login' && res.statusCode === 200 && issued)
              contexts.set(issued, authContextHeaders(data));
            resolve({ status: res.statusCode, data, cookie: issued });
          });
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  async function ui(name, width) {
    const login = await request('/api/auth/login', { email: name + '@example.test', password });
    assert.equal(login.status, 200);
    const cookie = login.cookie;
    const html = await (await fetch(base + '/index.html', { headers: { Cookie: cookie } })).text(),
      errors = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => {
      if (!e.message.includes('navigation')) errors.push(e.message);
    });
    const dom = new JSDOM(html, { url: base, runScripts: 'outside-only', virtualConsole: vc }),
      w = dom.window;
    windows.push(w);
    w.fetch = (url, options = {}) =>
      fetch(base + url, {
        ...options,
        headers: { ...options.headers, Origin: base, Cookie: cookie },
      });
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
  return { dir, base, users, outbox, delivery, request, invite, ui };
}
for (const mode of [{}, { lan: true }, { production: true }])
  test(
    'mail preflight prevents unsafe reset links and partial registration ' + JSON.stringify(mode),
    async (t) => {
      const f = await fixture(t, { ...mode, mail: false });
      const store = createPlatformStore(path.join(f.dir, 'platform')),
        before = platformInspection(path.join(f.dir, 'platform')).accounts.length,
        oldReset = store.requestPasswordReset('owner@example.test');
      store.close();
      for (const email of ['owner@example.test', 'absent@example.test']) {
        const r = await f.request('/api/auth/forgot', { email });
        assert.equal(r.status, 503);
        assert.equal(r.data.resetUrl, undefined);
      }
      assert.equal(
        (
          await f.request('/api/auth/register', {
            email: 'new@example.test',
            password,
            displayName: 'New',
            organizationName: 'New',
          })
        ).status,
        503,
      );
      const fresh = createPlatformStore(path.join(f.dir, 'platform'));
      try {
        assert.equal(platformInspection(path.join(f.dir, 'platform')).accounts.length, before);
        await fresh.resetPassword(oldReset, password);
      } finally {
        fresh.close();
      }
    },
  );
test('mail-only reset omits secrets on LAN and keeps single-use recovery/session revocation', async (t) => {
  const f = await fixture(t, { lan: true }),
    login = await f.request('/api/auth/login', { email: 'owner@example.test', password });
  const reset = await f.request('/api/auth/forgot', { email: 'owner@example.test' }),
    unknown = await f.request('/api/auth/forgot', { email: 'absent@example.test' });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data, unknown.data);
  assert.equal(reset.data.resetUrl, undefined);
  assert.ok(f.outbox[0].url.startsWith('http://192.168.123.5:4174/#reset='));
  const secret = token(f.outbox[0].url);
  assert.equal(
    (
      await f.request('/api/auth/reset', {
        token: secret,
        password: 'Replacement-synthetic-password',
      })
    ).status,
    200,
  );
  assert.equal((await f.request('/api/auth/reset', { token: secret, password })).status, 400);
  assert.equal((await f.request('/api/cabinet', null, login.cookie)).status, 401);
});
test('failed registration can resend safely without duplicating accounts or overwriting profile', async (t) => {
  const f = await fixture(t, { production: true }),
    body = {
      email: 'new@example.test',
      password,
      displayName: 'Original',
      organizationName: 'Original clinic',
    };
  f.delivery.send = async () => {
    throw Error('Synthetic mail error');
  };
  assert.equal((await f.request('/api/auth/register', body)).status, 503);
  const failed = token(f.outbox.at(-1).url);
  assert.equal((await f.request('/api/auth/verify-email', { token: failed })).status, 400);
  const store = createPlatformStore(path.join(f.dir, 'platform')),
    before = platformInspection(path.join(f.dir, 'platform'));
  store.close();
  assert.equal(
    (await f.request('/api/auth/register', { ...body, password: 'Wrong-synthetic-password' }))
      .status,
    401,
  );
  f.delivery.send = async () => {};
  const retry = await f.request('/api/auth/register', {
    ...body,
    displayName: 'Do not overwrite',
    organizationName: 'Do not overwrite',
  });
  assert.equal(retry.status, 201);
  assert.equal(retry.data.verificationUrl, undefined);
  const fresh = createPlatformStore(path.join(f.dir, 'platform'));
  try {
    assert.deepEqual(platformInspection(path.join(f.dir, 'platform')).accounts, before.accounts);
    assert.deepEqual(
      platformInspection(path.join(f.dir, 'platform')).organizations,
      before.organizations,
    );
  } finally {
    fresh.close();
  }
  assert.equal(
    (await f.request('/api/auth/verify-email', { token: token(f.outbox.at(-1).url) })).status,
    200,
  );
  assert.equal((await f.request('/api/auth/login', { email: body.email, password })).status, 200);
  assert.equal((await f.request('/api/auth/register', body)).status, 409);
});
test('late failed registration delivery cannot revoke a newer delivered verification', async (t) => {
  const f = await fixture(t),
    body = {
      email: 'concurrent@example.test',
      password,
      displayName: 'Concurrent',
      organizationName: 'Concurrent',
    },
    wait = {};
  f.delivery.send = async () => {
    if (f.outbox.length === 1)
      await new Promise((resolve, reject) => {
        wait.fail = () => reject(Error('Synthetic delayed failure'));
      });
  };
  const first = f.request('/api/auth/register', body);
  await until(() => wait.fail);
  assert.equal((await f.request('/api/auth/register', body)).status, 201);
  const newest = token(f.outbox.at(-1).url);
  wait.fail();
  assert.equal((await first).status, 503);
  assert.equal((await f.request('/api/auth/verify-email', { token: newest })).status, 200);
});
test('invitation password checks share persistent login limits and respect existing blocks', async (t) => {
  const f = await fixture(t),
    body = {
      token: f.invite.token,
      email: 'detached@example.test',
      password: 'Wrong-synthetic-password',
      displayName: 'Synthetic',
    };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.request('/api/auth/login', { email: body.email, password: body.password })).status,
      401,
    );
  for (let i = 0; i < 2; i++)
    assert.equal((await f.request('/api/auth/invitations/accept', body)).status, 401);
  assert.equal((await f.request('/api/auth/invitations/accept', body)).status, 429);
  assert.equal(
    (await f.request('/api/auth/invitations/accept', { ...body, password })).status,
    429,
  );
  assert.equal((await f.request('/api/auth/login', { email: body.email, password })).status, 429);
  const fresh = createPlatformStore(path.join(f.dir, 'platform'));
  try {
    await assert.rejects(fresh.acceptInvitation({ ...body, password }, 'different-client'), {
      status: 429,
    });
    assert.equal(fresh.memberships(f.users.detached.accountId).length, 1);
    assert.equal(fresh.availableMemberships(f.users.detached.accountId).length, 0);
    assert.equal(fresh.memberships(f.users.owner.accountId).length, 1);
  } finally {
    fresh.close();
  }
});
test('registration resends cannot become a separate password-guessing endpoint', async (t) => {
  const f = await fixture(t),
    body = {
      email: 'pending@example.test',
      password,
      displayName: 'Pending',
      organizationName: 'Pending',
    };
  assert.equal((await f.request('/api/auth/register', body)).status, 201);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await f.request('/api/auth/register', { ...body, password: 'Wrong-synthetic-password' }))
        .status,
      401,
    );
  assert.equal(
    (await f.request('/api/auth/register', { ...body, password: 'Wrong-synthetic-password' }))
      .status,
    429,
  );
  assert.equal((await f.request('/api/auth/register', body)).status, 429);
});
test('PUT and PATCH protect factual visits for staff/admin while allowing append-only notes/photos', async (t) => {
  const f = await fixture(t, { clinical: true }),
    owner = await f.request('/api/auth/login', { email: 'owner@example.test', password });
  for (const actor of ['staff', 'admin']) {
    const login = await f.request('/api/auth/login', { email: actor + '@example.test', password }),
      cookie = login.cookie;
    const read = () => f.request('/api/cabinet', null, cookie);
    for (const method of ['PUT', 'PATCH'])
      for (const change of [
        (v) => (v.date = '2026-02-01'),
        (v) => (v.time = '12:00'),
        (v) => (v.duration = 30),
        (v) => (v.staffId = f.users.owner.accountId),
        (v) => (v.serviceItems[0].price = 0),
        (v) => (v.procedure = 'Changed'),
        (v) => (v.notes = 'Replaced'),
        (v) => (v.photos[0].caption = 'После'),
      ]) {
        const before = (await read()).data,
          next = structuredClone(before);
        change(next.patients[0].visits[0]);
        const body =
          method === 'PUT'
            ? next
            : {
                revision: before.revision,
                services: [],
                patients: [{ id: 'p', before: before.patients[0], after: next.patients[0] }],
              };
        assert.equal(
          (
            await f.request(
              method === 'PUT' ? '/api/cabinet' : '/api/cabinet/changes',
              body,
              cookie,
              method,
            )
          ).status,
          403,
        );
        assert.equal((await read()).data.revision, before.revision);
      }
    const before = (await read()).data,
      next = structuredClone(before);
    next.patients[0].visits[0].notes += '\n\nAdded ' + actor;
    assert.equal(
      (
        await f.request(
          '/api/cabinet/changes',
          {
            revision: before.revision,
            services: [],
            patients: [{ id: 'p', before: before.patients[0], after: next.patients[0] }],
          },
          cookie,
          'PATCH',
        )
      ).status,
      200,
    );
  }
  const staff = await f.request('/api/auth/login', { email: 'staff@example.test', password }),
    before = (await f.request('/api/cabinet', null, staff.cookie)).data;
  before.patients[0].visits[0].photos.push({ data: photo, caption: 'После' });
  assert.equal((await f.request('/api/cabinet', before, staff.cookie, 'PUT')).status, 200);
  const data = (await f.request('/api/cabinet', null, owner.cookie)).data;
  assert.equal(data.patients[0].visits[0].photos.length, 2);
  data.patients[0].visits[0].serviceItems[0].price = 1200;
  assert.equal((await f.request('/api/cabinet', data, owner.cookie, 'PUT')).status, 200);
});
for (const width of [390, 1440])
  test(
    'saved visit UI offers safe additions and hides the sole calendar room at ' + width,
    async (t) => {
      const f = await fixture(t, { clinical: true }),
        h = await f.ui('staff', width),
        { $, w } = h;
      assert.equal($('#calendar-room-filter'), null);
      assert.equal($('.directory-note').textContent, 'Поиск клиентов и переход к их карточкам.');
      $('[data-view="clients"]').click();
      $('[data-client-filter="all"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      await until(() => $('[data-edit-visit="v"]'));
      $('[data-edit-visit="v"]').click();
      assert.equal($('#dialog-title').textContent, 'Дополнить посещение');
      for (const name of ['date', 'time', 'duration', 'recommendations'])
        assert.equal($('[name="' + name + '"]').disabled, true);
      for (const name of ['product', 'amount', 'zones'])
        assert.equal($('[name="' + name + '"]'), null);
      assert.equal($('#visit-procedure').disabled, true);
      assert.equal($('[data-remove-visit-procedure]').hidden, true);
      assert.equal($('[data-photo-caption]').disabled, true);
      assert.equal($('[data-remove-photo]'), null);
      assert.equal($('[name="notes"]').value, '');
      $('[name="date"]').value = '2026-03-01';
      $('[name="notes"]').value = 'Added from UI';
      h.submit();
      await until(() => !$('#editor').open);
      const owner = await f.request('/api/auth/login', { email: 'owner@example.test', password }),
        record = (await f.request('/api/cabinet', null, owner.cookie)).data.patients[0].visits[0];
      assert.equal(record.date, '2026-01-01');
      assert.equal(record.serviceItems[0].price, 1000);
      assert.equal(record.notes, 'Saved note\n\nAdded from UI');
      assert.deepEqual(h.errors, []);
    },
  );
