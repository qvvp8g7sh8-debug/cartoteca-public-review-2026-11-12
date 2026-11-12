const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  configuration,
  serverConfiguration,
  runtimeFiles,
  assertMigrationStand,
} = require('../scripts/release/deployment-plan.cjs');
const { follow } = require('../scripts/release/deployment.cjs');
const { quote } = require('../scripts/release/deployment-transport.cjs');
const { copySnapshot, allowed } = require('../scripts/release/files.cjs');
const { options } = require('../scripts/release.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-deploy-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const identityFile = path.join(directory, 'synthetic-key'),
    knownHostsFile = path.join(directory, 'synthetic-hosts');
  fs.writeFileSync(identityFile, 'SYNTHETIC_NOT_A_REAL_KEY');
  fs.writeFileSync(knownHostsFile, 'SYNTHETIC_HOST');
  const value = {
    host: 'example.invalid',
    user: 'root',
    port: 22,
    identityFile,
    knownHostsFile,
    root: '/opt/cartoteca-v2',
    releaseRoot: '/opt/cartoteca-releases',
    container: 'cartoteca-app-1',
    project: 'cartoteca',
    backupTimer: 'cartoteca-backup-agent.timer',
    origin: 'https://example.invalid',
    schema: 15,
    expectedImage: 'sha256:' + 'a'.repeat(64),
  };
  const file = path.join(directory, 'target.json');
  const write = (updates) => fs.writeFileSync(file, JSON.stringify({ ...value, ...updates }));
  write({});
  return { directory, value, file, write };
}

test('deployment configuration rejects ambiguous destinations, migrations and shell syntax', (t) => {
  const f = fixture(t);
  assert.deepEqual(configuration(f.file), f.value);
  for (const patch of [
    { host: '-oProxyCommand=bad' },
    { root: '/opt/../data' },
    { releaseRoot: '/opt/cartoteca-v2/release' },
    { schema: 19 },
    { schema: 17, migration: 'structural-17-to-18' },
    { schema: 18, migration: 'staff-push-16-to-17' },
    { schema: 16, migration: 'staff-push-16-to-17' },
    { schema: 17, migration: 'staff-max-15-to-16' },
    { schema: 15, migration: 'staff-max-15-to-16' },
    { schema: 16, migration: 'arbitrary' },
    { schema: 17, migration: 'read-budget-17' },
    { schema: 18, migration: 'read-budget-17', readBudgetVersion: 1 },
    { schema: 17, migration: 'staff-push-16-to-17', readBudgetVersion: 1 },
    { schema: 17, readBudgetVersion: '1' },
    { schema: 17, readBudgetVersion: 2 },
    { schema: 18, readBudgetVersion: 1 },
    { schema: 17, migration: 'booking-links-17', readBudgetVersion: 1 },
    { schema: 17, migration: 'booking-links-17', bookingLinksVersion: 1 },
    { schema: 18, readBudgetVersion: 1, bookingLinksVersion: 1 },
    { schema: 17, readBudgetVersion: 1, bookingLinksVersion: true },
    { schema: 17, readBudgetVersion: 1, bookingLinksVersion: 2 },
    { schema: 17, migration: 'read-budget-17', readBudgetVersion: 1, bookingLinksVersion: 1 },
    { publicationGate: 'true' },
    { publicationGate: 1 },
    { publicationGate: false },
    { schema: 17, publicationGate: true },
    { schema: 17, publicationGate: true, readBudgetVersion: 1 },
    { schema: 17, migration: 'staff-push-16-to-17', publicationGate: true },
    {
      schema: 17,
      readBudgetVersion: 1,
      bookingLinksVersion: 1,
      migration: 'booking-links-17',
      publicationGate: true,
    },
    { expectedImage: 'mutable:tag' },
    { origin: 'https://user:password@example.invalid' },
    { origin: 'https://example.invalid/path' },
    { port: 0 },
    { command: 'arbitrary shell' },
  ]) {
    f.write(patch);
    assert.throws(() => configuration(f.file));
  }
  const server = serverConfiguration(f.value);
  assert.equal(server.identityFile, undefined);
  assert.equal(server.knownHostsFile, undefined);
  assert.equal(server.host, undefined);
  assert.equal(server.schema, 15);
  f.write({ schema: 16, migration: 'staff-max-15-to-16' });
  assert.equal(configuration(f.file).migration, 'staff-max-15-to-16');
  f.write({ schema: 16 });
  assert.equal(configuration(f.file).schema, 16);
  f.write({ schema: 17, migration: 'staff-push-16-to-17' });
  assert.equal(configuration(f.file).migration, 'staff-push-16-to-17');
  f.write({ schema: 18, migration: 'structural-17-to-18' });
  assert.equal(configuration(f.file).migration, 'structural-17-to-18');
  f.write({ schema: 17, migration: 'read-budget-17', readBudgetVersion: 1 });
  assert.equal(configuration(f.file).readBudgetVersion, 1);
  f.write({ schema: 17, readBudgetVersion: 1 });
  assert.equal(configuration(f.file).readBudgetVersion, 1);
  for (const migration of ['booking-links-17', undefined]) {
    f.write({ schema: 17, readBudgetVersion: 1, bookingLinksVersion: 1, migration });
    assert.equal(configuration(f.file).bookingLinksVersion, 1);
  }
});

