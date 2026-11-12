const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const {
  createAppointmentStateReader,
} = require('../src/server/modules/notifications/appointment-state-reader.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { editable } = require('../src/server/modules/cabinet/changes.cjs');
const {
  createNotificationChannelState,
} = require('../src/server/modules/notifications/channel-state.cjs');
const queryRoutes = [
  ...require('../src/server/modules/cabinet/queries.cjs').routes,
  ...require('../src/server/modules/cabinet/routes.cjs').routes,
];
function runtime(timestamp = Date.now()) {
  const provider = { configured: false, connected: false, botId: '' };
  return {
    telegram: { ...provider, username: '', error: '' },
    providers: { telegram: { ...provider }, max: { ...provider } },
    timestamp,
  };
}
function headers(actor, extra = {}) {
  return {
    cookie: 'cartoteca_v2_session=' + actor.token,
    'x-cartoteca-account-id': actor.accountId,
    'x-cartoteca-organization-id': actor.organizationId,
    ...extra,
  };
}
async function execute(executor, actor, url, extra = {}) {
  const result = await executor.run({
    kind: 'query',
    payload: Buffer.alloc(0),
    metadata: {
      method: 'GET',
      url,
      headers: { host: '127.0.0.1:4174', ...headers(actor), ...extra.headers },
      localPort: 4174,
      remoteAddress: '127.0.0.1',
      runtime: runtime(),
      ...extra,
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
async function httpResult(base, actor, url, options = {}) {
  const requestHeaders = new Headers(headers(actor));
  // Header names are case-insensitive. Replacing Cookie must replace the
  // browser's single session, not append a second cookie for another account.
  for (const [name, value] of new Headers(options.headers)) requestHeaders.set(name, value);
  const res = await fetch(base + url, {
    ...options,
    headers: requestHeaders,
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test(
  'closed native query worker reuses actual prepared notification readers and fresh role filters',
  { timeout: 60000 },
  async (t) => {
    const f = await staffMaxFixture(t),
      actor = f.users[0];
    const storage = createStorage(path.join(f.source, 'tenants', actor.organizationId));
    const patient = (id, staffId) => ({
      id,
      name: 'Synthetic ' + id,
      phone: '+79990000000',
      createdBy: staffId,
      visits: [],
      appointments: [
        {
          id: 'appointment-' + id,
          staffId,
          date: '2035-01-02',
          time: '10:00',
          duration: 30,
          service: 'Synthetic service',
        },
      ],
    });
    storage.write({
      revision: 0,
      services: [],
      patients: [
        patient('owner-patient', actor.accountId),
        patient('staff-patient', f.users[2].accountId),
      ],
    });
    const channelFlags = { telegram: false, max: true, push: false };
    f.platform.notificationChannels = createNotificationChannelState(f.database, channelFlags);
    const issued = f.platform.maxLinks.issue(
      actor.organizationId,
      'owner-patient',
      actor.accountId,
      '123',
      () => {},
    );
    f.platform.maxLinks.consume(issued.token, '123', '456', () => {});
    const executor = createNativeExecutor({
      filename: path.resolve(__dirname, '../src/server/infrastructure/native-query-worker.cjs'),
      workerData: {
        config: {
          dataDir: f.source,
          notificationSchema: 16,
          commonNotificationsEnabled: true,
          notificationChannels: channelFlags,
        },
      },
    });
    try {
      await executor.ready();
      const providers = Object.fromEntries(
        ['telegram', 'max'].map((channel) => [
          channel,
          { status: () => runtime().providers[channel] },
        ]),
      );
      const tenantStore = (org) => {
        assert.equal(org, actor.organizationId);
        return storage;
      };
      const coordinator = createNotificationCoordinator({
        platform: f.platform,
        tenantStore,
        store: f.platform.notificationStore,
        links: f.platform.maxLinks,
        providers,
      });
      const decorate = createAppointmentStateReader({
        platform: f.platform,
        store: f.platform.telegram,
        tenantStore,
        coordinator,
      });
      const current = f.platform.session(actor.token);
      const paths = [
        '/api/cabinet/bootstrap?paged=1',
        '/api/cabinet/directory?q=Synthetic',
        '/api/cabinet/patient?id=owner-patient',
        '/api/cabinet/calendar?from=2035-01-01&to=2035-01-07',
        '/api/cabinet/operation?id=synthetic-query-unknown&statusOnly=1',
      ];
      await t.test(
        'all five closed routes preserve real query/decorated response bodies',
        async () => {
          for (const url of paths) {
            let expected;
            const route = queryRoutes.find(
              (r) => r.method === 'GET' && r.path === new URL(url, 'http://local').pathname,
            );
            await route.handle({
              current,
              platform: f.platform,
              tenantStore,
              token: actor.token,
              req: {},
              res: {},
              url: new URL(url, 'http://127.0.0.1:4174'),
              appointmentState: { decorate },
              telegram: { status: () => runtime().telegram },
              assertCurrent() {
                assert.ok(f.platform.session(actor.token));
              },
              json(_res, status, body) {
                expected = { status, body: JSON.parse(JSON.stringify(body)) };
              },
            });
            const actual = await execute(executor, actor, url);
            assert.equal(actual.status, expected.status, url);
            assert.deepEqual(actual.body, expected.body, url);
            assert.equal(actual.headers['Cache-Control'], 'no-store');
            assert.equal(actual.headers['X-Cartoteca-Provider-Status'], 'current');
          }
        },
      );
      await t.test(
        'compact versions retain their current worker semantics and invalidate after a commit',
        async () => {
          const url =
            '/api/cabinet/calendar?compact=1&projection=overview&from=2035-01-01&to=2035-01-07&monthFrom=2035-01-01&monthTo=2035-01-31';
          const first = await execute(executor, actor, url);
          assert.equal(first.status, 200);
          const conditional =
            url +
            '&version=' +
            encodeURIComponent(first.body.version) +
            '&until=' +
            first.body.validUntil;
          assert.equal((await execute(executor, actor, conditional)).body.unchanged, true);
          const next = storage.read();
          next.patients[0].appointments[0].time = '11:00';
          storage.write(next);
          const changed = await execute(executor, actor, conditional);
          assert.equal(changed.status, 200);
          assert.equal(changed.body.unchanged, undefined);
          assert.notEqual(changed.body.version, first.body.version);
        },
      );
      await t.test(
        'real MAX binding honors exact ready identity and fresh persisted channel state',
        async () => {
          const ready = runtime();
          ready.providers.max = { configured: true, connected: true, botId: '123' };
          const providers = Object.fromEntries(
            ['telegram', 'max'].map((channel) => [
              channel,
              { status: () => ready.providers[channel] },
            ]),
          );
          const coordinator = createNotificationCoordinator({
            platform: f.platform,
            tenantStore,
            store: f.platform.notificationStore,
            links: f.platform.maxLinks,
            providers,
          });
          const expected = createAppointmentStateReader({
            platform: f.platform,
            store: f.platform.telegram,
            tenantStore,
            coordinator,
          })(storage.readSelected(['owner-patient']), actor.organizationId);
          const visible = await execute(executor, actor, paths[2], { runtime: ready });
          assert.equal(visible.status, 200);
          assert.deepEqual(visible.body, JSON.parse(JSON.stringify(expected)));
          assert.deepEqual(visible.body.patients[0].appointments[0].deliveryChannels, ['max']);
          for (const max of [
            { ...ready.providers.max, botId: '789' },
            { ...ready.providers.max, connected: false },
          ]) {
            const blocked = await execute(executor, actor, paths[2], {
              runtime: { ...ready, providers: { ...ready.providers, max } },
            });
            assert.deepEqual(blocked.body.patients[0].appointments[0].deliveryChannels, []);
          }
          createNotificationChannelState(f.database, { ...channelFlags, max: false });
          const disabled = await execute(executor, actor, paths[2], { runtime: ready });
          assert.deepEqual(
            disabled.body.patients[0].appointments[0].deliveryChannels,
            [],
            'old UI readiness cannot enable a channel disabled in current database state',
          );
          createNotificationChannelState(f.database, channelFlags);
          assert.deepEqual(
            (await execute(executor, actor, paths[2], { runtime: ready })).body.patients[0]
              .appointments[0].deliveryChannels,
            ['max'],
          );
        },
      );
      await t.test(
        'last-known transport observation never blocks calendar reads while owner is busy',
        async () => {
          const observed = Date.now() - 60000;
          const result = await execute(executor, actor, paths[3], { runtime: runtime(observed) });
          assert.equal(result.status, 200);
          assert.equal(result.headers['X-Cartoteca-Provider-Status'], 'stale');
          assert.equal(result.headers['X-Cartoteca-Provider-Observed-At'], String(observed));
          assert.ok(result.body.appointments.length);
          for (const invalid of [null, runtime(Date.now() + 60000)])
            assert.equal(
              (await execute(executor, actor, paths[3], { runtime: invalid })).status,
              503,
            );
        },
      );
      await t.test(
        'real staff session sees its own card only and revoked sessions are not cached',
        async () => {
          const employee = f.users[2];
          assert.equal(
            (await execute(executor, employee, '/api/cabinet/patient?id=staff-patient')).status,
            200,
          );
          assert.equal(
            (await execute(executor, employee, '/api/cabinet/patient?id=owner-patient')).status,
            404,
          );
          const calendar = await execute(executor, employee, paths[3]);
          assert.deepEqual(
            calendar.body.appointments.map((a) => a.staffId),
            [employee.accountId],
          );
          f.platform.updateMembership({
            organizationId: actor.organizationId,
            actorId: actor.accountId,
            accountId: employee.accountId,
            role: 'cosmetologist',
            status: 'suspended',
          });
          for (const url of paths)
            assert.equal((await execute(executor, employee, url)).status, 401);
        },
      );
      await t.test(
        'malformed host, calendar range and missing context keep their actual HTTP errors',
        async () => {
          const rejected = await execute(executor, actor, paths[0], {
            headers: { host: 'evil.invalid', ...headers(actor) },
          });
          assert.equal(rejected.status, 403);
          const missing = await execute(executor, actor, paths[0], {
            headers: { host: '127.0.0.1:4174', cookie: headers(actor).cookie },
          });
          assert.equal(missing.status, 428);
          assert.equal(missing.body.code, 'AUTH_CONTEXT_CHANGED');
          assert.equal(
            (await execute(executor, actor, '/api/cabinet/calendar?from=invalid&to=invalid'))
              .status,
            400,
          );
        },
      );
    } finally {
      await executor.close();
      storage.close();
    }
  },
);

test(
  'actual isolated HTTP keeps manual saves, same-ID recovery and account boundaries across all readers',
  { timeout: 90000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t, { organizations: 2 }),
      [owner, foreign] = f.actors;
    const invitation = f.platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role: 'cosmetologist',
    });
    const password = 'Synthetic-native-employee-password';
    const accepted = await f.platform.acceptInvitation({
      token: invitation.token,
      email: 'native-worker@synthetic.test',
      displayName: 'Synthetic employee',
      password,
    });
    const login = await f.platform.login('native-worker@synthetic.test', password);
    const employee = { ...accepted, token: login.token };
    const cabinet = createStorage(path.join(f.directory, 'tenants', owner.organizationId));
    let before, seedRevision;
    try {
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
        () => cabinet.read(),
      );
      const state = cabinet.read();
      state.patients[0].createdBy = employee.accountId;
      state.patients[0].appointments.push({
        id: 'native-appointment',
        staffId: employee.accountId,
        roomId: 'main',
        date: '2035-01-02',
        time: '10:00',
        duration: 30,
        service: 'Synthetic service',
      });
      const seeded = cabinet.write(state);
      before = seeded.patients[0];
      seedRevision = seeded.revision;
    } finally {
      cabinet.close();
    }
    const server = await createIsolatedServer(f.config);
    let database;
    try {
      const base = await listen(server);
      const paths = [
        '/api/cabinet/bootstrap?paged=1',
        '/api/cabinet/directory',
        '/api/cabinet/patient?id=' + owner.patientId,
        '/api/cabinet/calendar?from=2035-01-01&to=2035-01-07',
        '/api/cabinet/operation?id=synthetic-http-unknown&statusOnly=1',
      ];
      await t.test(
        'five native reads and legacy write flow use the original public peer port',
        async () => {
          for (const url of paths)
            assert.equal((await httpResult(base, employee, url)).status, 200, url);
          assert.equal(
            (await httpResult(base, owner, '/api/cabinet/patient?id=' + foreign.patientId)).status,
            404,
          );
          const operation = randomUUID(),
            next = { ...before, notes: 'Synthetic manual correction' };
          const body = {
            revision: seedRevision,
            patients: [{ id: before.id, before, after: next }],
            services: [],
          };
          const options = {
            method: 'PATCH',
            body: JSON.stringify(body),
            headers: {
              'Content-Type': 'application/json',
              Origin: base,
              'X-Cartoteca-Request': '1',
              'X-Cartoteca-Operation': operation,
            },
          };
          const saved = await httpResult(base, owner, '/api/cabinet/changes', options);
          assert.equal(saved.status, 200, JSON.stringify(saved.body));
          const replay = await httpResult(base, owner, '/api/cabinet/changes', options);
          assert.equal(replay.status, 200);
          assert.equal(replay.body.revision, saved.body.revision);
          assert.deepEqual(editable(replay.body), editable(saved.body));
          const proof = await httpResult(
            base,
            owner,
            '/api/cabinet/operation?statusOnly=1&id=' + operation,
          );
          assert.equal(proof.status, 200);
          assert.equal(proof.body.status, 'committed');
          assert.equal(proof.body.revision, saved.body.revision);
          const recovered = await httpResult(base, owner, '/api/cabinet/operation?id=' + operation);
          assert.equal(recovered.body.status, 'committed');
          assert.equal(recovered.body.result.patients[0].notes, next.notes);
          assert.deepEqual(
            (await httpResult(base, foreign, '/api/cabinet/operation?statusOnly=1&id=' + operation))
              .body,
            { status: 'unknown' },
          );
          const fresh = await httpResult(base, owner, '/api/cabinet/patient?id=' + owner.patientId);
          assert.equal(fresh.body.patients[0].notes, next.notes);
          assert.equal(server.isolationStatus().queries.limits.concurrency, 2);
        },
      );
      await t.test(
        'parallel browser account contexts cannot cross shared cookie identity',
        async () => {
          const results = await Promise.all(
            paths.map((url) =>
              httpResult(base, owner, url, {
                headers: { Cookie: headers(foreign).cookie },
              }),
            ),
          );
          for (const result of results) {
            assert.equal(result.status, 428);
            assert.equal(result.body.code, 'AUTH_CONTEXT_CHANGED');
            assert.doesNotMatch(JSON.stringify(result.body), /Synthetic Client|manual correction/);
          }
          assert.equal(
            (
              await httpResult(base, owner, '/api/cabinet/changes', {
                method: 'PATCH',
                body: '{}',
                headers: {
                  Cookie: headers(foreign).cookie,
                  'Content-Type': 'application/json',
                  Origin: base,
                  'X-Cartoteca-Request': '1',
                },
              })
            ).status,
            428,
          );
        },
      );
      await t.test(
        'fresh database revocation closes all five reads and manual writes',
        async () => {
          f.platform.updateMembership({
            organizationId: owner.organizationId,
            actorId: owner.accountId,
            accountId: employee.accountId,
            role: 'cosmetologist',
            status: 'suspended',
          });
          for (const url of paths)
            assert.equal((await httpResult(base, employee, url)).status, 401, url);
          assert.equal(
            (
              await httpResult(base, employee, '/api/cabinet/changes', {
                method: 'PATCH',
                body: '{}',
                headers: {
                  'Content-Type': 'application/json',
                  Origin: base,
                  'X-Cartoteca-Request': '1',
                },
              })
            ).status,
            401,
          );
        },
      );
      await t.test(
        'crafted global-admin membership never exposes clinical data but retains administration',
        async () => {
          database = new DatabaseSync(path.join(f.directory, 'platform', 'platform.sqlite'));
          database.prepare('UPDATE accounts SET global_admin=1 WHERE id=?').run(owner.accountId);
          try {
            for (const url of paths)
              assert.equal((await httpResult(base, owner, url)).status, 403, url);
            assert.equal((await httpResult(base, owner, '/api/cabinet')).status, 403);
            assert.equal((await httpResult(base, owner, '/api/admin/overview')).status, 200);
          } finally {
            database.prepare('UPDATE accounts SET global_admin=0 WHERE id=?').run(owner.accountId);
          }
        },
      );
    } finally {
      database?.close();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
