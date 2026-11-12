const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createCipheriv } = require('node:crypto');
const { Client } = require('pg');
const {
  postgresRevisionFixture,
  immutableRows,
} = require('./helpers/postgres-revision133-fixture.cjs');
const {
  prepareCompoundProfile,
  operateCompoundProfile,
} = require('../src/server/infrastructure/postgres/revision-operator133.cjs');
const {
  readRevisionProfile,
} = require('../src/server/infrastructure/postgres/revision-profile132.cjs');
const {
  TABLE,
  revisionSelect,
} = require('../src/server/infrastructure/postgres/revision-sql132.cjs');
const { functionSQL } = require('../src/server/infrastructure/postgres/revision-sql133.cjs');
const { KEYS, advisoryKey } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  preparedPostgresProfile,
  preparePostgresRuntimeConfig,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const { identifier: q } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { createBackupKey } = require('../src/server/infrastructure/backup/service.cjs');
const {
  createPostgresBackup,
  restorePostgresBackup,
  withVerifiedPostgresArchive,
} = require('../src/server/infrastructure/postgres/backup-service.cjs');
test(
  'native profile 3 offline transition, inverse, strict attestation and actual restore preserve business data',
  { timeout: 240000 },
  async (t) => {
    const f = await postgresRevisionFixture(t),
      { admin, app, runtime } = f;
    const seal = (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv(
          'aes-256-gcm',
          fs.readFileSync(path.join(f.assets, 'platform', 'platform.key')),
          iv,
        );
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    };
    const token2 = async () =>
      BigInt(
        (
          await app.query(revisionSelect('n', { revisionProfile: 2 }), [
            'platform',
            f.profile.platformStoreId,
          ])
        ).rows[0].n,
      );
    await t.test(
      'preparation requires a physical transaction and dry run rolls all changes back',
      async () => {
        await assert.rejects(
          prepareCompoundProfile(admin, runtime.application.user),
          (e) => e.code === '25P01',
        );
        const before = await immutableRows(admin);
        await f.change(2);
        await app.query(
          "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES('profile133-v2',$1)",
          [seal({ synthetic: 'v2' })],
        );
        const state = (
          await admin.query('SELECT * FROM ' + TABLE + ' ORDER BY kind,store_id,domain')
        ).rows;
        assert.ok(state.length > 0);
        const data = await immutableRows(admin);
        assert.deepEqual(await f.change(3, true), { previous: 2, target: 3, changed: true });
        assert.equal(await readRevisionProfile(app, runtime.application.user), 2);
        assert.deepEqual(await immutableRows(admin), data);
        assert.deepEqual(
          (await admin.query('SELECT * FROM ' + TABLE + ' ORDER BY kind,store_id,domain')).rows,
          state,
        );
        assert.deepEqual(await f.change(), { previous: 2, target: 3, changed: true });
        assert.equal(await readRevisionProfile(app, runtime.application.user), 3);
        assert.deepEqual(await immutableRows(admin), data);
        assert.equal(
          (await preparedPostgresProfile(runtime.application, f.assets)).postgresRevisionProfile,
          3,
        );
        const prepared = await preparePostgresRuntimeConfig({
          storageBackend: 'postgres',
          dataDir: f.assets,
          postgres: runtime.application,
        });
        assert.equal(prepared.postgresRevisionProfile, 3);
        await assert.rejects(
          preparePostgresRuntimeConfig({ ...prepared, postgresRevisionProfile: 2 }),
          /differs/,
        );
        assert.equal(before.length, data.length);
      },
    );
    await t.test(
      'inverse advances legacy counters once per scope and folds exact v2 state without losing data',
      async () => {
        const before = await token2();
        await app.query(
          "INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES('profile133-v3',$1)",
          [seal({ synthetic: 'v3' })],
        );
        assert.equal(
          await token2(),
          before,
          'numeric v2 state is deliberately not used by the v3 cache capability',
        );
        const data = await immutableRows(admin);
        assert.deepEqual(await f.change(2), { previous: 3, target: 2, changed: true });
        assert.equal(await token2(), before + 1n);
        assert.deepEqual(await immutableRows(admin), data);
        await f.change(3);
        assert.deepEqual(await f.change(1), { previous: 3, target: 1, changed: true });
        assert.equal(await readRevisionProfile(app, runtime.application.user), 1);
        assert.equal(
          BigInt(
            (
              await app.query(revisionSelect('n', { revisionProfile: 1 }), [
                'platform',
                f.profile.platformStoreId,
              ])
            ).rows[0].n,
          ),
          before + 2n,
          'inverse to v1 conservatively invalidates then folds old state',
        );
        assert.deepEqual(await immutableRows(admin), data);
        await f.change(3);
        assert.equal(await readRevisionProfile(app, runtime.application.user), 3);
      },
    );
    await t.test(
      'helper, frozen state, policies, FK enforcement and application authority remain attested',
      async () => {
        for (const sql of [
          'ALTER TABLE ' + TABLE + ' DISABLE ROW LEVEL SECURITY',
          'ALTER TABLE ' + TABLE + ' DISABLE TRIGGER ALL',
          'ALTER TABLE cartoteca_catalog.stores DISABLE TRIGGER ALL',
          'ALTER TABLE ' + TABLE + ' DROP CONSTRAINT revision_state_store_fkey',
          'GRANT UPDATE ON ' + TABLE + ' TO ' + q(runtime.application.user),
          functionSQL().replace('Store catalog missing', 'changed guard'),
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
          assert.equal(await readRevisionProfile(app, runtime.application.user), 3);
        }
        await assert.rejects(
          app.query('UPDATE ' + TABLE + ' SET revision=revision+1'),
          (e) => e.code === '42501',
        );
        const rows = await immutableRows(admin);
        await admin.query('BEGIN');
        try {
          await app.query(
            "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
            [f.profile.platformStoreId],
          );
          await assert.rejects(
            app.query(
              "UPDATE cartoteca_platform.telegram_runtime SET _store_id='foreign-profile133' WHERE key='profile133-v3'",
            ),
          );
        } finally {
          await admin.query('ROLLBACK');
        }
        assert.deepEqual(await immutableRows(admin), rows);
      },
    );
    await t.test(
      'a direct inverse refuses an RLS-filtered operator before catalog-wide invalidation',
      async () => {
        const role = 'revision133_limited';
        await admin.query('CREATE ROLE ' + q(role) + ' NOLOGIN');
        await admin.query('GRANT USAGE ON SCHEMA cartoteca_catalog TO ' + q(role));
        try {
          await admin.query('SET ROLE ' + q(role));
          await admin.query('BEGIN');
          try {
            await assert.rejects(
              prepareCompoundProfile(admin, runtime.application.user, { target: 2 }),
              (e) => e.code === 'POSTGRES_REVISION_OPERATOR_AUTHORITY_REQUIRED',
            );
          } finally {
            await admin.query('ROLLBACK');
            await admin.query('RESET ROLE');
          }
        } finally {
          await admin.query('DROP OWNED BY ' + q(role));
          await admin.query('DROP ROLE ' + q(role));
        }
        assert.equal(await readRevisionProfile(app, runtime.application.user), 3);
      },
    );
    await t.test(
      'a live server guardian denies both dry-run and apply before profile DDL',
      async () => {
        const secret = path.join(runtime.root, 'synthetic-profile133-secret');
        fs.writeFileSync(secret, runtime.application.password, { mode: 0o600 });
        const env = {
          CARTOTECA_STORAGE_BACKEND: 'postgres',
          CARTOTECA_POSTGRES_PROFILE: 'production-v1',
          CARTOTECA_PG_PASSWORD_FILE: path.join(runtime.root, 'synthetic-owner-secret'),
          CARTOTECA_PG_APPLICATION_PASSWORD_FILE: secret,
          BACKUP_POSTGRES_APPLICATION_ROLE: runtime.application.user,
        };
        const statements = [],
          deps = {
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
        const key = advisoryKey('cartoteca:postgres-server:v1:' + f.profile.platformStoreId);
        try {
          await guardian.query('SELECT pg_advisory_lock($1::bigint)', [key]);
          for (const mode of ['--dry-run', '--apply'])
            await assert.rejects(
              operateCompoundProfile(['--offline', mode], env, deps, 2),
              (e) => e.code === 'POSTGRES_REVISION_RUNTIME_ACTIVE',
            );
          assert.equal(
            statements.some((sql) => /^(CREATE|ALTER|DROP)/.test(sql)),
            false,
          );
        } finally {
          await guardian.end();
        }
        assert.equal(await readRevisionProfile(app, runtime.application.user), 3);
        const dry = await operateCompoundProfile(['--offline', '--dry-run'], env, deps, 2);
        assert.equal(dry.rolledBack, true);
        assert.equal(await readRevisionProfile(app, runtime.application.user), 3);
      },
    );
    await t.test(
      'v3 backup reconstructs the known profile on a fresh database without copying xid or snapshots',
      async () => {
        const keyFile = path.join(runtime.root, 'backup133.key');
        createBackupKey(keyFile);
        const backup = await createPostgresBackup({
          source: f.assets,
          directory: path.join(runtime.root, 'archives'),
          keyFile,
          connection: runtime.admin,
          applicationRole: runtime.application.user,
        });
        await withVerifiedPostgresArchive(backup.file, keyFile, {}, async ({ manifest }) =>
          assert.deepEqual(manifest.revisionProfile, { version: 3 }),
        );
        const database = 'revision133_' + randomBytes(10).toString('hex');
        await admin.query('CREATE DATABASE ' + q(database) + ' OWNER ' + q(runtime.admin.user));
        const target = new Client({ ...runtime.admin, database });
        try {
          const restored = path.join(runtime.root, 'restored133');
          await restorePostgresBackup(backup.file, keyFile, restored, {
            connection: { ...runtime.admin, database },
            applicationRole: runtime.application.user,
            offline: true,
            upgradeCopy: true,
          });
          await target.connect();
          assert.equal(await readRevisionProfile(target, runtime.application.user), 3);
          assert.deepEqual(await immutableRows(target), await immutableRows(admin));
          assert.equal(
            (await target.query('SELECT count(*)::int AS n FROM ' + TABLE)).rows[0].n,
            0,
          );
          assert.equal(
            (await preparedPostgresProfile({ ...runtime.application, database }, restored))
              .postgresRevisionProfile,
            3,
          );
        } finally {
          await target.end();
          await admin.query('DROP DATABASE ' + q(database) + ' WITH (FORCE)');
        }
      },
    );
  },
);
