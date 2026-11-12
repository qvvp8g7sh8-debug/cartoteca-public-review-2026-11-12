const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareRoleLeases, roleLeaseOptions, main } = require('../scripts/postgres-ops.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
function fixture(
  t,
  {
    failEnsure = false,
    changeRegistry = false,
    changeSchema = false,
    unsafe = false,
    badPassword = false,
    invalidProof = false,
    failCommit = false,
    created = true,
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-role-ops129-'));
  const appSecret = path.join(directory, 'application-secret');
  fs.writeFileSync(appSecret, 'synthetic-application-secret-129-xxxxxxxx', { mode: 0o600 });
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-role-ops129-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const env = {
    CARTOTECA_STORAGE_BACKEND: 'postgres',
    CARTOTECA_POSTGRES_PROFILE: 'production-v1',
    CARTOTECA_PG_PASSWORD_FILE: path.join(directory, 'owner-secret'),
    CARTOTECA_PG_APPLICATION_PASSWORD_FILE: appSecret,
    BACKUP_POSTGRES_APPLICATION_ROLE: 'synthetic_app',
  };
  const calls = [],
    flags = {
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    };
  let ensured = false,
    connects = 0,
    ensureCalls = 0;
  const owner = {
    ended: false,
    async connect() {
      connects++;
    },
    async end() {
      owner.ended = true;
    },
    async query(sql, args = []) {
      calls.push({ sql, args });
      if (sql.includes('FROM pg_auth_members')) return { rows: [] };
      if (sql.includes('FROM pg_roles WHERE rolname=$1'))
        return { rows: [{ ...flags, rolsuper: unsafe }] };
      if (sql.includes('count(*)::text AS rows'))
        return {
          rows: [
            {
              rows: '6',
              digest: invalidProof ? 'INVALID' : (ensured && changeRegistry ? 'b' : 'a').repeat(32),
            },
          ],
        };
      if (sql.includes('FROM pg_indexes') && ensured && changeSchema)
        return { rows: [{ indexdef: 'synthetic changed native index' }] };
      if (sql === 'COMMIT' && failCommit) throw Error('Synthetic uncertain commit');
      return { rows: [] };
    },
  };
  const app = {
    ended: false,
    async connect() {
      if (badPassword) throw Error('Synthetic authentication failure');
    },
    async end() {
      app.ended = true;
    },
    async query(sql) {
      return { rows: sql.includes('FROM pg_auth_members') ? [] : [flags] };
    },
  };
  const dependencies = {
    async connect() {
      return { host: '127.0.0.1', port: 5432, user: 'synthetic_owner', database: 'synthetic_db' };
    },
    createClient: (settings) => (settings.user === 'synthetic_app' ? app : owner),
    async ensureRoleLeaseSchema(client, role) {
      assert.equal(client, owner);
      assert.equal(role, 'synthetic_app');
      ensureCalls++;
      ensured = true;
      calls.push({ sql: 'SYNTHETIC_ENSURE_ROLE_SCHEMA', args: [] });
      if (failEnsure)
        throw Object.assign(Error('Synthetic malformed role schema'), {
          code: 'POSTGRES_ROLE_SCHEMA_INVALID',
        });
      return { created, validated: true };
    },
  };
  return {
    env,
    dependencies,
    calls,
    owner,
    app,
    connects: () => connects,
    ensureCalls: () => ensureCalls,
  };
}

test('role preparation requires exactly explicit offline and exactly one apply/dry-run before opening any connection', async () => {
  for (const args of [
    [],
    ['--offline'],
    ['--apply'],
    ['--offline', '--apply', '--dry-run'],
    ['--offline', '--offline'],
    ['--offline', '--url'],
    ['--offline', '--apply', '--force'],
    ['--offline', '--dry-run', '--source', '/forbidden'],
  ]) {
    let connected = false;
    await assert.rejects(
      prepareRoleLeases(
        args,
        {},
        {
          connect: async () => {
            connected = true;
          },
        },
      ),
      /exactly/,
    );
    assert.equal(connected, false);
  }
  assert.deepEqual(roleLeaseOptions(['--offline', '--apply']), { dryRun: false });
  assert.deepEqual(roleLeaseOptions(['--dry-run', '--offline']), { dryRun: true });
  await assert.rejects(main(['prepare-role-leases', '--offline']), /exactly/);
});

test('offline apply uses the exact exclusive maintenance fence and commits only after both immutable technical proofs', async (t) => {
  const f = fixture(t);
  const result = await prepareRoleLeases(['--offline', '--apply'], f.env, f.dependencies);
  assert.deepEqual(result, {
    prepared: true,
    dryRun: false,
    rolledBack: false,
    created: true,
    wouldCreate: true,
    verified: true,
    nativeStoreRowsUnchanged: true,
    businessSchemaUnchanged: true,
    rolesChanged: false,
    cutover: false,
  });
  assert.equal(f.ensureCalls(), 1);
  const sql = f.calls.map((x) => x.sql),
    begin = sql.indexOf('BEGIN'),
    fence = sql.indexOf('SELECT pg_advisory_xact_lock($1::bigint)'),
    ensure = sql.indexOf('SYNTHETIC_ENSURE_ROLE_SCHEMA');
  assert.ok(begin > 0 && fence > begin && ensure > fence);
  assert.deepEqual(f.calls[fence].args, [KEYS.maintenance]);
  assert.equal(sql.filter((s) => s.includes('count(*)::text AS rows')).length, 18);
  assert.equal(sql.at(-1), 'COMMIT');
  assert.equal(sql.includes('ROLLBACK'), false);
  assert.ok(sql.every((s) => !/^(CREATE ROLE|ALTER ROLE|DROP|UPDATE|INSERT|DELETE)/.test(s)));
  assert.ok(sql.every((s) => !s.includes('synthetic-application-secret-129')));
  assert.ok(!JSON.stringify(result).includes('digest'));
  assert.equal(f.owner.ended, true);
  assert.equal(f.app.ended, true);
});

test('dry-run validates in the same exclusive transaction but rolls back all prospective DDL', async (t) => {
  const f = fixture(t);
  const result = await prepareRoleLeases(['--offline', '--dry-run'], f.env, f.dependencies);
  assert.equal(result.prepared, false);
  assert.equal(result.created, false);
  assert.equal(result.wouldCreate, true);
  assert.equal(result.verified, true);
  assert.equal(result.rolledBack, true);
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!f.calls.some((x) => x.sql === 'COMMIT'));
});

test('already prepared schema is verified idempotently without claiming new creation', async (t) => {
  const f = fixture(t, { created: false });
  const result = await prepareRoleLeases(['--offline', '--apply'], f.env, f.dependencies);
  assert.equal(result.created, false);
  assert.equal(result.wouldCreate, false);
  assert.equal(result.verified, true);
});

test('unsafe application role and authentication failure stop before BEGIN/schema preparation', async (t) => {
  for (const mode of [{ unsafe: true }, { badPassword: true }]) {
    const f = fixture(t, mode);
    await assert.rejects(
      prepareRoleLeases(['--offline', '--apply'], f.env, f.dependencies),
      /verification|authentication/,
    );
    assert.equal(f.ensureCalls(), 0);
    assert.ok(f.calls.every((x) => x.sql.startsWith('SELECT ')));
    assert.equal(f.owner.ended, true);
  }
});

test('malformed technical schema or either changed immutable proof rolls back and never reports preparation', async (t) => {
  for (const mode of [
    { failEnsure: true },
    { changeRegistry: true },
    { changeSchema: true },
    { invalidProof: true },
  ]) {
    const f = fixture(t, mode);
    await assert.rejects(
      prepareRoleLeases(['--offline', '--apply'], f.env, f.dependencies),
      /malformed|changed|proof/,
    );
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
    assert.ok(!f.calls.some((x) => x.sql === 'COMMIT'));
    assert.equal(f.owner.ended, true);
  }
});

test('unknown commit failure is not turned into successful preparation or replayed', async (t) => {
  const f = fixture(t, { failCommit: true });
  await assert.rejects(
    prepareRoleLeases(['--offline', '--apply'], f.env, f.dependencies),
    /uncertain commit/,
  );
  assert.equal(f.ensureCalls(), 1);
  assert.equal(f.calls.filter((x) => x.sql === 'COMMIT').length, 1);
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(f.owner.ended, true);
});
