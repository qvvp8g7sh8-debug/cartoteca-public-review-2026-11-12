const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const {
  seed,
  readFixture,
  fingerprint,
  location,
} = require('../scripts/postgres-rehearsal-fixture.cjs');
const {
  registration,
  filename: budgetFilename,
} = require('../src/server/infrastructure/booking-read-budget-store.cjs');
test('Linux rehearsal fixture is a private, repeat-protected two-organization schema19 source with real optional components', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg123-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-pg123-fixture-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const environment = {
    CARTOTECA_POSTGRES_REHEARSAL: 'synthetic-v1',
    CARTOTECA_REHEARSAL_DIR: directory,
  };
  assert.throws(() => location({ CARTOTECA_REHEARSAL_DIR: directory }), /synthetic/);
  const result = await seed(environment);
  assert.deepEqual(result, {
    seeded: true,
    organizations: 2,
    patients: 2,
    photos: 1,
    schema: 19,
    syntheticOnly: true,
  });
  const { fixture, source } = readFixture(environment);
  assert.equal(fixture.bookingLinksVersion, 1);
  assert.equal(fingerprint(source), fixture.sourceFingerprint);
  assert.equal(new Set(fixture.actors.map((actor) => actor.organizationId)).size, 2);
  assert.equal(fs.existsSync(path.join(source, 'platform', 'migration-backups')), false);
  const database = new DatabaseSync(path.join(source, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 19);
    assert.equal(registration(database).mode, 'isolated');
    assert.equal(
      database.prepare('SELECT backend FROM assistant_state_schema WHERE id=1').get().backend,
      'rows-v1',
    );
    assert.equal(
      database.prepare('SELECT version FROM booking_public_links_schema WHERE id=1').get().version,
      1,
    );
  } finally {
    database.close();
  }
  const budget = new DatabaseSync(path.join(source, 'platform', budgetFilename), {
    readOnly: true,
  });
  try {
    assert.equal(budget.prepare('SELECT failures FROM login_limits').get().failures, 2);
  } finally {
    budget.close();
  }
  assert.equal(fingerprint(source), fixture.sourceFingerprint);
  await assert.rejects(seed(environment), /already exists/);
  const guarded = path.join(source, 'immutable-proof');
  fs.writeFileSync(guarded, 'changed', { flag: 'wx' });
  assert.notEqual(fingerprint(source), fixture.sourceFingerprint);
});

test('synthetic native backup reuses only the exact private numeric endpoint admitted by its owner', async (t) => {
  const { backupDrill } = require('../scripts/postgres-rehearsal.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg123-backup-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-pg123-backup-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(directory, 'fixture.json'),
    JSON.stringify({
      version: 1,
      scope: 'scale123-synthetic',
      actors: [{}, {}],
      sourceFingerprint: 'synthetic-proof',
      sourceRetired: true,
    }),
  );
  const environment = {
    CARTOTECA_POSTGRES_REHEARSAL: 'synthetic-v1',
    CARTOTECA_REHEARSAL_DIR: directory,
    CARTOTECA_PG_ALLOWED_HOSTS: 'postgres',
    CARTOTECA_DATA_DIR: path.join(directory, 'assets'),
    BACKUP_DIR: path.join(directory, 'backups'),
    BACKUP_KEY_FILE: path.join(directory, 'backup-key'),
    BACKUP_WORK_DIR: path.join(directory, 'work'),
    BACKUP_POSTGRES_APPLICATION_ROLE: 'synthetic_app',
  };
  const calls = [],
    connection = {
      host: '172.30.124.2',
      port: 5432,
      user: 'synthetic_owner',
      database: 'synthetic_database',
      password: 'private synthetic password',
    };
  const result = await backupDrill(environment, {
    withOwner: async (_, callback) => callback(null, connection),
    createBackup: async (options) => {
      calls.push(options);
      return {
        verified: true,
        photos: 1,
        patients: 2,
        file: path.join(directory, 'synthetic.enc'),
      };
    },
    restoreDrill: async (_, __, ___, options) => {
      calls.push(options);
      return { started: true, restored: true, notificationsPaused: true };
    },
  });
  assert.equal(result.backupVerified, true);
  assert.equal(result.restoreStarted, true);
  assert.equal(calls.length, 2);
  for (const options of calls) {
    assert.equal(options.connection, connection);
    assert.deepEqual(options.connectionOptions, {
      profile: 'production-v1',
      allowedHosts: ['172.30.124.2'],
    });
  }
  assert.equal(environment.CARTOTECA_PG_ALLOWED_HOSTS, 'postgres');
  for (const host of ['unresolved.invalid', '8.8.8.8'])
    await assert.rejects(
      backupDrill(environment, {
        withOwner: async (_, callback) => callback(null, { ...connection, host }),
        createBackup: async () => assert.fail('unsafe endpoint reached backup'),
      }),
      /private PostgreSQL endpoint/,
    );
});

test('synthetic loopback client preserves the explicit HTTPS Host and Origin without changing auth policy', async () => {
  const http = require('node:http'),
    { loopbackRequest } = require('../scripts/postgres-rehearsal.cjs');
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          host: request.headers.host,
          origin: request.headers.origin,
          method: request.method,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await loopbackRequest(
      'http://127.0.0.1:' + server.address().port + '/api/auth/login',
      {
        method: 'POST',
        headers: {
          Host: 'synthetic.invalid',
          Origin: 'https://synthetic.invalid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ synthetic: true }),
        signal: AbortSignal.timeout(2000),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      host: 'synthetic.invalid',
      origin: 'https://synthetic.invalid',
      method: 'POST',
      body: { synthetic: true },
    });
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      loopbackRequest('http://127.0.0.1:' + server.address().port, { signal: abort.signal }),
      { name: 'AbortError' },
    );
    assert.throws(() => loopbackRequest('http://external.invalid/'), /loopback/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
