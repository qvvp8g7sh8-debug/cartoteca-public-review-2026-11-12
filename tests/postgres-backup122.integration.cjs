const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { populatedPostgresSource } = require('./helpers/postgres-source122.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const {
  createBackupKey,
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
} = require('../src/server/infrastructure/backup/service.cjs');
const { archiveKind } = require('../src/server/infrastructure/backup/archive.cjs');
const {
  estimatePostgresBytes,
  withVerifiedPostgresArchive,
} = require('../src/server/infrastructure/postgres/backup-service.cjs');
const { postgresRestoreDrill } = require('../src/server/infrastructure/postgres/backup-drill.cjs');
const { identifier: q } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  verifyAssetProfile,
} = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');

test(
  'native PostgreSQL backup autoformat, verified typed snapshot, tamper AAD, fresh recovery, revocations and actual restore drill',
  { timeout: 180000 },
  async (t) => {
    const source = await populatedPostgresSource(t),
      runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin),
      database = 'restore122_' + crypto.randomBytes(12).toString('hex');
    const assets = path.join(runtime.root, 'assets'),
      restored = path.join(runtime.root, 'restored'),
      archives = path.join(runtime.root, 'archives'),
      keyFile = path.join(runtime.root, 'backup.key');
    let targetCreated = false,
      connected = false;
    t.after(async () => {
      try {
        if (connected && targetCreated)
          await admin.query('DROP DATABASE ' + q(database) + ' WITH (FORCE)');
      } finally {
        await admin.end();
        await runtime.close();
      }
    });
    await admin.connect();
    connected = true;
    await migratePostgresData({
      source: source.fixture.directory,
      destination: assets,
      client: admin,
      offline: true,
      dryRun: false,
    });
    const profile = JSON.parse(
      fs.readFileSync(path.join(assets, 'postgresql-runtime.json'), 'utf8'),
    );
    await admin.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [profile.platformStoreId],
    );
    await admin.query(
      "INSERT INTO cartoteca_platform.billing_wallets(id,organization_id,balance_microrub,reserved_microrub,provider_cost_microrub,charged_microrub,unpaid_charge_microrub,revision,changed_at) VALUES('platform',NULL,123,0,0,0,0,0,0)",
    );
    createBackupKey(keyFile);
    const markerFile = path.join(assets, 'postgresql-runtime.json'),
      markerBytes = fs.readFileSync(markerFile);
    try {
      fs.writeFileSync(
        markerFile,
        JSON.stringify({ ...profile, migrationId: crypto.randomUUID() }),
      );
      await assert.rejects(
        createV2Backup({ source: assets, directory: archives, keyFile, connection: runtime.admin }),
        (error) => error.code === 'POSTGRES_ASSET_PROFILE_MISMATCH',
      );
    } finally {
      fs.writeFileSync(markerFile, markerBytes);
    }

    const estimate = await estimatePostgresBytes({
      source: assets,
      connection: runtime.application,
    });
    assert.ok(Number.isSafeInteger(estimate) && estimate > 0);
    fs.writeFileSync(path.join(assets, '.organization-restore.json'), 'synthetic-incomplete', {
      flag: 'wx',
      mode: 0o600,
    });
    await assert.rejects(
      createV2Backup({ source: assets, directory: archives, keyFile, connection: runtime.admin }),
      /switch is incomplete/,
    );
    fs.unlinkSync(path.join(assets, '.organization-restore.json'));
    const backup = await createV2Backup({
      source: assets,
      directory: archives,
      keyFile,
      connection: runtime.admin,
    });
    assert.match(
      path.basename(backup.file),
      /^cartoteca-v2-pg-[A-Za-z0-9-]+\.enc$/,
      'native backups remain eligible for existing closed retention policies',
    );
    assert.equal(backup.verified, true);
    assert.equal(archiveKind(backup.file), 'postgres');
    assert.equal(backup.photos, 1);
    assert.equal(backup.patients, 2);
    const renamed = path.join(archives, 'renamed.user-file');
    fs.renameSync(backup.file, renamed);
    assert.equal((await verifyV2Backup(renamed, keyFile)).patients, 2);
    await withVerifiedPostgresArchive(renamed, keyFile, {}, async ({ manifest }) => {
      assert.equal(manifest.backend, 'postgres');
      assert.ok(manifest.stores.some((store) => store.metadata.tables.assistant_settings));
      assert.ok(manifest.stores.some((store) => store.kind === 'budget'));
    });
    const damaged = path.join(archives, 'tampered.enc'),
      bytes = fs.readFileSync(renamed);
    bytes[8] ^= 1;
    fs.writeFileSync(damaged, bytes, { flag: 'wx', mode: 0o600 });
    await assert.rejects(verifyV2Backup(damaged, keyFile));
    await admin.query('CREATE DATABASE ' + q(database) + ' OWNER ' + q(runtime.admin.user));
    targetCreated = true;
    await assert.rejects(
      restoreV2Backup(renamed, keyFile, restored, { connection: { ...runtime.admin, database } }),
      /offline/,
    );
    const result = await restoreV2Backup(renamed, keyFile, restored, {
      connection: { ...runtime.admin, database },
      offline: true,
    });
    assert.equal(result.sessionsRevoked, true);
    assert.equal(result.notificationsPaused, true);
    assert.equal(result.cutover, false);
    const recovered = new Client({ ...runtime.admin, database });
    await recovered.connect();
    try {
      const targetProfile = JSON.parse(
        fs.readFileSync(path.join(restored, 'postgresql-runtime.json'), 'utf8'),
      );
      assert.equal((await verifyAssetProfile(recovered, targetProfile)).verified, true);
      assert.notEqual(targetProfile.migrationId, profile.migrationId);
      assert.deepEqual(targetProfile.cabinetTemplates, profile.cabinetTemplates);
      assert.deepEqual(
        fs.readFileSync(path.join(restored, 'platform', 'platform.key')),
        fs.readFileSync(path.join(assets, 'platform', 'platform.key')),
      );
      assert.deepEqual(
        fs.readFileSync(
          path.join(
            restored,
            'tenants',
            source.fixture.actors[0].organizationId,
            'photos',
            source.photoId + '.enc',
          ),
        ),
        source.photoCipher,
      );
      assert.equal(
        Number(
          (await recovered.query('SELECT count(*) n FROM cartoteca_platform.platform_sessions'))
            .rows[0].n,
        ),
        0,
      );
      assert.ok(
        Number(
          (await admin.query('SELECT count(*) n FROM cartoteca_platform.platform_sessions')).rows[0]
            .n,
        ) > 0,
        'source sessions are not revoked',
      );
      assert.equal(
        (
          await recovered.query(
            "SELECT balance_microrub FROM cartoteca_platform.billing_wallets WHERE id='platform'",
          )
        ).rows[0].balance_microrub,
        '123',
      );
      assert.equal(
        (await recovered.query('SELECT mode FROM cartoteca_platform.assistant_settings')).rows[0]
          .mode,
        'off',
      );
      assert.equal(
        Number(
          (await recovered.query('SELECT failures FROM cartoteca_budget.login_limits')).rows[0]
            .failures,
        ),
        2,
      );
      assert.equal(fs.existsSync(path.join(restored, 'platform', 'platform.sqlite')), false);
    } finally {
      await recovered.end();
    }
    const drilled = await postgresRestoreDrill(renamed, keyFile, path.join(runtime.root, 'drill'), {
      connection: runtime.admin,
    });
    assert.equal(drilled.started, true);
    assert.equal(drilled.backend, 'postgres');
    const config = {
      storageBackend: 'postgres',
      source: assets,
      connection: runtime.admin,
      applicationRole: runtime.application.user,
      connectionOptions: { profile: 'local' },
      remote: null,
      cadenceHours: 24,
    };
    const {
      verifyCurrentBackupProfile,
    } = require('../src/server/infrastructure/postgres/backup-profile.cjs');
    const verified = await verifyCurrentBackupProfile(config),
      now = Date.now(),
      statusFile = path.join(runtime.root, 'native-status.json');
    const status = require('../src/server/infrastructure/backup/agent.cjs').publicStatus(
      verified.config,
      [
        {
          state: 'local_only',
          started: now,
          finished: now,
          detail: { file: renamed, localAt: now, drillAt: now },
        },
      ],
      verified.profile,
    );
    fs.writeFileSync(statusFile, JSON.stringify(status));
    const {
      readBackupStatusForProfile,
    } = require('../src/server/infrastructure/backup/operations.cjs');
    assert.equal((await readBackupStatusForProfile(statusFile, config)).state, 'local_only');
    assert.equal(
      (
        await readBackupStatusForProfile(statusFile, {
          ...config,
          connection: { ...runtime.admin, database: 'postgres' },
        })
      ).health,
      'unavailable',
      'an independently authenticated foreign database cannot reuse retained native protection status',
    );
  },
);
