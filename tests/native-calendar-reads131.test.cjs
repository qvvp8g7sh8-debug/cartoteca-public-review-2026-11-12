const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { setImmediate: turn } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const { isNativeQuery } = require('../src/server/infrastructure/native-query-kernel.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const routes = [
  ...require('../src/server/modules/cabinet/queries.cjs').routes,
  ...require('../src/server/modules/workspace/routes.cjs').routes,
  ...require('../src/server/modules/schedules/routes.cjs').routes,
  ...require('../src/server/modules/services/routes.cjs').routes,
];
const paths = [
  '/api/cabinet/time-zone',
  '/api/workspace',
  '/api/workspace/availability?from=2035-01-01&to=2035-01-07',
  '/api/work-schedules?from=2035-01-01&to=2035-01-07',
  '/api/service-groups',
];
function headers(actor, extra = {}) {
  return {
    cookie: 'cartoteca_v2_session=' + actor.token,
    'x-cartoteca-account-id': actor.accountId,
    'x-cartoteca-organization-id': actor.organizationId,
    ...extra,
  };
}
function runtime() {
  const provider = { configured: false, connected: false, botId: '' };
  return {
    telegram: { ...provider, username: '', error: '' },
    providers: { telegram: { ...provider }, max: { ...provider } },
    timestamp: Date.now(),
  };
}
async function execute(executor, actor, url, extraHeaders = {}) {
  const result = await executor.run({
    kind: 'query',
    payload: Buffer.alloc(0),
    metadata: {
      method: 'GET',
      url,
      headers: { host: '127.0.0.1:4174', ...headers(actor, extraHeaders) },
      localPort: 4174,
      remoteAddress: '127.0.0.1',
      runtime: runtime(),
    },
  });
  try {
    return {
      status: result.status,
      headers: result.headers,
      body: JSON.parse(result.body.toString()),
    };
  } finally {
    result.release();
  }
}
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function httpResult(base, actor, url, replacements = {}) {
  const result = await fetch(base + url, { headers: headers(actor, replacements) });
  return { status: result.status, body: await result.json() };
}

test('only the ten exact read GET paths use the native projection; mutations retain one owner', () => {
  for (const url of paths) {
    assert.equal(isNativeQuery({ method: 'GET', url }), true, url);
    for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
      assert.equal(isNativeQuery({ method, url }), false, method + ' ' + url);
  }
  for (const url of [
    '/api/workspace/other',
    '/api/workspace/availability/extra',
    '/api/service-groups/extra',
    '/api/work-schedules/check',
    '/api/work-schedules/permission',
    '/api/assistant/turn',
    '/api/assistant/execute',
    '/api/cabinet/appointments',
    '/api/cabinet/changes',
  ])
    assert.equal(isNativeQuery({ method: 'GET', url }), false, url);
});

test(
  'five native read routes equal the actual owner, administrator and employee handlers',
  { timeout: 60000 },
  async (t) => {
    const f = await staffMaxFixture(t),
      [owner, admin, employee] = f.users;
    const storage = createStorage(path.join(f.source, 'tenants', owner.organizationId));
    const state = storage.read();
    state.patients = [owner, employee].map((actor, index) => ({
      id: 'synthetic-client-' + index,
      name: 'Synthetic client ' + index,
      createdBy: actor.accountId,
      phone: '+79990000000',
      visits: [],
      appointments: [
        {
          id: 'synthetic-appointment-' + index,
          staffId: actor.accountId,
          roomId: 'main',
          date: '2035-01-02',
          time: index ? '11:00' : '10:00',
          duration: 30,
          service: 'Synthetic service',
        },
      ],
    }));
    storage.write(state);
    const workspace = f.platform.workspaceSettings(owner.organizationId);
    f.platform.saveWorkspace(
      owner.organizationId,
      owner.accountId,
      {
        revision: workspace.revision,
        roomAssignments: [
          { id: 'main', staffMode: 'multiple', staffIds: [owner.accountId, employee.accountId] },
        ],
      },
      () => storage.read(),
    );
    f.platform.workSchedules.save(
      owner.token,
      {
        staffId: employee.accountId,
        dates: ['2035-01-02'],
        status: 'working',
        intervals: [['09:00', '18:00']],
        revision: 0,
        expectedTimeZone: 'Europe/Moscow',
      },
      storage,
    );
    f.platform.createServiceGroup(owner.token, { revision: 0, title: 'Synthetic read group' });
    const executor = createNativeExecutor({
      filename: path.resolve(__dirname, '../src/server/infrastructure/native-query-worker.cjs'),
      workerData: { config: { dataDir: f.source, notificationSchema: 16 } },
    });
    try {
      await executor.ready();
      const before = storage.read();
      for (const actor of [owner, admin, employee]) {
        const current = f.platform.session(actor.token);
        for (const url of [...paths, paths[3] + '&staffId=' + employee.accountId]) {
          let expected;
          const route = routes.find(
            (r) => r.method === 'GET' && r.path === new URL(url, 'http://local').pathname,
          );
          await route.handle({
            current,
            token: actor.token,
            platform: f.platform,
            tenantStore(org) {
              assert.equal(org, owner.organizationId);
              return storage;
            },
            assertCurrent() {
              assert.ok(f.platform.session(actor.token));
            },
            url: new URL(url, 'http://127.0.0.1:4174'),
            req: {},
            res: {},
            json(_res, status, body) {
              expected = { status, body: JSON.parse(JSON.stringify(body)) };
            },
          });
          const actual = await execute(executor, actor, url);
          assert.equal(actual.status, expected.status, url + ' ' + current.role);
          assert.deepEqual(actual.body, expected.body, url + ' ' + current.role);
          assert.equal(actual.headers['Cache-Control'], 'no-store');
        }
      }
      assert.deepEqual(storage.read(), before, 'Every new projection is effect-free');
      const restricted = await execute(executor, employee, paths[1]);
      assert.equal(restricted.body.canEdit, false);
      assert.equal(restricted.body.canEditRoomAssignments, false);
      assert.deepEqual(restricted.body.members, []);
      assert.deepEqual(
        (await execute(executor, employee, paths[3] + '&staffId=' + owner.accountId)).status,
        403,
      );
      assert.equal(
        (await execute(executor, owner, paths[3] + '&staffId=foreign-synthetic-staff')).status,
        403,
      );
      assert.equal(
        (await execute(executor, owner, '/api/workspace/availability?from=bad&to=bad')).status,
        400,
      );
    } finally {
      await executor.close();
      storage.close();
    }
  },
);