test('PostgreSQL server plans recognise an explicit backend but never reuse SQLite automatic cutover', (t) => {
  const f = fixture(t),
    patch = {
      storageBackend: 'postgres',
      postgresProfile: 'production-v1',
      schema: 19,
      paymentNetworkEnabled: false,
      readBudgetVersion: 1,
      bookingLinksVersion: 1,
    };
  f.write(patch);
  const config = configuration(f.file);
  assert.deepEqual(config, { ...f.value, ...patch });
  assert.equal(serverConfiguration(config).storageBackend, 'postgres');
  for (const change of [
    { postgresProfile: undefined },
    { postgresProfile: 'local' },
    { storageBackend: 'sqlite' },
    { paymentNetworkEnabled: true },
    { paymentNetworkEnabled: undefined },
    { migration: 'paid-services-17-to-19' },
    { publicationGate: true },
    { assistantSavingVersion: 2 },
    { storageBackend: 'automatic' },
  ]) {
    f.write({ ...patch, ...change });
    assert.throws(() => configuration(f.file));
  }
  assert.throws(() => assertMigrationStand({}, config), /POSTGRES_RELEASE_SWITCH_NOT_APPROVED/);
  for (const name of [
    'compose.postgres.yaml',
    'compose.postgres.rehearsal.yaml',
    'scripts/release/remote/postgres.py',
  ])
    assert.equal(allowed(name), true);
  assert.equal(allowed('compose.postgres.private.yaml'), false);
  assert.equal(allowed('scripts/release/remote/postgres_private.py'), false);
});

test('PostgreSQL active voice execution preserves exact schema19/component1 policy without admitting automatic cutover', (t) => {
  const f = fixture(t),
    safe = {
      storageBackend: 'postgres',
      postgresProfile: 'production-v1',
      schema: 19,
      paymentNetworkEnabled: false,
      readBudgetVersion: 1,
      bookingLinksVersion: 1,
      assistantSavingVersion: 1,
    };
  f.write(safe);
  assert.equal(configuration(f.file).assistantSavingVersion, 1);
  assert.equal(serverConfiguration(configuration(f.file)).assistantSavingVersion, 1);
  for (const patch of [
    ...[0, 2, true, false, '1', null].map((assistantSavingVersion) => ({ assistantSavingVersion })),
    { schema: 17 },
    { schema: 20 },
    { readBudgetVersion: undefined },
    { bookingLinksVersion: undefined },
    { publicationGate: true },
    { migration: 'paid-services-17-to-19' },
    { paymentNetworkEnabled: true },
  ]) {
    f.write({ ...safe, ...patch });
    assert.throws(() => configuration(f.file));
  }
});

