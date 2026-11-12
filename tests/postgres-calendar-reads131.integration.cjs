const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { readCabinetSnapshot } = require('../src/server/infrastructure/cabinet-read-snapshot.cjs');
const { createNativeQueryKernel } = require('../src/server/infrastructure/native-query-kernel.cjs');
const { readRuntime } = require('../src/server/infrastructure/postgres/runtime.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const day = '2035-01-02';
const urls = [
  '/api/cabinet/time-zone',
  '/api/work-schedules?from=' + day + '&to=' + day,
  '/api/workspace',
  '/api/workspace/availability?from=' + day + '&to=' + day,
  '/api/service-groups',
];
const routes = [
  ...require('../src/server/modules/cabinet/queries.cjs').routes,
  ...require('../src/server/modules/schedules/routes.cjs').routes,
  ...require('../src/server/modules/workspace/routes.cjs').routes,
  ...require('../src/server/modules/services/routes.cjs').routes,
];
async function nativeRead(kernel, actor, url, headers = {}) {
  const provider = { configured: false, connected: false, botId: '' };
  const result = await kernel.run({
    method: 'GET',
    url,
    localPort: 4174,
    remoteAddress: '127.0.0.1',
    runtime: {
      timestamp: Date.now(),
      telegram: { ...provider },
      providers: { telegram: { ...provider }, max: { ...provider } },
    },
    headers: {
      host: '127.0.0.1:4174',
      cookie: 'cartoteca_v2_session=' + actor.token,
      'x-cartoteca-account-id': actor.accountId,
      'x-cartoteca-organization-id': actor.organizationId,
      ...headers,
    },
  });
  return { status: result.status, body: JSON.parse(Buffer.from(result.body).toString('utf8')) };
}
async function sqliteRead(f, actor, url) {
  let result, storage;
  const request = new URL(url, 'http://127.0.0.1:4174');
  try {
    await routes
      .find((route) => route.method === 'GET' && route.path === request.pathname)
      .handle({
        url: request,
        current: f.platform.session(actor.token),
        token: actor.token,
        platform: f.platform,
        tenantStore(org) {
          assert.equal(org, actor.organizationId);
          storage ||= createStorage(path.join(f.directory, 'tenants', org));
          return storage;
        },
        json: (_res, status, body) => {
          result = { status, body: JSON.parse(JSON.stringify(body)) };
        },
      });
    return result;
  } finally {
    storage?.close();
  }
}
async function addRole(f, owner, role) {
  const email = role + '@calendar131.synthetic.test';
  const password = 'Synthetic-calendar131-password';
  const invitation = f.platform.createInvitation({
    organizationId: owner.organizationId,
    invitedBy: owner.accountId,
    role,
  });
  const user = await f.platform.acceptInvitation({
    token: invitation.token,
    email,
    password,
    displayName: 'Synthetic ' + role,
  });
  const login = await f.platform.login(email, password);
  return { ...user, token: login.token, organizationId: owner.organizationId };
}
function seedCalendar(f, owner, staff, index) {
  const storage = createStorage(path.join(f.directory, 'tenants', owner.organizationId));
  try {
    const zone = index ? 'Europe/Paris' : 'UTC';
    f.platform.updateOrganizationTimeZone(owner.token, { timeZone: zone });
    f.platform.createServiceGroup(owner.token, {
      revision: 0,
      title: 'Synthetic group ' + index,
      id: 'synthetic-group-' + index,
    });
    const workspace = f.platform.workspaceSettings(owner.organizationId);
    const specialists = staff ? [owner.accountId, staff.accountId] : [owner.accountId];
    f.platform.saveWorkspace(
      owner.organizationId,
      owner.accountId,
      {
        ...workspace,
        enabled: true,
        rooms: workspace.rooms.map((room) => ({
          ...room,
          name: 'Synthetic room ' + index,
          staffMode: staff ? 'multiple' : 'single',
          staffIds: specialists,
        })),
      },
      () => storage.read(),
    );
    for (const staffId of specialists)
      assert.equal(
        f.platform.workSchedules.save(
          owner.token,
          {
            staffId,
            revision: 0,
            expectedTimeZone: zone,
            dates: [day],
            status: 'working',
            intervals: [['08:00', '18:00']],
          },
          storage,
        ).saved,
        true,
      );
    const state = storage.read();
    state.patients[0].appointments = specialists.map((staffId, n) => ({
      id: 'synthetic-calendar131-' + index + '-' + n,
      staffId,
      roomId: 'main',
      date: day,
      time: index ? '14:00' : n ? '11:00' : '10:00',
      duration: 30,
      service: 'Synthetic',
    }));
    storage.write(state);
  } finally {
    storage.close();
  }
}

test(
  'actual PostgreSQL calendar GET projections preserve role bodies, fresh scope and read-only fences',
  { timeout: 180000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t, { organizations: 2 });
    const [owner, foreign] = f.actors;
    const salonAdmin = await addRole(f, owner, 'salon_admin');
    const staff = await addRole(f, owner, 'cosmetologist');
    seedCalendar(f, owner, staff, 0);
    seedCalendar(f, foreign, null, 1);
    const actors = [owner, salonAdmin, staff, foreign],
      expected = new Map();
    for (const actor of actors)
      for (const url of urls) expected.set(actor.accountId + url, await sqliteRead(f, actor, url));
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin);
    let queryOwner, storageOwner, kernel, storage;
    t.after(async () => {
      await kernel?.close();
      storage?.close();
      await queryOwner?.close();
      await storageOwner?.close();
      await admin.end();
      await runtime.close();
    });
    await admin.connect();
    const destination = path.join(runtime.root, 'assets');
    const imported = await migratePostgresData({
      source: f.directory,
      destination,
      client: admin,
      applicationRole: runtime.application.user,
      offline: true,
      dryRun: false,
    });
    assert.equal(imported.sourceUnchanged, true);
    const config = {
      ...f.config,
      dataDir: destination,
      storageBackend: 'postgres',
      postgres: runtime.application,
    };
    const queryOptions = await initializePostgresOwner(config);
    queryOwner = queryOptions.databaseOwner;
    kernel = createNativeQueryKernel(queryOptions);
    const storageOptions = await initializePostgresOwner(config);
    storageOwner = storageOptions.databaseOwner;
    storage = createStorage(path.join(destination, 'tenants', owner.organizationId), {
      databaseOwner: storageOwner,
      databaseRoot: destination,
      photoOrganizationId: owner.organizationId,
    });
    const expectedRevision = storage.get('revision', 0);
    assert.ok(expectedRevision > 0);
    const marker = readRuntime(destination);
    await admin.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [marker.platformStoreId],
    );

    await t.test(
      'all five actual native GET bodies equal existing SQLite handlers for owner, admin, staff and another tenant',
      async () => {
        for (const actor of actors)
          for (const url of urls)
            assert.deepEqual(
              await nativeRead(kernel, actor, url),
              expected.get(actor.accountId + url),
            );
        const staffWorkspace = (await nativeRead(kernel, staff, urls[2])).body;
        assert.deepEqual(staffWorkspace.members, []);
        assert.equal(staffWorkspace.canEdit, false);
        assert.equal(staffWorkspace.rooms[0].staffIds, undefined);
        const availability = (await nativeRead(kernel, staff, urls[3])).body;
        assert.deepEqual(availability.busy, [
          { roomId: 'main', date: day, time: '10:00', duration: 30 },
        ]);
        assert.notDeepEqual(
          (await nativeRead(kernel, owner, urls[4])).body,
          (await nativeRead(kernel, foreign, urls[4])).body,
        );
      },
    );
    await t.test(
      'cross-account tabs and foreign staff selectors cannot change the authorized organization',
      async () => {
        for (const url of urls) {
          const mismatch = await nativeRead(kernel, owner, url, {
            cookie: 'cartoteca_v2_session=' + foreign.token,
          });
          assert.equal(mismatch.status, 428);
          assert.equal(mismatch.body.code, 'AUTH_CONTEXT_CHANGED');
        }
        for (const actor of [owner, salonAdmin, staff])
          assert.equal(
            (await nativeRead(kernel, actor, urls[1] + '&staffId=' + foreign.accountId)).status,
            403,
          );
        assert.equal(
          (await nativeRead(kernel, staff, urls[1] + '&staffId=' + owner.accountId)).status,
          403,
        );
        assert.deepEqual(
          await nativeRead(kernel, owner, urls[2]),
          expected.get(owner.accountId + urls[2]),
        );
      },
    );
    await t.test(
      'pure cabinet reads and the five projections bypass policy/writer contention without allowing writes',
      async () => {
        await admin.query('SELECT pg_advisory_lock($1::bigint),pg_advisory_lock($2::bigint)', [
          KEYS.policy,
          KEYS.writer,
        ]);
        try {
          assert.equal(
            readCabinetSnapshot(storage, () => storage.get('revision', 0)),
            expectedRevision,
          );
          for (const url of urls)
            assert.deepEqual(
              await nativeRead(kernel, staff, url),
              expected.get(staff.accountId + url),
            );
          assert.throws(
            () => readCabinetSnapshot(storage, () => storage.set('synthetic-readonly131', true)),
            (error) => error.code === 'POSTGRES_QUERY_ONLY',
          );
          assert.equal(storage.db.isTransaction, false);
          assert.equal(
            readCabinetSnapshot(storage, () => storage.get('synthetic-readonly131', false)),
            false,
          );
        } finally {
          await admin.query('SELECT pg_advisory_unlock_all()');
        }
      },
    );
    await t.test(
      'maintenance remains exclusive and failed admission leaves the helper usable',
      async () => {
        await admin.query('SELECT pg_advisory_lock($1::bigint)', [KEYS.maintenance]);
        try {
          assert.throws(
            () => readCabinetSnapshot(storage, () => storage.get('revision', 0)),
            (error) =>
              error.status === 503 &&
              error.postgresCode === 'POSTGRES_BUSY' &&
              error.transactionOpen === false &&
              error.retryableBeforeBegin === true &&
              !error.channelPoisoned,
          );
          assert.equal(storage.db.isTransaction, false);
        } finally {
          await admin.query('SELECT pg_advisory_unlock_all()');
        }
        assert.equal(
          readCabinetSnapshot(storage, () => storage.get('revision', 0)),
          expectedRevision,
        );
        assert.deepEqual(
          await nativeRead(kernel, owner, urls[0]),
          expected.get(owner.accountId + urls[0]),
        );
      },
    );
    await t.test(
      'warm GET projections observe staff revocation on every route and restore only active authority',
      async () => {
        await admin.query(
          "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
          [marker.platformStoreId, owner.organizationId, staff.accountId],
        );
        try {
          for (const url of urls) assert.equal((await nativeRead(kernel, staff, url)).status, 401);
          assert.equal((await nativeRead(kernel, foreign, urls[2])).status, 200);
        } finally {
          await admin.query(
            "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
            [marker.platformStoreId, owner.organizationId, staff.accountId],
          );
        }
        for (const url of urls)
          assert.deepEqual(
            await nativeRead(kernel, staff, url),
            expected.get(staff.accountId + url),
          );
      },
    );
  },
);
