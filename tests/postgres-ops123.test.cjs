const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  withOwner,
  provisionPostgres,
  migrationOptions,
  migrateServer,
  scramSecret,
} = require('../scripts/postgres-ops.cjs');
function fixture(
  t,
  {
    unsafe = false,
    connectFails = false,
    existing = false,
    membership = false,
    badPassword = false,
  } = {},
) {
  let registered = existing;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg123-ops-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-pg123-ops-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const secret = path.join(directory, 'app-secret'),
    password = 'synthetic-' + crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(secret, password, { mode: 0o600 });
  const env = {
    CARTOTECA_STORAGE_BACKEND: 'postgres',
    CARTOTECA_POSTGRES_PROFILE: 'production-v1',
    CARTOTECA_PG_PASSWORD_FILE: path.join(directory, 'owner-secret'),
    CARTOTECA_PG_APPLICATION_PASSWORD_FILE: secret,
    BACKUP_POSTGRES_APPLICATION_ROLE: 'synthetic_app',
    CARTOTECA_DATA_DIR: path.join(directory, 'assets'),
  };
  const statements = [],
    flags = {
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    };
  const owner = {
    ended: false,
    connect: async () => {
      if (connectFails) throw Error('synthetic connection failed');
    },
    end: async () => {
      owner.ended = true;
    },
    query: async (sql) => {
      statements.push(sql);
      if (sql.startsWith('CREATE ROLE')) registered = true;
      if (sql.includes('FROM pg_auth_members')) return { rows: membership ? [{ present: 1 }] : [] };
      if (sql.includes('FROM pg_roles WHERE rolname=$1'))
        return { rows: unsafe ? [{ ...flags, rolsuper: true }] : registered ? [flags] : [] };
      return { rows: [] };
    },
  };
  const app = {
    ended: false,
    connect: async () => {
      if (badPassword) throw Error('synthetic authentication failed');
    },
    end: async () => {
      app.ended = true;
    },
    query: async (sql) => ({ rows: sql.includes('FROM pg_auth_members') ? [] : [flags] }),
  };
  const connection = {
    host: '127.0.0.1',
    port: 5432,
    database: 'synthetic_database',
    user: 'synthetic_owner',
    password: 'synthetic owner password',
  };
  return {
    directory,
    env,
    password,
    statements,
    owner,
    app,
    dependencies: {
      connect: async () => connection,
      createClient: (settings) => (settings.user === 'synthetic_app' ? app : owner),
    },
  };
}
test('server operator refuses ambiguous raw credentials before connecting or reading app secrets', async () => {
  let connected = false;
  await assert.rejects(
    provisionPostgres(
      {
        CARTOTECA_STORAGE_BACKEND: 'postgres',
        CARTOTECA_POSTGRES_PROFILE: 'production-v1',
        CARTOTECA_PG_PASSWORD_FILE: '/missing',
        CARTOTECA_PG_PASSWORD: 'forbidden',
      },
      {
        connect: async () => {
          connected = true;
        },
      },
    ),
    /secret files/,
  );
  assert.equal(connected, false);
});
test('provision creates a distinct least privileged role with SCRAM, never plaintext SQL', async (t) => {
  const f = fixture(t);
  const result = await provisionPostgres(f.env, f.dependencies);
  assert.deepEqual(result, { provisioned: true, created: true, applicationRoleSafe: true });
  assert.ok(
    f.statements.some(
      (sql) =>
        sql.includes('NOBYPASSRLS') &&
        sql.includes('NOSUPERUSER') &&
        sql.includes('SCRAM-SHA-256$'),
    ),
  );
  assert.ok(f.statements.every((sql) => !sql.includes(f.password)));
  assert.ok(f.statements.some((sql) => sql.includes("log_min_error_statement='panic'")));
  assert.equal(f.owner.ended, true);
  assert.equal(f.app.ended, true);
  assert.equal(fs.existsSync(f.env.CARTOTECA_DATA_DIR), false);
});
test('an existing unsafe application role rolls back before any role or asset publication', async (t) => {
  const f = fixture(t, { unsafe: true });
  await assert.rejects(provisionPostgres(f.env, f.dependencies), /unsafe privileges/);
  assert.ok(f.statements.includes('ROLLBACK'));
  assert.ok(
    f.statements.every((sql) => !sql.startsWith('CREATE ROLE') && !sql.startsWith('COMMIT')),
  );
  assert.equal(fs.existsSync(f.env.CARTOTECA_DATA_DIR), false);
  assert.equal(f.owner.ended, true);
});
test('operator connection failure still closes its client', async (t) => {
  const f = fixture(t, { connectFails: true });
  await assert.rejects(
    withOwner(f.env, () => assert.fail('unexpected operation'), f.dependencies),
    /connection failed/,
  );
  assert.equal(f.owner.ended, true);
});
test('migration is explicitly offline, defaults to rollback and preserves target application role', async (t) => {
  const f = fixture(t, { existing: true }),
    source = path.join(f.directory, 'source');
  assert.throws(() => migrationOptions([], f.env), /offline/);
  assert.throws(() => migrationOptions(['--offline', '--url', 'forbidden'], f.env), /Unsupported/);
  let received;
  const result = await migrateServer(['--offline', '--source', source], f.env, {
    ...f.dependencies,
    migrate: async (options) => {
      received = options;
      return { dryRun: true, rolledBack: true, sourceUnchanged: true, reports: [] };
    },
  });
  assert.equal(received.dryRun, true);
  assert.equal(received.offline, true);
  assert.equal(received.applicationRole, 'synthetic_app');
  assert.equal(result.rolledBack, true);
  assert.equal(result.cutover, false);
  assert.equal(fs.existsSync(f.env.CARTOTECA_DATA_DIR), false);
});
test('SCRAM secret follows PostgreSQL salted key format and rejects unsafe password alphabets', () => {
  const password = 'a'.repeat(40),
    salt = Buffer.alloc(16, 7),
    encoded = scramSecret(password, salt),
    salted = crypto.pbkdf2Sync(password, salt, 4096, 32, 'sha256'),
    clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  assert.equal(
    encoded,
    'SCRAM-SHA-256$4096:' +
      salt.toString('base64') +
      '$' +
      crypto.createHash('sha256').update(clientKey).digest('base64') +
      ':' +
      crypto.createHmac('sha256', salted).update('Server Key').digest('base64'),
  );
  assert.ok(!encoded.includes(password));
  for (const invalid of ['short', '\u0430'.repeat(40), 'a'.repeat(40) + '\n'])
    assert.throws(() => scramSecret(invalid), /ASCII/);
});

test('standalone migrate refuses unsafe membership or wrong app password before calling the importer', async (t) => {
  for (const mode of [
    { existing: true, membership: true },
    { existing: true, badPassword: true },
  ]) {
    const f = fixture(t, mode);
    let imported = false;
    await assert.rejects(
      migrateServer(['--offline', '--source', path.join(f.directory, 'source'), '--apply'], f.env, {
        ...f.dependencies,
        migrate: async () => {
          imported = true;
        },
      }),
      /membership|authentication/,
    );
    assert.equal(imported, false);
    assert.equal(fs.existsSync(f.env.CARTOTECA_DATA_DIR), false);
    assert.ok(
      f.statements.every((sql) => sql.startsWith('SELECT ')),
      'preflight must never mutate roles, schemas or application data',
    );
    assert.equal(f.owner.ended, true);
    if (mode.badPassword) assert.equal(f.app.ended, true);
  }
});