test('ordinary gated publication preserves schema/component pins and exports no SSH credentials', (t) => {
  const f = fixture(t);
  const patch = {
    schema: 17,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    publicationGate: true,
  };
  f.write(patch);
  const config = configuration(f.file);
  assert.equal(config.migration, undefined);
  assert.deepEqual(config, { ...f.value, ...patch });
  const remote = serverConfiguration(config);
  for (const name of ['host', 'user', 'port', 'identityFile', 'knownHostsFile'])
    assert.equal(remote[name], undefined);
  for (const [name, expected] of Object.entries(patch)) assert.equal(remote[name], expected);
});

test('production assistant saving is an exact gated schema17 opt-in, never a migration or implicit default', (t) => {
  const f = fixture(t);
  const safe = { schema: 17, readBudgetVersion: 1, bookingLinksVersion: 1, publicationGate: true };
  f.write(safe);
  assert.equal(configuration(f.file).assistantSavingVersion, undefined);
  assert.equal(serverConfiguration(configuration(f.file)).assistantSavingVersion, undefined);
  f.write({ ...safe, assistantSavingVersion: 1 });
  assert.equal(configuration(f.file).assistantSavingVersion, 1);
  assert.equal(serverConfiguration(configuration(f.file)).assistantSavingVersion, 1);
  for (const patch of [
    ...[0, 2, true, false, '1', null].map((assistantSavingVersion) => ({ assistantSavingVersion })),
    { publicationGate: undefined },
    { publicationGate: false },
    { schema: 18 },
    { readBudgetVersion: undefined },
    { bookingLinksVersion: undefined },
    { migration: 'booking-links-17' },
  ]) {
    f.write({ ...safe, assistantSavingVersion: 1, ...patch });
    assert.throws(() => configuration(f.file));
  }
});

test('ordinary publication gate requires exact startup, activation and disconnect stand evidence', (t) => {
  const f = fixture(t),
    candidate = { directory: f.directory, data: { sourceHash: 'gate-source' } };
  fs.mkdirSync(path.join(f.directory, 'stand'));
  const file = path.join(f.directory, 'stand/stand-report.json');
  const config = {
    schema: 17,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    publicationGate: true,
  };
  const names = [
    'schema-17-without-migration',
    'read-budget-17-after-disconnect',
    'read-budget-preparation-failure-keeps-schema17',
    'read-budget-gated-startup-failure-returns-schema17',
    'read-budget-activation-failure-keeps-new-data',
    'read-budget-17-without-migration',
    'booking-links-17-after-disconnect',
    'booking-links-preparation-failure-keeps-schema17',
    'booking-links-gated-startup-failure-returns-schema17',
    'booking-links-activation-failure-keeps-new-data',
    'booking-links-17-without-migration',
    'publication-gate-after-disconnect',
    'publication-gate-startup-failure-returns-current',
    'publication-gate-activation-failure-keeps-current-data',
    'publication-gate-without-migration',
  ];
  const scenarios = names.map((scenario) => ({ scenario, passed: true }));
  const write = (patch = {}) =>
    fs.writeFileSync(
      file,
      JSON.stringify({ sourceHash: 'gate-source', passed: true, scenarios, ...patch }),
    );
  for (const missing of names) {
    write({ scenarios: scenarios.filter((item) => item.scenario !== missing) });
    assert.throws(() => assertMigrationStand(candidate, config), /incomplete/);
  }
  for (const patch of [
    { sourceHash: 'old-source' },
    { passed: false },
    { scenarios: scenarios.map((item) => ({ ...item, passed: false })) },
  ]) {
    write(patch);
    assert.throws(() => assertMigrationStand(candidate, config));
  }
  write();
  assert.doesNotThrow(() => assertMigrationStand(candidate, config));
});

