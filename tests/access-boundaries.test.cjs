const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { authContextHeaders, scopedPhotoUrl } = require('./helpers/account-context.cjs');
const password = 'Synthetic-boundary-password-2026';
const photo =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==';
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-access-boundaries-')),
    platform = createPlatformStore(path.join(dir, 'platform')),
    users = {};
  users.owner = await platform.registerOwner({
    email: 'owner@example.test',
    password,
    displayName: 'Synthetic owner',
    organizationName: 'Synthetic clinic',
  });
  platform.verifyEmail(users.owner.verificationToken);
  for (const [name, role] of [
    ['a', 'cosmetologist'],
    ['b', 'cosmetologist'],
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
  platform.close();
  const storage = createStorage(path.join(dir, 'tenants', users.owner.organizationId));
  const saved = storage.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'own',
        name: 'Synthetic A',
        createdBy: users.a.accountId,
        appointments: [],
        visits: [
          {
            id: 'own-v',
            date: '2026-01-01',
            procedure: 'Synthetic A',
            staffId: users.a.accountId,
            photos: [{ data: photo }],
          },
        ],
      },
      {
        id: 'foreign',
        name: 'Synthetic B',
        createdBy: users.b.accountId,
        appointments: [],
        visits: [
          {
            id: 'foreign-v',
            date: '2026-01-01',
            procedure: 'Synthetic B',
            staffId: users.b.accountId,
            photos: [{ data: photo }],
          },
        ],
      },
      {
        id: 'empty',
        name: 'Synthetic profile',
        createdBy: users.a.accountId,
        notes: 'Synthetic private note',
        appointments: [],
        visits: [],
      },
    ],
  });
  storage.close();
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-access-boundaries-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const contexts = new Map();
  async function request(route, body, cookie = '', method = body ? 'POST' : 'GET') {
    const expected = contexts.get(cookie),
      target = route.startsWith('/api/photos/') ? scopedPhotoUrl(route, expected) : route;
    const res = await fetch(base + target, {
      method,
      headers: {
        Origin: base,
        'X-Cartoteca-Request': '1',
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...expected,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null,
      issued = res.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && res.ok && issued)
      contexts.set(issued, authContextHeaders(data));
    return { status: res.status, data, cookie: issued };
  }
  const cookies = {};
  for (const name of Object.keys(users))
    cookies[name] = (
      await request('/api/auth/login', { email: name + '@example.test', password })
    ).cookie;
  const read = async (name) => (await request('/api/cabinet', null, cookies[name])).data;
  async function change(name, method, edit) {
    const before = await read(name),
      next = structuredClone(before);
    edit(next);
    return request(
      method === 'PUT' ? '/api/cabinet' : '/api/cabinet/changes',
      method === 'PUT'
        ? next
        : {
            revision: before.revision,
            services: [],
            patients: next.patients
              .filter(
                (p) =>
                  JSON.stringify(p) !== JSON.stringify(before.patients.find((b) => b.id === p.id)),
              )
              .map((after) => ({
                id: after.id,
                before: before.patients.find((p) => p.id === after.id) || null,
                after,
              })),
          },
      cookies[name],
      method,
    );
  }
  return {
    users,
    cookies,
    request,
    read,
    change,
    foreignPhoto: saved.patients[1].visits[0].photos[0].data,
  };
}
for (const method of ['PUT', 'PATCH'])
  test('staff cannot launder an inaccessible existing photo through ' + method, async (t) => {
    const f = await fixture(t),
      before = await f.read('a');
    assert.equal((await f.request(f.foreignPhoto, null, f.cookies.a)).status, 404);
    const denied = await f.change('a', method, (state) =>
      state.patients.find((p) => p.id === 'own').visits[0].photos.push({ data: f.foreignPhoto }),
    );
    assert.equal(denied.status, 403);
    assert.equal(
      (
        await f.change('a', method, (state) =>
          state.patients
            .find((p) => p.id === 'own')
            .visits.push({
              id: 'new-own-v',
              date: '2026-01-02',
              procedure: 'Synthetic',
              staffId: f.users.a.accountId,
              photos: [{ data: f.foreignPhoto }],
            }),
        )
      ).status,
      403,
    );
    assert.deepEqual(await f.read('a'), before);
    assert.equal((await f.request(f.foreignPhoto, null, f.cookies.a)).status, 404);
    const allowed = await f.change('a', method, (state) => {
      const p = state.patients.find((p) => p.id === 'own');
      p.visits[0].photos.push({ ...p.visits[0].photos[0] }, { data: photo });
    });
    assert.equal(allowed.status, 200);
    const own = (await f.read('a')).patients.find((p) => p.id === 'own');
    assert.equal(own.visits[0].photos.length, 3);
    assert.equal((await f.request(own.visits[0].photos[2].data, null, f.cookies.a)).status, 200);
  });
for (const method of ['PUT', 'PATCH'])
  test(
    'staff cannot rewrite or remove the creator of an existing profile through ' + method,
    async (t) => {
      const f = await fixture(t);
      assert.equal(
        (await f.read('b')).patients.some((p) => p.id === 'empty'),
        false,
      );
      for (const edit of [(p) => (p.createdBy = f.users.b.accountId), (p) => delete p.createdBy]) {
        assert.equal(
          (
            await f.change('a', method, (state) =>
              edit(state.patients.find((p) => p.id === 'empty')),
            )
          ).status,
          403,
        );
        assert.equal(
          (await f.read('b')).patients.some((p) => p.id === 'empty'),
          false,
        );
      }
    },
  );
test('owner and salon administrator retain intentional full photo access', async (t) => {
  const f = await fixture(t);
  for (const name of ['owner', 'admin']) {
    assert.equal(
      (
        await f.change(name, 'PATCH', (state) =>
          state.patients
            .find((p) => p.id === 'own')
            .visits[0].photos.push({ data: f.foreignPhoto }),
        )
      ).status,
      200,
    );
    assert.equal((await f.request(f.foreignPhoto, null, f.cookies[name])).status, 200);
  }
});
test('photo references are authorized again after asynchronous decoding and before commit', async () => {
  const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
  const current = { role: 'cosmetologist', accountId: 'staff', organizationId: 'org' },
    reference = '/api/photos/' + 'a'.repeat(32);
  const patient = {
      id: 'p',
      name: 'Synthetic',
      createdBy: 'staff',
      appointments: [],
      visits: [
        {
          id: 'v',
          date: '2026-01-01',
          procedure: 'Synthetic',
          staffId: 'staff',
          photos: [{ data: reference }],
        },
      ],
    },
    after = structuredClone(patient);
  after.visits[0].photos.push({ data: photo });
  let visible = true,
    written = false,
    checks = 0;
  const storage = {
    readSelected: () => ({ revision: 1, patients: [structuredClone(patient)], services: [] }),
    indexes: {
      totals: () => ({ patients: 1, photos: 1, services: 0 }),
      assertUnique() {},
      photoVisible() {
        checks++;
        return visible;
      },
    },
    async prepareImages() {
      visible = false;
      return new Map();
    },
    transaction: (fn) => fn(),
    write() {
      written = true;
    },
  };
  const platform = {
    workspaceIdentities: () => [{ accountId: 'staff', role: 'cosmetologist', status: 'active' }],
    workSchedules: { assertChanges() {} },
    organizationTimeZone: () => 'Europe/Moscow',
    subscription: () => ({ status: 'active', limits: { patients: 10, photos: 50 } }),
    assertServiceGroups() {},
    assertServiceCatalog() {},
    assertWorkspaceSelection() {},
    withWriteLock: (fn) => fn(),
    session: () => current,
  };
  await assert.rejects(
    saveMutation(
      { current, platform, tenantStore: () => storage, assertCurrent() {}, token: 'synthetic' },
      { revision: 1, services: [], patients: [{ id: 'p', before: patient, after }] },
      { partial: true },
    ),
    { status: 403 },
  );
  assert.equal(written, false);
  assert.equal(checks, 2);
});
