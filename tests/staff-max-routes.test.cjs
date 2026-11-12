const test = require('node:test'),
  assert = require('node:assert/strict');
const { routes } = require('../src/server/modules/notifications/staff-max-routes.cjs');
const route = (path) => routes.find((r) => r.path === '/api/max/staff' + path);

test('staff MAX routes are organization scoped and never accept a target account for linking', async () => {
  assert.equal(routes.length, 5);
  assert.deepEqual(
    routes.map(({ method, path }) => [method, path]),
    [
      ['GET', '/api/max/staff'],
      ['POST', '/api/max/staff/link'],
      ['POST', '/api/max/staff/settings'],
      ['POST', '/api/max/staff/unlink'],
      ['POST', '/api/max/staff/test'],
    ],
  );
  assert.ok(routes.every((r) => r.access === 'organization'));
  let writes = 0;
  const c = {
    req: {},
    token: 'synthetic-own-session',
    res: {},
    readBody: async () => ({ accountId: 'another-account' }),
    assertCurrent: () => {},
    staffMax: { issue: () => writes++ },
    json: () => {},
  };
  await assert.rejects(() => route('/link').handle(c), { status: 400 });
  assert.equal(writes, 0);
  for (const invalid of [null, [], { organizationId: 'other' }, { recipient: '1002' }]) {
    c.readBody = async () => invalid;
    await assert.rejects(() => route('/link').handle(c), { status: 400 });
  }
});

test('revoked access after async body prevents every staff MAX write', async () => {
  for (const suffix of ['/link', '/settings', '/unlink']) {
    let allowed = true,
      writes = 0;
    const c = {
      req: {},
      res: {},
      token: 'synthetic-own-session',
      readBody: async () => {
        allowed = false;
        return suffix === '/link' ? {} : { bindingId: 'synthetic', enabled: false };
      },
      assertCurrent: () => {
        if (!allowed) throw Object.assign(Error('Synthetic access revoked'), { status: 403 });
      },
      staffMax: { issue: () => writes++, update: () => writes++ },
      json: () => {},
    };
    await assert.rejects(() => route(suffix).handle(c), { status: 403 });
    assert.equal(writes, 0);
  }
});

test('commands use the authenticated session and disconnect only in the unlink route', async () => {
  const calls = [];
  for (const suffix of ['/settings', '/unlink']) {
    const body = {
      bindingId: 'synthetic-binding',
      ...(suffix === '/settings' ? { enabled: false } : {}),
    };
    const c = {
      req: {},
      res: {},
      token: 'synthetic-own-session',
      readBody: async () => body,
      assertCurrent: () => {},
      staffMax: {
        update: (...args) => {
          calls.push(args);
          return { linked: false };
        },
      },
      json: (res, status, value) => ({ status, value }),
    };
    assert.deepEqual(await route(suffix).handle(c), { status: 200, value: { linked: false } });
  }
  assert.deepEqual(calls[0], [
    'synthetic-own-session',
    { bindingId: 'synthetic-binding', enabled: false },
    false,
  ]);
  assert.deepEqual(calls[1], ['synthetic-own-session', { bindingId: 'synthetic-binding' }, true]);
});