test('booking links activation and ordinary releases require both component transition reports', (t) => {
  const f = fixture(t),
    candidate = { directory: f.directory, data: { sourceHash: 'links-source' } };
  fs.mkdirSync(path.join(f.directory, 'stand'));
  const file = path.join(f.directory, 'stand/stand-report.json');
  const names = [
    'schema-17-without-migration',
    'read-budget-17-after-disconnect',
    'read-budget-preparation-failure-keeps-schema17',
    'read-budget-gated-startup-failure-returns-schema17',
    'read-budget-activation-failure-keeps-new-data',
    'read-budget-17-without-migration',
    'booking-links-17-after-disconnect',
    'booking-links-preparation-failure-keeps-schema17',
    'booking-links-gated-startup-failure-returns-schema17',
    'booking-links-activation-failure-keeps-new-data',
    'booking-links-17-without-migration',
  ];
  for (const migration of ['booking-links-17', undefined]) {
    const config = { schema: 17, readBudgetVersion: 1, bookingLinksVersion: 1, migration };
    for (const missing of names) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          sourceHash: 'links-source',
          passed: true,
          scenarios: names
            .filter((name) => name !== missing)
            .map((scenario) => ({ scenario, passed: true })),
        }),
      );
      assert.throws(() => assertMigrationStand(candidate, config), /incomplete/);
    }
    fs.writeFileSync(
      file,
      JSON.stringify({
        sourceHash: 'links-source',
        passed: true,
        scenarios: names.map((scenario) => ({ scenario, passed: true })),
      }),
    );
    assert.doesNotThrow(() => assertMigrationStand(candidate, config));
  }
});

test('isolated budget activation and subsequent releases require exact full transition evidence', (t) => {
  const f = fixture(t),
    candidate = { directory: f.directory, data: { sourceHash: 'budget-source' } };
  fs.mkdirSync(path.join(f.directory, 'stand'));
  const file = path.join(f.directory, 'stand/stand-report.json');
  const names = [
    'schema-17-without-migration',
    'read-budget-17-after-disconnect',
    'read-budget-preparation-failure-keeps-schema17',
    'read-budget-gated-startup-failure-returns-schema17',
    'read-budget-activation-failure-keeps-new-data',
    'read-budget-17-without-migration',
  ];
  const scenarios = names.map((scenario) => ({ scenario, passed: true }));
  for (const config of [
    { schema: 17, readBudgetVersion: 1, migration: 'read-budget-17' },
    { schema: 17, readBudgetVersion: 1 },
  ]) {
    for (const missing of names) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          sourceHash: 'budget-source',
          passed: true,
          scenarios: scenarios.filter((s) => s.scenario !== missing),
        }),
      );
      assert.throws(() => assertMigrationStand(candidate, config));
    }
    for (const patch of [
      { sourceHash: 'other' },
      { passed: false },
      { scenarios: scenarios.map((s) => ({ ...s, passed: false })) },
    ]) {
      fs.writeFileSync(
        file,
        JSON.stringify({ sourceHash: 'budget-source', passed: true, scenarios, ...patch }),
      );
      assert.throws(() => assertMigrationStand(candidate, config));
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ sourceHash: 'budget-source', passed: true, scenarios }),
    );
    assert.doesNotThrow(() => assertMigrationStand(candidate, config));
  }
});

test('schema18 requires structural migration evidence from the exact candidate', (t) => {
  const f = fixture(t),
    candidate = { directory: f.directory, data: { sourceHash: 'structural-source' } };
  const config = { schema: 18, migration: 'structural-17-to-18' };
  fs.mkdirSync(path.join(f.directory, 'stand'));
  const file = path.join(f.directory, 'stand/stand-report.json');
  const scenarios = [
    'schema-18-without-migration',
    'structural-17-to-18-after-disconnect',
    'structural-preparation-failure-keeps-schema17',
    'structural-gated-startup-failure-returns-schema17',
    'structural-activation-failure-keeps-new-data',
  ].map((scenario) => ({ scenario, passed: true }));
  for (const patch of [
    { sourceHash: 'previous' },
    { scenarios: scenarios.slice(1) },
    { passed: false },
  ]) {
    fs.writeFileSync(
      file,
      JSON.stringify({ sourceHash: 'structural-source', passed: true, scenarios, ...patch }),
    );
    assert.throws(() => assertMigrationStand(candidate, config));
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ sourceHash: 'structural-source', passed: true, scenarios }),
  );
  assertMigrationStand(candidate, config);
});

test('remote quoting preserves literal metacharacters and CLI distinguishes preparation from publishing', () => {
  assert.equal(quote("a'b;$(not-executed)"), "'a'\\''b;$(not-executed)'");
  assert.deepEqual(options(['--id', 'candidate', '--deploy-config', 'local.json']), {
    id: 'candidate',
    'deploy-config': 'local.json',
  });
  assert.throws(() => options(['--skip-checks']), /Unknown/);
});

