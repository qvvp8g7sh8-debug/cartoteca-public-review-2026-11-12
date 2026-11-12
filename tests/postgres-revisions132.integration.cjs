const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const {
  readRevisionProfile,
} = require('../src/server/infrastructure/postgres/revision-profile132.cjs');
const {
  prepareRevisionProfile,
  operateRevisionProfile,
} = require('../src/server/infrastructure/postgres/revision-operator132.cjs');
const {
  revisionSelect,
  TABLE,
  functionSQL,
} = require('../src/server/infrastructure/postgres/revision-sql132.cjs');
const { KEYS, advisoryKey } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  preparedPostgresProfile,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const { identifier: q } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { createBackupKey } = require('../src/server/infrastructure/backup/service.cjs');
const {
  createPostgresBackup,
  restorePostgresBackup,
  withVerifiedPostgresArchive,
} = require('../src/server/infrastructure/postgres/backup-service.cjs');

async function setup(t) {
  const fixture = await nativeIsolatedFixture(t, { organizations: 1 });
  const original = fixture.platform.close;
  let closed = false;
  fixture.platform.close = () => {
    if (!closed) {
      closed = true;
      original();
    }
  };
  fixture.platform.close();
  const runtime = await startPostgresTestRuntime(),
    admin = new Client(runtime.admin),
    app = new Client(runtime.application);
  await admin.connect();
  await app.connect();
  t.after(async () => {
    await app.end();
    await admin.end();
    await runtime.close();
  });
  const assets = path.join(runtime.root, 'assets');
  await migratePostgresData({
    source: fixture.directory,
    destination: assets,
    client: admin,
    applicationRole: runtime.application.user,
    offline: true,
    dryRun: false,
  });
  const profile = JSON.parse(fs.readFileSync(path.join(assets, 'postgresql-runtime.json'), 'utf8'));
  await app.query(
    "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
    [profile.platformStoreId],
  );
  const token = async () =>
    BigInt(
      (
        await app.query(revisionSelect('n', { revisionProfile: 2 }), [
          'platform',
          profile.platformStoreId,
        ])
      ).rows[0].n,
    );
  async function change(target = 2, dry = false) {
    await admin.query('BEGIN');
    try {
      await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
      const result = await prepareRevisionProfile(admin, runtime.application.user, { target });
      await admin.query(dry ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }
  return { fixture, runtime, admin, app, assets, profile, token, change };
}
async function immutableRows(client) {
  const names = (
    await client.query(
      "SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('cartoteca_platform','cartoteca_cabinet','cartoteca_budget') AND c.relkind='r' ORDER BY 1,2",
    )
  ).rows;
  const result = [];
  for (const row of names)
    result.push(
      (
        await client.query(
          `SELECT count(*)::text AS n,md5(coalesce(string_agg(h,'' ORDER BY h),'')) AS digest FROM(SELECT md5(row_to_json(t)::text) AS h FROM ${q(row.nspname)}.${q(row.relname)} t)s`,
        )
      ).rows[0],
    );
  return result;
}

test(
  'native revision upgrade/downgrade preserves rows and legacy fallback; once per physical transaction and domain',
  { timeout: 120000 },
  async (t) => {
    const f = await setup(t),
      { admin, app, runtime, profile } = f;
    const before = await immutableRows(admin);
    assert.equal(await readRevisionProfile(app, runtime.application.user), 1);
    assert.equal(
      Object.hasOwn(
        await preparedPostgresProfile(runtime.application, f.assets),
        'postgresRevisionProfile',
      ),
      false,
    );
    await assert.rejects(
      prepareRevisionProfile(admin, runtime.application.user),
      (e) => e.code === '25P01',
    );
    assert.equal(
      await readRevisionProfile(app, runtime.application.user),
      1,
      'an outer transaction is mandatory',
    );
    await admin.query('BEGIN');
    try {
      const interrupted = {
        query(sql, values) {
          if (sql.startsWith('UPDATE cartoteca_catalog.native_manifests'))
            return admin.query('SELECT 1/0');
          return admin.query(sql, values);
        },
      };
      await assert.rejects(
        prepareRevisionProfile(interrupted, runtime.application.user),
        (e) => e.code === '22012',
      );
      assert.equal(
        await readRevisionProfile(admin, runtime.application.user),
        1,
        'actual DDL is rolled back to the savepoint',
      );
      assert.equal(
        (await admin.query('SELECT 1 AS n')).rows[0].n,
        1,
        'outer transaction remains usable',
      );
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    assert.equal((await f.change(2, true)).changed, true);
    assert.equal(
      await readRevisionProfile(app, runtime.application.user),
      1,
      'dry-run DDL was rolled back',
    );
    assert.equal((await f.change()).changed, true);
    assert.deepEqual(await immutableRows(admin), before);
    assert.equal(await readRevisionProfile(app, runtime.application.user), 2);
    assert.equal(
      (await preparedPostgresProfile(runtime.application, f.assets)).postgresRevisionProfile,
      2,
    );
    assert.equal((await f.change()).changed, false, 'idempotent v2 preparation');
    const base = await f.token();
    await app.query('BEGIN');
    await app.query(
      "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES('revision132-a',decode('01','hex'))",
    );
    assert.equal(await f.token(), base + 1n);
    await app.query(
      "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES('revision132-b',decode('01','hex'))",
    );
    await app.query(
      "UPDATE cartoteca_platform.telegram_runtime SET value=decode('02','hex') WHERE key LIKE 'revision132-%'",
    );
    assert.equal(
      await f.token(),
      base + 1n,
      'several row updates share one physical transaction increment',
    );
    await app.query('ROLLBACK');
    assert.equal(await f.token(), base);
    await app.query('BEGIN');
    await app.query(
      "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES('revision132-a',decode('01','hex'))",
    );
    await app.query(
      "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES('staff-selftest-v1:telegram:revision132',decode('01','hex'))",
    );
    assert.equal(
      await f.token(),
      base + 2n,
      'business and staff-telegram independent lanes each increment once',
    );
    await app.query('COMMIT');
    const committed = await f.token();
    const rows = (
      await admin.query(
        `SELECT domain,revision FROM ${TABLE} WHERE kind='platform' AND store_id=$1 ORDER BY domain`,
        [profile.platformStoreId],
      )
    ).rows;
    assert.deepEqual(
      rows.map((r) => [r.domain, String(r.revision)]),
      [
        ['business', '1'],
        ['staff-telegram', '1'],
      ],
    );
    const storeRevision = (
      await app.query(
        "SELECT revision FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
        [profile.platformStoreId],
      )
    ).rows[0].revision;
    assert.equal(BigInt(storeRevision), base, 'v2 never updates the shared stores row');
    const data = await immutableRows(admin);
    await f.change(1, true);
    assert.equal(await readRevisionProfile(app, runtime.application.user), 2);
    await f.change(1);
    assert.equal(await readRevisionProfile(app, runtime.application.user), 1);
    assert.equal(
      BigInt(
        (
          await app.query(
            'SELECT revision FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2',
            ['platform', profile.platformStoreId],
          )
        ).rows[0].revision,
      ),
      committed,
    );
    assert.deepEqual(await immutableRows(admin), data);
    assert.equal(
      (await admin.query('SELECT to_regclass($1) AS relation', [TABLE])).rows[0].relation,
      null,
    );
    await f.change();
    assert.equal(await f.token(), committed, 're-upgrade retains the folded compatibility base');
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM ' + TABLE)).rows[0].n,
      0,
      'no stale xid was carried across upgrades',
    );
  },
);

test(
  'native technical revision schema rejects FK/RLS/helper/ACL drift, foreign writes and active runtime upgrade',
  { timeout: 120000 },
  async (t) => {
    const f = await setup(t),
      { admin, app, runtime, profile } = f;
    const secret = path.join(runtime.root, 'synthetic-app-secret');
    fs.writeFileSync(secret, runtime.application.password, { mode: 0o600 });
    const env = {
      CARTOTECA_STORAGE_BACKEND: 'postgres',
      CARTOTECA_POSTGRES_PROFILE: 'production-v1',
      CARTOTECA_PG_PASSWORD_FILE: path.join(runtime.root, 'synthetic-owner-secret'),
      CARTOTECA_PG_APPLICATION_PASSWORD_FILE: secret,
      BACKUP_POSTGRES_APPLICATION_ROLE: runtime.application.user,
    };
    const statements = [];
    const deps = {
      connect: async () => runtime.admin,
      createClient(settings) {
        const c = new Client(settings),
          query = c.query;
        c.query = function (sql, ...args) {
          statements.push(sql);
          return query.call(c, sql, ...args);
        };
        return c;
      },
    };
    const guardian = new Client(runtime.admin);
    await guardian.connect();
    const key = advisoryKey('cartoteca:postgres-server:v1:' + profile.platformStoreId);
    try {
      await guardian.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      await assert.rejects(
        operateRevisionProfile(['--offline', '--apply'], env, deps),
        (e) => e.code === 'POSTGRES_REVISION_RUNTIME_ACTIVE',
      );
      assert.equal(
        statements.some((s) => /^(CREATE|ALTER|DROP)/.test(s)),
        false,
      );
      assert.equal(await readRevisionProfile(app, runtime.application.user), 1);
      await guardian.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    } finally {
      await guardian.end();
    }
    await f.change();
    for (const sql of [
      'ALTER TABLE ' + TABLE + ' DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE ' + TABLE + ' DISABLE TRIGGER ALL',
      'ALTER TABLE cartoteca_catalog.stores DISABLE TRIGGER ALL',
      'ALTER TABLE ' + TABLE + ' DROP CONSTRAINT revision_state_store_fkey',
      'GRANT UPDATE ON ' + TABLE + ' TO ' + q(runtime.application.user),
      functionSQL(1),
      'CREATE INDEX forbidden_revision132 ON ' + TABLE + '(revision)',
    ]) {
      await admin.query('BEGIN');
      try {
        await admin.query(sql);
        await assert.rejects(
          readRevisionProfile(admin, runtime.application.user),
          (e) => e.code === 'POSTGRES_REVISION_PROFILE_INVALID',
        );
      } finally {
        await admin.query('ROLLBACK');
      }
      assert.equal(await readRevisionProfile(app, runtime.application.user), 2);
    }
    await assert.rejects(
      app.query(`INSERT INTO ${TABLE} VALUES('platform',$1,'business',1,pg_current_xact_id())`, [
        profile.platformStoreId,
      ]),
      (e) => e.code === '42501',
    );
    await app.query("SELECT set_config('cartoteca.store_id','foreign-revision132',false)");
    assert.equal((await app.query('SELECT * FROM ' + TABLE)).rows.length, 0);
    await app.query("SELECT set_config('cartoteca.store_id',$1,false)", [profile.platformStoreId]);
  },
);

test(
  'native revision profile installs, writes and folds both scopes through a non-BYPASS definer owner',
  { timeout: 120000 },
  async (t) => {
    const f = await setup(t),
      { admin, app, runtime, profile } = f;
    const role = 'revision_owner132_' + randomBytes(8).toString('hex');
    let created = false;
    try {
      await admin.query(
        'CREATE ROLE ' + q(role) + ' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
      );
      created = true;
      const secret = path.join(runtime.root, 'limited-owner-app-secret');
      fs.writeFileSync(secret, runtime.application.password, { mode: 0o600 });
      const env = {
        CARTOTECA_STORAGE_BACKEND: 'postgres',
        CARTOTECA_POSTGRES_PROFILE: 'production-v1',
        CARTOTECA_PG_PASSWORD_FILE: path.join(runtime.root, 'synthetic-owner-secret'),
        CARTOTECA_PG_APPLICATION_PASSWORD_FILE: secret,
        BACKUP_POSTGRES_APPLICATION_ROLE: runtime.application.user,
      };
      const statements = [];
      const deps = {
        connect: async () => runtime.admin,
        createClient(settings) {
          const c = new Client(settings),
            connect = c.connect.bind(c),
            query = c.query.bind(c);
          c.query = (sql, ...args) => {
            statements.push(sql);
            return query(sql, ...args);
          };
          c.connect = async () => {
            await connect();
            if (settings.user === runtime.admin.user) await c.query('SET ROLE ' + q(role));
          };
          return c;
        },
      };
      await assert.rejects(
        operateRevisionProfile(['--offline', '--apply'], env, deps),
        (e) => e.code === 'POSTGRES_REVISION_OPERATOR_AUTHORITY_REQUIRED',
      );
      assert.equal(
        statements.some((sql) => /^(BEGIN|CREATE|ALTER|DROP|UPDATE|INSERT|DELETE)/.test(sql)),
        false,
        'limited authority is refused before BEGIN or DDL',
      );
      await admin.query('GRANT USAGE,CREATE ON SCHEMA cartoteca_catalog TO ' + q(role));
      await admin.query(
        'GRANT USAGE ON SCHEMA cartoteca_platform,cartoteca_cabinet,cartoteca_budget TO ' + q(role),
      );
      await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA cartoteca_catalog TO ' + q(role));
      await admin.query('GRANT UPDATE ON cartoteca_catalog.native_manifests TO ' + q(role));
      await admin.query('GRANT SELECT,UPDATE,REFERENCES ON cartoteca_catalog.stores TO ' + q(role));
      await admin.query(
        'ALTER FUNCTION cartoteca_catalog.bump_store_revision() OWNER TO ' + q(role),
      );
      await admin.query(
        "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
        [profile.platformStoreId],
      );
      await admin.query('SET ROLE ' + q(role));
      await admin.query('BEGIN');
      try {
        await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
        await prepareRevisionProfile(admin, runtime.application.user);
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
      await admin.query('RESET ROLE');
      const flags = (
        await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [role])
      ).rows[0];
      assert.deepEqual(flags, { rolsuper: false, rolbypassrls: false });
      assert.equal(await readRevisionProfile(app, runtime.application.user), 2);
      const before = await f.token();
      await app.query(
        "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES('revision132-non-bypass',decode('01','hex'))",
      );
      assert.equal(
        await f.token(),
        before + 1n,
        'FORCE RLS permits only the attested definer owner to bump state',
      );
      const cabinet = profile.stores.find((scope) => scope.kind === 'cabinet');
      assert.ok(cabinet, 'fixture has a second store scope');
      await app.query(
        "SELECT set_config('cartoteca.kind','cabinet',false),set_config('cartoteca.store_id',$1,false)",
        [cabinet.storeId],
      );
      await app.query(
        "INSERT INTO cartoteca_cabinet.meta(key,value) VALUES('revision132-cabinet',decode('01','hex'))",
      );
      await app.query(
        "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
        [profile.platformStoreId],
      );
      const beforeInverse = new Map();
      for (const scope of [{ kind: 'platform', storeId: profile.platformStoreId }, cabinet])
        beforeInverse.set(
          scope.kind,
          BigInt(
            (
              await admin.query(revisionSelect('n', { revisionProfile: 2 }), [
                scope.kind,
                scope.storeId,
              ])
            ).rows[0].n,
          ),
        );
      await assert.rejects(
        app.query('UPDATE ' + TABLE + ' SET revision=revision+1'),
        (e) => e.code === '42501',
      );
      await admin.query('BEGIN');
      try {
        await admin.query(
          'ALTER POLICY revision_owner ON ' + TABLE + ' TO ' + q(runtime.application.user),
        );
        await assert.rejects(
          readRevisionProfile(admin, runtime.application.user),
          (e) => e.code === 'POSTGRES_REVISION_PROFILE_INVALID',
        );
      } finally {
        await admin.query('ROLLBACK');
      }
      await admin.query('SET ROLE ' + q(role));
      await admin.query('BEGIN');
      try {
        await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
        await prepareRevisionProfile(admin, runtime.application.user, { target: 1 });
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
      await admin.query('RESET ROLE');
      for (const scope of [{ kind: 'platform', storeId: profile.platformStoreId }, cabinet]) {
        const actual = BigInt(
          (await admin.query(revisionSelect('n', {}), [scope.kind, scope.storeId])).rows[0].n,
        );
        assert.equal(
          actual,
          beforeInverse.get(scope.kind),
          'each store counter is folded under its own RLS scope',
        );
      }
      const restoredScope = (
        await admin.query(
          "SELECT current_setting('cartoteca.kind',true) AS kind,current_setting('cartoteca.store_id',true) AS store_id",
        )
      ).rows[0];
      assert.deepEqual(restoredScope, { kind: 'platform', store_id: profile.platformStoreId });
      assert.equal(await readRevisionProfile(app, runtime.application.user), 1);
    } finally {
      await admin.query('RESET ROLE');
      if (created) {
        await admin.query(
          'ALTER FUNCTION cartoteca_catalog.bump_store_revision() OWNER TO ' +
            q(runtime.admin.user),
        );
        if ((await admin.query('SELECT to_regclass($1) AS relation', [TABLE])).rows[0].relation) {
          await admin.query('ALTER TABLE ' + TABLE + ' OWNER TO ' + q(runtime.admin.user));
          await admin.query(
            'ALTER POLICY revision_owner ON ' + TABLE + ' TO ' + q(runtime.admin.user),
          );
        }
        await admin.query('DROP OWNED BY ' + q(role));
        await admin.query('DROP ROLE ' + q(role));
      }
    }
  },
);

test(
  'native v2 backup reconstructs supported profile on fresh restore without xid replay',
  { timeout: 180000 },
  async (t) => {
    const f = await setup(t),
      { admin, runtime } = f;
    await f.change();
    const keyFile = path.join(runtime.root, 'backup.key'),
      archives = path.join(runtime.root, 'archives');
    createBackupKey(keyFile);
    const backup = await createPostgresBackup({
      source: f.assets,
      directory: archives,
      keyFile,
      connection: runtime.admin,
      applicationRole: runtime.application.user,
    });
    await withVerifiedPostgresArchive(backup.file, keyFile, {}, async ({ manifest }) =>
      assert.deepEqual(manifest.revisionProfile, { version: 2 }),
    );
    const database = 'revision132_' + randomBytes(10).toString('hex');
    await admin.query('CREATE DATABASE ' + q(database) + ' OWNER ' + q(runtime.admin.user));
    const target = new Client({ ...runtime.admin, database });
    try {
      const restored = path.join(runtime.root, 'restored');
      await restorePostgresBackup(backup.file, keyFile, restored, {
        connection: { ...runtime.admin, database },
        applicationRole: runtime.application.user,
        offline: true,
        upgradeCopy: true,
      });
      await target.connect();
      assert.equal(await readRevisionProfile(target, runtime.application.user), 2);
      assert.deepEqual(await immutableRows(target), await immutableRows(admin));
      assert.equal(
        (await target.query('SELECT count(*)::int AS n FROM ' + TABLE)).rows[0].n,
        0,
        'fresh cluster starts with no foreign last_xid',
      );
      assert.equal(
        (await preparedPostgresProfile({ ...runtime.application, database }, restored))
          .postgresRevisionProfile,
        2,
      );
    } finally {
      await target.end();
      await admin.query('DROP DATABASE ' + q(database) + ' WITH (FORCE)');
    }
  },
);