test(
  'real isolated HTTP keeps all five new reads bound to fresh browser context and membership',
  { timeout: 90000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t, { organizations: 2 }),
      [owner, foreign] = f.actors;
    const invitation = f.platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role: 'cosmetologist',
    });
    const accepted = await f.platform.acceptInvitation({
      token: invitation.token,
      email: 'read131@synthetic.test',
      password: 'Synthetic-calendar-read131-password',
      displayName: 'Synthetic employee',
    });
    const login = await f.platform.login(
      'read131@synthetic.test',
      'Synthetic-calendar-read131-password',
    );
    const employee = { ...accepted, token: login.token };
    const server = await createIsolatedServer(f.config);
    let database;
    try {
      const base = await listen(server);
      for (const url of paths) {
        assert.equal((await httpResult(base, owner, url)).status, 200, url);
        assert.equal((await httpResult(base, employee, url)).status, 200, url);
        const stale = await httpResult(base, owner, url, { cookie: headers(foreign).cookie });
        assert.equal(stale.status, 428);
        assert.equal(stale.body.code, 'AUTH_CONTEXT_CHANGED');
        assert.doesNotMatch(JSON.stringify(stale.body), /Synthetic|staffRules|rooms|groups/);
        const missing = await fetch(base + url, { headers: { cookie: headers(owner).cookie } });
        assert.equal(missing.status, 428, url);
        assert.equal((await fetch(base + url)).status, 401, url);
      }
      assert.equal(
        (await httpResult(base, owner, paths[3] + '&staffId=' + foreign.accountId)).status,
        403,
      );
      assert.equal(
        (await httpResult(base, employee, paths[3] + '&staffId=' + owner.accountId)).status,
        403,
      );
      f.platform.updateMembership({
        organizationId: owner.organizationId,
        actorId: owner.accountId,
        accountId: employee.accountId,
        role: 'cosmetologist',
        status: 'suspended',
      });
      for (const url of paths)
        assert.equal((await httpResult(base, employee, url)).status, 401, url);
      database = new DatabaseSync(path.join(f.directory, 'platform', 'platform.sqlite'));
      database.prepare('UPDATE accounts SET global_admin=1 WHERE id=?').run(owner.accountId);
      try {
        for (const url of paths)
          assert.equal((await httpResult(base, owner, url)).status, 403, url);
      } finally {
        database.prepare('UPDATE accounts SET global_admin=0 WHERE id=?').run(owner.accountId);
      }
      assert.equal(server.isolationStatus().queries.limits.concurrency, 2);
    } finally {
      database?.close();
      await close(server);
    }
  },
);

test(
  'a held real workspace read worker leaves public static and the second real reader responsive',
  { timeout: 60000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t),
      owner = f.actors[0];
    const control = new Int32Array(new SharedArrayBuffer(4));
    const server = await createIsolatedServer(f.config, {
      createExecutor(options) {
        return createNativeExecutor({
          ...options,
          workerFactory(filename, workerOptions) {
            return new Worker(path.join(__dirname, 'helpers/native-calendar-wait131.cjs'), {
              ...workerOptions,
              workerData: {
                ...workerOptions.workerData,
                syntheticReadWait: control.buffer,
                syntheticReadWorker: filename,
              },
            });
          },
        });
      },
    });
    let pending;
    try {
      const base = await listen(server);
      pending = httpResult(base, owner, paths[2]);
      void pending.catch(() => {});
      const until = performance.now() + 10000;
      while (Atomics.load(control, 0) !== 1) {
        if (performance.now() >= until)
          throw Error('Actual query worker did not enter the fixture barrier');
        await turn();
      }
      const [page, second] = await Promise.all([
        fetch(base + '/login.html'),
        httpResult(base, owner, paths[0]),
      ]);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).length > 0);
      assert.equal(second.status, 200);
      assert.equal(Atomics.load(control, 0), 1, 'The first physical worker is still held');
      assert.equal(server.isolationStatus().queries.active, 1);
      Atomics.store(control, 0, 2);
      Atomics.notify(control, 0);
      assert.equal((await pending).status, 200);
    } finally {
      Atomics.store(control, 0, 2);
      Atomics.notify(control, 0);
      if (pending) await pending.catch(() => {});
      await close(server);
    }
  },
);