test('schema 16 publishing rejects old, missing and incomplete migration stand evidence', (t) => {
  const f = fixture(t);
  const candidate = { directory: f.directory, data: { sourceHash: 'synthetic-source' } };
  const config = { schema: 16, migration: 'staff-max-15-to-16' };
  assertMigrationStand(candidate, { schema: 15 });
  assert.throws(() => assertMigrationStand(candidate, config), /report is required/);
  fs.mkdirSync(path.join(f.directory, 'stand'));
  const file = path.join(f.directory, 'stand/stand-report.json');
  const cases = [
    'schema-16-without-migration',
    'staff-max-15-to-16-after-disconnect',
    'staff-max-preparation-failure-keeps-schema15',
    'staff-max-gated-startup-failure-returns-schema15',
    'staff-max-activation-failure-keeps-new-data',
  ].map((scenario) => ({ scenario, passed: true }));
  const write = (patch) =>
    fs.writeFileSync(
      file,
      JSON.stringify({ sourceHash: 'synthetic-source', passed: true, scenarios: cases, ...patch }),
    );
  write({ sourceHash: 'previous-release' });
  assert.throws(() => assertMigrationStand(candidate, config), /another source/);
  write({ scenarios: cases.slice(1) });
  assert.throws(() => assertMigrationStand(candidate, config), /incomplete/);
  write({});
  assertMigrationStand(candidate, config);
});

test('schema17 publish requires matching push migration stand, not previous MAX evidence', (t) => {
  const f = fixture(t),
    candidate = { directory: f.directory, data: { sourceHash: 'push-source' } };
  const config = { schema: 17, migration: 'staff-push-16-to-17' };
  fs.mkdirSync(path.join(f.directory, 'stand'));
  const file = path.join(f.directory, 'stand/stand-report.json');
  const scenarios = [
    'schema-17-without-migration',
    'staff-push-16-to-17-after-disconnect',
    'staff-push-preparation-failure-keeps-schema16',
    'staff-push-gated-startup-failure-returns-schema16',
    'staff-push-activation-failure-keeps-new-data',
  ].map((scenario) => ({ scenario, passed: true }));
  fs.writeFileSync(
    file,
    JSON.stringify({ sourceHash: 'push-source', passed: true, scenarios: scenarios.slice(1) }),
  );
  assert.throws(() => assertMigrationStand(candidate, config), /incomplete/);
  fs.writeFileSync(file, JSON.stringify({ sourceHash: 'push-source', passed: true, scenarios }));
  assertMigrationStand(candidate, config);
});

test('server executor is included in snapshots without allowing arbitrary Python or private roots', (t) => {
  const f = fixture(t),
    source = path.join(f.directory, 'source'),
    target = path.join(f.directory, 'copy');
  fs.mkdirSync(path.join(source, 'scripts/release/remote'), { recursive: true });
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'scripts/release/remote/agent.py'), '# synthetic executor\n');
  copySnapshot(source, target);
  assert.equal(
    fs.readFileSync(path.join(target, 'scripts/release/remote/agent.py'), 'utf8'),
    '# synthetic executor\n',
  );
  assert.equal(allowed('scripts/release/remote/unknown.py'), false);
  assert.equal(allowed('scripts/release/remote/booking_links.py'), true);
  assert.equal(allowed('scripts/release/remote/publication_gate.py'), true);
  assert.equal(allowed('tests/helpers/release-stand-publication-gate.py'), true);
  for (const name of ['remote', 'fakes', 'preparation'])
    assert.equal(allowed('tests/helpers/release-paid-services-' + name + '.py'), true);
  assert.equal(allowed('tests/helpers/release-paid-services-unknown.py'), false);
  assert.equal(allowed('private/agent.py'), false);
});

