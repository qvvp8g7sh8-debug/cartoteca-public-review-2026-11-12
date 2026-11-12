const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  technicalReadiness,
  attachPostgresReadiness,
  readPostgresReadiness,
} = require('../src/server/infrastructure/postgres/readiness.cjs');
function status() {
  return {
    closeState: 'open',
    owner: {
      state: 'ready',
      application: { pid: 1001, ready: true, exited: false },
      background: { pid: 1002, ready: true, exited: false },
    },
    queries: { closed: false, readyWorkers: 2, limits: { concurrency: 2 } },
  };
}
test('server technical probe rejects payment and malformed saving policy before any SQL or asset access', async () => {
  const { postgresReadiness } = require('../scripts/postgres-readiness.cjs');
  const options = {
    storageBackend: 'postgres',
    postgresProfile: 'production-v1',
    postgresAllowedHosts: ['127.0.0.1'],
    postgres: {
      host: '127.0.0.1',
      port: 5432,
      database: 'synthetic',
      user: 'synthetic_app',
      password: 'synthetic',
    },
    production: true,
    origin: 'https://synthetic.example',
    dataDir: 'absent-synthetic-profile',
  };
  for (const patch of [{ paymentNetworkEnabled: true }, { assistantAppointmentSavingEnabled: '1' }])
    await assert.rejects(
      postgresReadiness({ ...options, ...patch }, {}),
      /POSTGRES_SERVER_POLICY_REQUIRED/,
    );
});
test('voice execution readiness retains only exact prepared version1 and disables effective execution in the release gate', () => {
  const { assistantSavingPolicy } = require('../scripts/postgres-readiness.cjs');
  const config = {
    paymentNetworkEnabled: false,
    assistantAppointmentSavingEnabled: true,
    notificationSchema: 19,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    sharedCabinetWrites: true,
    isolatedReadBudgets: true,
    releaseGate: false,
  };
  assert.deepEqual(assistantSavingPolicy(config), { version: 1, configured: true, enabled: true });
  assert.deepEqual(assistantSavingPolicy({ ...config, releaseGate: true }), {
    version: 1,
    configured: true,
    enabled: false,
  });
  assert.deepEqual(
    assistantSavingPolicy({
      ...config,
      assistantAppointmentSavingEnabled: false,
      notificationSchema: 11,
    }),
    {
      version: 0,
      configured: false,
      enabled: false,
    },
  );
  for (const patch of [
    { notificationSchema: 17 },
    { readBudgetVersion: 0 },
    { bookingLinksVersion: 0 },
    { sharedCabinetWrites: false },
    { isolatedReadBudgets: false },
    { assistantAppointmentSavingEnabled: 1 },
    { paymentNetworkEnabled: true },
  ])
    assert.throws(() => assistantSavingPolicy({ ...config, ...patch }), /POLICY_REQUIRED/);
});
test('voice execution technical authority proof checks only the exact current database and role session lock', async () => {
  const { assistantAuthorityProof } = require('../scripts/postgres-readiness.cjs');
  const marker = { platformStoreId: randomUUID() };
  let holders = 1;
  const client = {
    async query(text, values) {
      assert.match(text, /pg_locks/);
      assert.match(text, /current_database\(\)/);
      assert.match(text, /a.usename=current_user/);
      assert.match(text, /cartoteca-assistant-authority/);
      assert.equal(values.length, 2);
      assert.ok(values.every((value) => /^\d+$/.test(value)));
      return { rows: [{ holders }] };
    },
  };
  assert.deepEqual(await assistantAuthorityProof(client, marker, { enabled: true }), {
    required: true,
    owned: true,
    holders: 1,
  });
  for (holders of [0, 2, '1', null])
    await assert.rejects(
      assistantAuthorityProof(client, marker, { enabled: true }),
      /AUTHORITY_UNCONFIRMED/,
    );
  holders = 0;
  assert.deepEqual(await assistantAuthorityProof(client, marker, { enabled: false }), {
    required: false,
    owned: false,
    holders: 0,
  });
  holders = 1;
  await assert.rejects(
    assistantAuthorityProof(client, marker, { enabled: false }),
    /AUTHORITY_UNCONFIRMED/,
  );
});
test('technical readiness requires every live child and every initialized query executor, with closed technical output', () => {
  const good = status(),
    proof = technicalReadiness(good);
  assert.equal(proof.ready, true);
  assert.deepEqual(Object.keys(proof).sort(), [
    'backend',
    'children',
    'gateway',
    'profileMatches',
    'queries',
    'ready',
    'version',
  ]);
  assert.equal(JSON.stringify(proof).includes('1001'), false);
  for (const change of [
    undefined,
    {},
    { ...good, closeState: 'closed' },
    { ...good, owner: { ...good.owner, state: 'failed' } },
    { ...good, owner: { ...good.owner, background: { pid: 1002, ready: true, exited: true } } },
    { ...good, queries: { ...good.queries, readyWorkers: 1 } },
    { ...good, queries: { ...good.queries, closed: true } },
    { ...good, queries: { ...good.queries, limits: { concurrency: 0 } } },
  ])
    assert.equal(technicalReadiness(change).ready, false);
});
test(
  'private live socket binds its marker and closes with its owner without exposing identities',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ready123-'));
    const socketPath = path.join(directory, 'ready.sock'),
      markerFile = path.join(directory, 'postgresql-runtime.json');
    const platformStoreId = randomUUID(),
      rootCabinetStoreId = randomUUID();
    const marker = {
      version: 1,
      backend: 'postgres',
      migrationId: randomUUID(),
      platformStoreId,
      rootCabinetStoreId,
      cabinetTemplates: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
      budgetStoreId: null,
      notificationSchema: 11,
      cabinetSchema: 1,
      stores: [
        {
          kind: 'platform',
          storeId: platformStoreId,
          relativeDirectory: 'platform',
          organizationId: null,
          schemaVersion: 11,
        },
        {
          kind: 'cabinet',
          storeId: rootCabinetStoreId,
          relativeDirectory: '.',
          organizationId: null,
          schemaVersion: 1,
        },
      ],
    };
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    let current = status();
    const server = new EventEmitter();
    server.isolationStatus = () => current;
    const control = await attachPostgresReadiness(server, { socketPath, dataDir: directory });
    t.after(async () => {
      await control.close();
      assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    assert.equal(fs.lstatSync(socketPath).mode & 0o777, 0o600);
    const read = (markerHash) => readPostgresReadiness({ socketPath, markerHash });
    const ready = await read(digest(marker));
    assert.equal(ready.ready, true);
    assert.equal(JSON.stringify(ready).includes(platformStoreId), false);
    assert.equal(JSON.stringify(ready).includes(digest(marker)), false);
    assert.equal((await read('c'.repeat(64))).profileMatches, false);
    current = { ...current, queries: { ...current.queries, readyWorkers: 1 } };
    assert.equal((await read(digest(marker))).ready, false);
    current = status();
    fs.writeFileSync(markerFile, JSON.stringify({ ...marker, migrationId: randomUUID() }));
    assert.equal((await read(digest(marker))).profileMatches, false);
    await assert.rejects(
      attachPostgresReadiness(server, { socketPath, dataDir: directory }),
      /SOCKET_EXISTS/,
    );
    server.emit('close');
    await control.close();
    assert.equal(fs.existsSync(socketPath), false);
    await assert.rejects(read(digest(marker)));
  },
);
