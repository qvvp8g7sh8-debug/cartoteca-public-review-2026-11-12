const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertServerProof,
  serverStages: stages,
} = require('../scripts/release/publication-check.cjs');
const request = { imageId: 'sha256:' + 'a'.repeat(64), imageHash: 'b'.repeat(64) };
const config = { schema: 17 };

test('PostgreSQL acceptance requires native RLS, asset identity, all live executors and actual native backup drills', () => {
  const expected = {
    schema: 19,
    storageBackend: 'postgres',
    postgresProfile: 'production-v1',
    paymentNetworkEnabled: false,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
  };
  const readiness = {
    version: 1,
    backend: 'postgres',
    profile: 'production-v1',
    ready: true,
    schema: 19,
    nativeSchema: true,
    rls: true,
    assetLineage: true,
    preparedModes: true,
    stores: 3,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    sharedCabinetWrites: true,
    paymentNetworkEnabled: false,
    assistantAppointmentSavingEnabled: false,
    executors: {
      version: 1,
      backend: 'postgres',
      ready: true,
      profileMatches: true,
      gateway: { open: true },
      children: { web: true, background: true },
      queries: { configured: 2, ready: 2, closed: false },
    },
  };
  const backup = {
    backend: 'postgres',
    verified: true,
    state: 'local_only',
    drill: { backend: 'postgres', restored: true, started: true, notificationsPaused: true },
  };
  const server = {
    ...proof(),
    schema: 19,
    storageBackend: 'postgres',
    postgresProfile: 'production-v1',
    postgresReadiness: readiness,
    backupBefore: backup,
    backupAfter: backup,
    pushEnabled: false,
  };
  assert.doesNotThrow(() => assertServerProof(server, expected, request));
  assert.throws(() => assertServerProof(server, { schema: 19 }, request));
  for (const patch of [
    { rls: false },
    { nativeSchema: false },
    { assetLineage: false },
    { preparedModes: false },
    { schema: 17 },
    { bookingLinksVersion: 0 },
    { paymentNetworkEnabled: true },
    { assistantAppointmentSavingEnabled: true },
    { executors: { ...readiness.executors, profileMatches: false } },
    { executors: { ...readiness.executors, children: { web: true, background: false } } },
    { executors: { ...readiness.executors, queries: { configured: 2, ready: 1, closed: false } } },
  ])
    assert.throws(() =>
      assertServerProof(
        { ...server, postgresReadiness: { ...readiness, ...patch } },
        expected,
        request,
      ),
    );
  for (const change of [
    undefined,
    { state: 'local_only' },
    { ...backup, backend: 'sqlite' },
    { ...backup, verified: false },
    { ...backup, drill: { ...backup.drill, started: false } },
  ])
    for (const key of ['backupBefore', 'backupAfter'])
      assert.throws(() => assertServerProof({ ...server, [key]: change }, expected, request));
});
test('PostgreSQL version1 voice execution requires exact active policy and actual unique authority evidence', () => {
  const {
    assertPostgresConfiguration,
    assertPostgresReadiness,
  } = require('../scripts/release/postgres-proof.cjs');
  const config = {
    storageBackend: 'postgres',
    postgresProfile: 'production-v1',
    schema: 19,
    paymentNetworkEnabled: false,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    assistantSavingVersion: 1,
  };
  const value = {
    version: 1,
    backend: 'postgres',
    profile: 'production-v1',
    ready: true,
    schema: 19,
    nativeSchema: true,
    rls: true,
    assetLineage: true,
    preparedModes: true,
    stores: 3,
    paymentNetworkEnabled: false,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    sharedCabinetWrites: true,
    assistantSavingVersion: 1,
    assistantAppointmentSavingConfigured: true,
    assistantAppointmentSavingEnabled: true,
    releaseGate: false,
    assistantAuthority: { required: true, owned: true, holders: 1 },
    executors: {
      version: 1,
      backend: 'postgres',
      ready: true,
      profileMatches: true,
      gateway: { open: true },
      children: { web: true, background: true },
      queries: { configured: 2, ready: 2, closed: false },
    },
  };
  assert.doesNotThrow(() => assertPostgresConfiguration(config));
  assert.doesNotThrow(() => assertPostgresReadiness(value, config));
  for (const patch of [
    { assistantSavingVersion: undefined },
    { assistantSavingVersion: '1' },
    { assistantAppointmentSavingConfigured: false },
    { assistantAppointmentSavingEnabled: false },
    { releaseGate: true },
    { releaseGate: undefined },
    { assistantAuthority: undefined },
    { assistantAuthority: { required: true, owned: false, holders: 0 } },
    { assistantAuthority: { required: true, owned: true, holders: 2 } },
    { assistantAuthority: { required: false, owned: true, holders: 1 } },
  ])
    assert.throws(() => assertPostgresReadiness({ ...value, ...patch }, config));
  assert.throws(() =>
    assertPostgresReadiness(value, { ...config, assistantSavingVersion: undefined }),
  );
  for (const patch of [
    { schema: 17 },
    { schema: 20 },
    { assistantSavingVersion: true },
    { readBudgetVersion: undefined },
    { bookingLinksVersion: undefined },
  ])
    assert.throws(() => assertPostgresConfiguration({ ...config, ...patch }));
});