test('runtime proof includes nested assets and fails closed when Docker COPY changes shape', (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.directory, 'Dockerfile'),
    'COPY package.json ./\nCOPY src ./src\nCOPY trust/max-root.pem ./trust/max-root.pem\n',
  );
  const candidate = {
    source: f.directory,
    data: {
      files: {
        'package.json': { sha256: 'p' },
        'src/a.cjs': { sha256: 'a' },
        'trust/max-root.pem': { sha256: 'c' },
      },
    },
  };
  assert.deepEqual(runtimeFiles(candidate), {
    'package.json': 'p',
    'src/a.cjs': 'a',
    'trust/max-root.pem': 'c',
  });
  fs.writeFileSync(path.join(f.directory, 'Dockerfile'), 'COPY --from=other /unknown /app\n');
  assert.throws(() => runtimeFiles(candidate), /COPY syntax/);
});

test('an interrupted server transition requires reconciliation, never a blind second publication', async () => {
  const result = await follow(
    async () => ({ status: 'switching', active: false }),
    undefined,
    () => {},
  );
  assert.equal(result.status, 'needs_attention');
  const completed = await follow(
    async () => ({ status: 'completed', active: false, actualImage: 'synthetic' }),
    undefined,
    () => {},
  );
  assert.equal(completed.actualImage, 'synthetic');
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(
    (
      await follow(async () => {
        throw Error('must not contact server');
      }, stopped.signal)
    ).status,
    'unknown',
  );
});

test('full paid-services transition accepts only19 from17 with exact components and payment network hardOFF', (t) => {
  const f = fixture(t),
    patch = {
      schema: 19,
      migration: 'paid-services-17-to-19',
      readBudgetVersion: 1,
      bookingLinksVersion: 1,
      assistantSavingVersion: 1,
      paymentNetworkEnabled: false,
    };
  f.write(patch);
  assert.deepEqual(configuration(f.file), { ...f.value, ...patch });
  for (const change of [
    { paymentNetworkEnabled: true },
    { paymentNetworkEnabled: 0 },
    { paymentNetworkEnabled: undefined },
    { readBudgetVersion: undefined },
    { bookingLinksVersion: undefined },
    { assistantSavingVersion: undefined },
    { schema: 18 },
    { publicationGate: true },
    { migration: 'structural-17-to-18' },
  ]) {
    f.write({ ...patch, ...change });
    assert.throws(() => configuration(f.file));
  }
  f.write({ ...patch, migration: undefined, publicationGate: true });
  assert.equal(configuration(f.file).schema, 19);
});
test('paid-services stand must belong to full candidate and exact selected image with all real migration cases', (t) => {
  const f = fixture(t),
    sourceHash = 'paid-source',
    imageId = 'sha256:' + 'c'.repeat(64),
    candidate = { directory: f.directory, data: { sourceHash, profile: 'full' } },
    config = { schema: 19, migration: 'paid-services-17-to-19' };
  fs.mkdirSync(path.join(f.directory, 'stand'));
  const file = path.join(f.directory, 'stand/stand-report.json'),
    names = require('../scripts/release/paid-services-policy.cjs').scenarios;
  const report = {
    sourceHash,
    imageId,
    passed: true,
    scenarios: names.map((scenario) => ({
      scenario,
      passed: true,
      paidServices: {
        sourceSchema: scenario === 'schema-19-without-migration' ? 19 : 17,
        paymentNetworkEnabled: false,
        platformOnly: true,
        componentsPreserved: true,
      },
    })),
  };
  fs.writeFileSync(file, JSON.stringify(report));
  assert.doesNotThrow(() => assertMigrationStand(candidate, config, imageId));
  assert.throws(() => assertMigrationStand(candidate, config, 'sha256:' + 'd'.repeat(64)));
  for (const changed of [
    { ...report, imageId: undefined },
    { ...report, scenarios: report.scenarios.slice(1) },
    { ...report, passed: false },
    { ...report, sourceHash: 'foreign' },
  ]) {
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => assertMigrationStand(candidate, config, imageId));
  }
  fs.writeFileSync(file, JSON.stringify(report));
  assert.throws(() =>
    assertMigrationStand(
      { ...candidate, data: { sourceHash, profile: 'assistant-ui' } },
      config,
      imageId,
    ),
  );
});