test('short-links acceptance requires the pinned live component and preserves read-budget proof', () => {
  const expected = { schema: 17, readBudgetVersion: 1, bookingLinksVersion: 1 };
  const server = {
    ...proof(),
    sharedCabinetWrites: true,
    isolatedReadBudgets: true,
    readBudgetVersion: '1',
    public: { ...proof().public, readBudgetVersion: 1, bookingLinksVersion: 1 },
  };
  assert.doesNotThrow(() => assertServerProof(server, expected, request));
  for (const bookingLinksVersion of [undefined, null, 0, 2, '1']) {
    assert.throws(() =>
      assertServerProof(
        { ...server, public: { ...server.public, bookingLinksVersion } },
        expected,
        request,
      ),
    );
  }
  assert.throws(() =>
    assertServerProof({ ...server, isolatedReadBudgets: false }, expected, request),
  );
});
test('read-budget publication requires enabled flags, exact version and checked live storage', () => {
  const expected = { schema: 17, readBudgetVersion: 1 };
  const server = {
    ...proof(),
    sharedCabinetWrites: true,
    isolatedReadBudgets: true,
    readBudgetVersion: '1',
    public: { ...proof().public, readBudgetVersion: 1 },
  };
  assert.doesNotThrow(() => assertServerProof(server, expected, request));
  for (const patch of [
    { sharedCabinetWrites: false },
    { isolatedReadBudgets: false },
    { readBudgetVersion: undefined },
    { readBudgetVersion: '2' },
    { public: proof().public },
  ])
    assert.throws(() => assertServerProof({ ...server, ...patch }, expected, request));
});
test('structural acceptance requires schema2 and active scheduler in addition to push', () => {
  const server = {
    ...proof(),
    schema: 18,
    maxSchema: '18',
    cabinetSchema: '2',
    scheduledNotifications: true,
  };
  assert.doesNotThrow(() => assertServerProof(server, { schema: 18 }, request));
  for (const change of [
    { cabinetSchema: '1' },
    { scheduledNotifications: false },
    { maxSchema: '17' },
    { pushEnabled: false },
  ])
    assert.throws(() => assertServerProof({ ...server, ...change }, { schema: 18 }, request));
});
function proof() {
  return {
    build: '0123456789abcdef',
    schema: 17,
    status: 'completed',
    published: true,
    running: true,
    restarts: 0,
    oom: false,
    timer: 'active',
    gateEnabled: false,
    pushEnabled: true,
    maxSchema: '17',
    image: request.imageId,
    public: { passed: true, actualImage: request.imageId },
    stages: stages.map((stage) => ({ stage, status: 'passed' })),
  };
}

test('housekeeping warning does not invalidate publication; backup failures remain blocking', () => {
  const server = proof();
  server.stages.push({ stage: 'storage-maintenance', status: 'failed' });
  assert.throws(() => assertServerProof(server, config, request));
  server.maintenanceError = 'STORAGE_MAINTENANCE_FAILED';
  assert.doesNotThrow(() => assertServerProof(server, config, request));
  server.stages.push({ stage: 'backup-after', status: 'failed' });
  assert.throws(() => assertServerProof(server, config, request));
});
test('acceptance binds a completed release to its checked image and all delivery stages', () => {
  assert.doesNotThrow(() => assertServerProof(proof(), config, request));
  for (const change of [
    { published: false },
    { running: false },
    { restarts: 1 },
    { oom: true },
    { timer: 'inactive' },
    { gateEnabled: true },
    { schema: 16 },
    { pushEnabled: false },
    { maxSchema: '16' },
    { build: 'foreign' },
    { image: 'sha256:' + 'c'.repeat(64) },
    { public: { passed: false } },
    { stages: stages.slice(1).map((stage) => ({ stage, status: 'passed' })) },
  ])
    assert.throws(() => assertServerProof({ ...proof(), ...change }, config, request));
});
test('classic/containerd identities require a matching immutable archive proof', () => {
  const server = proof(),
    targetId = 'sha256:' + 'c'.repeat(64);
  server.target = { requestedId: request.imageId, targetId, imageHash: request.imageHash };
  server.image = targetId;
  server.public.actualImage = targetId;
  assert.doesNotThrow(() => assertServerProof(server, config, request));
  for (const changed of [
    { requestedId: 'sha256:' + 'd'.repeat(64) },
    { imageHash: 'e'.repeat(64) },
    { targetId: 'invalid' },
  ])
    assert.throws(() =>
      assertServerProof({ ...server, target: { ...server.target, ...changed } }, config, request),
    );
});
test('acceptance uses the final result of a repeated stage while retaining its failed attempt', () => {
  const server = proof();
  server.stages.unshift({ stage: 'preflight', status: 'failed' });
  assert.doesNotThrow(() => assertServerProof(server, config, request));
  server.stages.push({ stage: 'backup-after', status: 'failed' });
  assert.throws(() => assertServerProof(server, config, request));
});
test('migration acceptance requires every additional gated stage', () => {
  const required = [...stages, 'migration-activate'];
  assert.throws(() => assertServerProof(proof(), config, request, required));
  const server = proof();
  server.stages.push({ stage: 'migration-activate', status: 'passed' });
  assert.doesNotThrow(() => assertServerProof(server, config, request, required));
});

test('ordinary gated release acceptance requires committed activation and both phase checks', () => {
  const expected = { schema: 17, publicationGate: true };
  const server = proof();
  assert.throws(() => assertServerProof(server, expected, request));
  server.activationCommitted = true;
  server.publicationPrepared = true;
  server.publicationCommitted = true;
  server.gatedPublic = {
    passed: true,
    gated: true,
    actualImage: server.image,
    build: server.build,
  };
  server.public.gated = false;
  server.stages.push({ stage: 'publication-activate', status: 'passed' });
  server.stages.push({ stage: 'public-checks-activated', status: 'passed' });
  assert.doesNotThrow(() => assertServerProof(server, expected, request));
  for (const marker of [undefined, false, 1, 'true'])
    assert.throws(() =>
      assertServerProof({ ...server, activationCommitted: marker }, expected, request),
    );
  for (const name of ['publicationPrepared', 'publicationCommitted'])
    for (const marker of [undefined, false, 1, 'true'])
      assert.throws(() => assertServerProof({ ...server, [name]: marker }, expected, request));
  for (const patch of [
    { passed: false },
    { gated: false },
    { actualImage: request.imageId + 'other' },
    { build: 'old-build' },
  ])
    assert.throws(() =>
      assertServerProof(
        { ...server, gatedPublic: { ...server.gatedPublic, ...patch } },
        expected,
        request,
      ),
    );
  for (const missing of ['public-checks', 'publication-activate', 'public-checks-activated'])
    assert.throws(() =>
      assertServerProof(
        { ...server, stages: server.stages.filter((item) => item.stage !== missing) },
        expected,
        request,
      ),
    );
  assert.throws(() => assertServerProof({ ...server, gateEnabled: true }, expected, request));
});

test('paid-services19 independent acceptance requires hardOFF, preserved components and durable gated migration', () => {
  const config = {
      schema: 19,
      migration: 'paid-services-17-to-19',
      readBudgetVersion: 1,
      bookingLinksVersion: 1,
      paymentNetworkEnabled: false,
    },
    paidServices = {
      paymentNetworkEnabled: false,
      platformOnly: true,
      componentsPreserved: true,
      cabinetSchemaUnchanged: true,
      scheduleModeUnchanged: true,
    };
  const server = {
    ...proof(),
    schema: 19,
    maxSchema: '19',
    sharedCabinetWrites: true,
    isolatedReadBudgets: true,
    readBudgetVersion: '1',
    paymentNetworkFlag: '0',
    paidServicesRuntime: { paymentNetworkEnabled: false },
    migrationCommitted: true,
    migrationPrepared: true,
    migrationDurableCommitted: true,
    gatedPublic: { gated: true, paidServices },
    public: { ...proof().public, readBudgetVersion: 1, bookingLinksVersion: 1, paidServices },
  };
  assert.doesNotThrow(() => assertServerProof(server, config, request));
  for (const change of [
    { paymentNetworkFlag: '1' },
    { paidServicesRuntime: { paymentNetworkEnabled: true } },
    { migrationCommitted: false },
    { migrationPrepared: false },
    { migrationDurableCommitted: false },
    { gatedPublic: { gated: false, paidServices } },
    {
      public: {
        ...server.public,
        paidServices: { ...paidServices, cabinetSchemaUnchanged: false },
      },
    },
  ])
    assert.throws(() => assertServerProof({ ...server, ...change }, config, request));
});
