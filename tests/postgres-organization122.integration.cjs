const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { populatedPostgresSource } = require('./helpers/postgres-source122.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const {
  createBackupKey,
  createV2Backup,
} = require('../src/server/infrastructure/backup/service.cjs');
const { readKey } = require('../src/server/infrastructure/backup/snapshot.cjs');
const { decode, seal } = require('../src/server/infrastructure/postgres/organization-policy.cjs');
const {
  prepareOrganizationRestore,
  verifyOrganizationRestore,
  readRestorePlan,
  organizationRestoreStatus,
} = require('../src/server/infrastructure/postgres/organization-restore.cjs');
const {
  applyOrganizationRestore,
  recoverOrganizationRestore,
  rollbackOrganizationRestore,
} = require('../src/server/infrastructure/postgres/organization-switch.cjs');

test(
  'native selective PostgreSQL recovery preserves current identities, ACL, money, assistant and foreign cabinet; crash receipt and rollback remain safe',
  { timeout: 240000 },
  async (t) => {
    const source = await populatedPostgresSource(t);
    const runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin);
    const assets = path.join(runtime.root, 'organization-assets');
    const keyFile = path.join(runtime.root, 'organization-backup.key');
    const [actor, foreign] = source.fixture.actors;
    await admin.connect();
    try {
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
      const platformId = profile.platformStoreId;
      const storeId = (account) =>
        profile.stores.find(
          (row) => row.kind === 'cabinet' && row.organizationId === account.organizationId,
        ).storeId;
      const platformKey = readKey(path.join(assets, 'platform', 'platform.key'));
      const cabinetKey = (account) =>
        readKey(path.join(assets, 'tenants', account.organizationId, 'encryption.key'));
      async function patient(account) {
        const row = (
          await admin.query(
            'SELECT value FROM cartoteca_cabinet.patients WHERE _store_id=$1 AND id=$2',
            [storeId(account), account.patientId],
          )
        ).rows[0];
        return decode(cabinetKey(account), row.value);
      }
      async function notes(account, text) {
        const value = await patient(account);
        await admin.query(
          'UPDATE cartoteca_cabinet.patients SET value=$3 WHERE _store_id=$1 AND id=$2',
          [
            storeId(account),
            account.patientId,
            seal(cabinetKey(account), { ...value, notes: text }),
          ],
        );
      }
      async function protectedRows() {
        const result = {};
        for (const table of [
          'accounts',
          'memberships',
          'subscriptions',
          'billing_wallets',
          'assistant_settings',
          'assistant_grants',
          'assistant_reservations',
        ]) {
          result[table] = (
            await admin.query(
              'SELECT to_jsonb(t) AS row FROM cartoteca_platform.' +
                table +
                ' t WHERE _store_id=$1 ORDER BY to_jsonb(t)::text',
              [platformId],
            )
          ).rows;
        }
        return result;
      }
      async function encrypted(table, where, params) {
        const row = (
          await admin.query(
            'SELECT value FROM cartoteca_platform.' + table + ' WHERE _store_id=$1 AND ' + where,
            [platformId, ...params],
          )
        ).rows[0];
        return decode(platformKey, row.value);
      }
      await notes(actor, 'Historical target notes');
      await notes(foreign, 'Historical foreign notes');
      await admin.query(
        "INSERT INTO cartoteca_cabinet.cabinet_patient_records(_store_id,kind,id,patient_id,position,value) VALUES($1,'appointment','historical-appointment',$2,0,$3)",
        [
          storeId(actor),
          actor.patientId,
          seal(cabinetKey(actor), {
            id: 'historical-appointment',
            staffId: actor.accountId,
            date: '2035-01-02',
            time: '10:00',
            duration: 30,
            service: 'Synthetic appointment',
          }),
        ],
      );
      await admin.query(
        'INSERT INTO cartoteca_platform.telegram_settings(_store_id,organization_id,value) VALUES($1,$2,$3) ON CONFLICT(_store_id,organization_id) DO UPDATE SET value=excluded.value',
        [platformId, actor.organizationId, seal(platformKey, { enabled: true, leadMinutes: 60 })],
      );
      await admin.query(
        'INSERT INTO cartoteca_platform.work_schedule_profiles(_store_id,organization_id,staff_id,value) VALUES($1,$2,$3,$4)',
        [
          platformId,
          actor.organizationId,
          actor.accountId,
          seal(platformKey, { revision: 3, allowSelfEdit: true }),
        ],
      );
      await admin.query(
        "INSERT INTO cartoteca_platform.staff_max_links(_store_id,organization_id,account_id,chat_hash,value) VALUES($1,$2,$3,'synthetic-staff-chat',$4)",
        [
          platformId,
          actor.organizationId,
          actor.accountId,
          seal(platformKey, {
            enabled: true,
            bindingId: 'historical-binding',
            chatId: 'synthetic-only',
          }),
        ],
      );
      await admin.query(
        "INSERT INTO cartoteca_platform.booking_requests(_store_id,id,organization_id,staff_id,request_key,value,status,expires_at,day_key,created_at,revision) VALUES($1,'historical-booking',$2,$3,'synthetic-request',$4,'pending',9999999999999,'2035-01-02',1000,2)",
        [
          platformId,
          actor.organizationId,
          actor.accountId,
          seal(platformKey, { id: 'historical-booking' }),
        ],
      );
      await admin.query(
        "INSERT INTO cartoteca_platform.notification_jobs(_store_id,id,organization_id,patient_id,appointment_id,stamp,callback_hash,value,status,next_at,expires_at,attempt,lease_until) VALUES($1,'historical-notification',$2,$3,'historical-appointment','historical-stamp','historical-callback',$4,'sending',1000,9999999999999,1,9999999999999)",
        [
          platformId,
          actor.organizationId,
          actor.patientId,
          seal(platformKey, { id: 'historical-notification' }),
        ],
      );
      await admin.query(
        'INSERT INTO cartoteca_platform.billing_wallets(_store_id,id,organization_id,balance_microrub) VALUES($1,$2,$3,12345) ON CONFLICT(_store_id,id) DO UPDATE SET balance_microrub=12345',
        [platformId, 'org:' + actor.organizationId, actor.organizationId],
      );
      createBackupKey(keyFile);
      const archive = await createV2Backup({
        source: assets,
        directory: path.join(runtime.root, 'organization-archives'),
        keyFile,
        connection: runtime.admin,
      });
      await notes(actor, 'Current target notes');
      await notes(foreign, 'Current foreign notes');
      const account = (
        await admin.query(
          'SELECT value FROM cartoteca_platform.accounts WHERE _store_id=$1 AND id=$2',
          [platformId, actor.accountId],
        )
      ).rows[0];
      await admin.query(
        'UPDATE cartoteca_platform.accounts SET value=$3 WHERE _store_id=$1 AND id=$2',
        [
          platformId,
          actor.accountId,
          seal(platformKey, {
            ...decode(platformKey, account.value),
            displayName: 'Current account identity',
          }),
        ],
      );
      await admin.query(
        'UPDATE cartoteca_platform.billing_wallets SET balance_microrub=67890 WHERE _store_id=$1 AND id=$2',
        [platformId, 'org:' + actor.organizationId],
      );
      const identities = await protectedRows();
      const jobDirectory = path.join(runtime.root, 'organization-job');
      const prepared = await prepareOrganizationRestore({
        source: assets,
        archive: archive.file,
        keyFile,
        jobDirectory,
        organizationId: actor.organizationId,
        connection: runtime.admin,
      });
      const options = {
        source: assets,
        keyFile,
        jobDirectory,
        confirmation: prepared.id,
        stopped: true,
        connection: runtime.admin,
      };
      const plan = readRestorePlan(jobDirectory, keyFile);
      const marker = path.join(assets, '.organization-restore.json');
      const currentAssets = path.join(assets, 'tenants', actor.organizationId);
      await t.test(
        'prepare is read-only and signed proof verifies via native CLI routing',
        async () => {
          assert.equal((await verifyOrganizationRestore(options)).state, 'prepared');
          assert.equal((await patient(actor)).notes, 'Current target notes');
          assert.equal((await patient(foreign)).notes, 'Current foreign notes');
          assert.deepEqual(await protectedRows(), identities);
          const cli = spawnSync(
            process.execPath,
            [
              path.join(__dirname, '../scripts/restore-organization.cjs'),
              'status',
              '--job',
              jobDirectory,
              '--key',
              keyFile,
            ],
            { encoding: 'utf8', timeout: 10000 },
          );
          assert.equal(cli.status, 0, cli.stderr);
          assert.equal(JSON.parse(cli.stdout).backend, 'postgres');
          await assert.rejects(
            applyOrganizationRestore({ ...options, stopped: false }),
            /Stop ALL/,
          );
          assert.equal(fs.existsSync(marker), false);
        },
      );
      await t.test(
        'actual interruption after first asset rename rolls SQL back; recovery restores prepared assets without replay',
        async () => {
          const rename = fs.renameSync;
          let intercepted = false;
          fs.renameSync = function (from, to) {
            const result = rename.call(this, from, to);
            if (path.resolve(from) === currentAssets && !intercepted) {
              intercepted = true;
              throw Error('Synthetic post-rename interruption');
            }
            return result;
          };
          try {
            await assert.rejects(applyOrganizationRestore(options), /Synthetic post-rename/);
          } finally {
            fs.renameSync = rename;
          }
          assert.equal(intercepted, true);
          assert.equal(fs.existsSync(marker), true);
          assert.equal(fs.existsSync(currentAssets), false);
          assert.equal(
            (
              await admin.query(
                'SELECT count(*) n FROM cartoteca_catalog.restore_jobs WHERE id=$1',
                [prepared.id],
              )
            ).rows[0].n,
            '0',
          );
          assert.equal((await recoverOrganizationRestore(options)).state, 'prepared');
          assert.equal(fs.existsSync(marker), false);
          assert.equal((await patient(actor)).notes, 'Current target notes');
          assert.deepEqual(await protectedRows(), identities);
        },
      );
      await t.test(
        'apply restores only target history; SQL receipt resolves a post-commit journal interruption',
        async () => {
          assert.equal((await applyOrganizationRestore(options)).state, 'activated');
          assert.equal((await patient(actor)).notes, 'Historical target notes');
          assert.equal((await patient(foreign)).notes, 'Current foreign notes');
          assert.deepEqual(
            await protectedRows(),
            identities,
            'UPDATE of organizations must not cascade memberships/wallets',
          );
          assert.equal(
            (await encrypted('telegram_settings', 'organization_id=$2', [actor.organizationId]))
              .enabled,
            false,
          );
          assert.equal(
            (await encrypted('staff_max_links', 'organization_id=$2', [actor.organizationId]))
              .restoredPaused,
            true,
          );
          const schedule = await encrypted('work_schedule_profiles', 'organization_id=$2', [
            actor.organizationId,
          ]);
          assert.equal(schedule.allowSelfEdit, true);
          assert.equal(schedule.revision, 4);
          const notification = (
            await admin.query(
              "SELECT status,lease_until,callback_hash FROM cartoteca_platform.notification_jobs WHERE _store_id=$1 AND id='historical-notification'",
              [platformId],
            )
          ).rows[0];
          assert.equal(notification.status, 'failed');
          assert.equal(notification.lease_until, '0');
          assert.notEqual(notification.callback_hash, 'historical-callback');
          const booking = (
            await admin.query(
              "SELECT status,revision FROM cartoteca_platform.booking_requests WHERE _store_id=$1 AND id='historical-booking'",
              [platformId],
            )
          ).rows[0];
          assert.equal(booking.status, 'expired');
          assert.equal(booking.revision, '3');
          assert.equal(
            (
              await admin.query(
                'SELECT count(*) n FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND organization_id=$2',
                [platformId, actor.organizationId],
              )
            ).rows[0].n,
            '0',
          );
          assert.ok(
            Number(
              (
                await admin.query(
                  'SELECT count(*) n FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND organization_id=$2',
                  [platformId, foreign.organizationId],
                )
              ).rows[0].n,
            ) > 0,
          );
          assert.deepEqual(
            fs.readFileSync(path.join(currentAssets, 'photos', source.photoId + '.enc')),
            source.photoCipher,
          );
          fs.writeFileSync(marker, fs.readFileSync(path.join(jobDirectory, 'switch.json')), {
            flag: 'wx',
            mode: 0o600,
          });
          assert.equal(organizationRestoreStatus(options).state, 'interrupted');
          assert.equal((await recoverOrganizationRestore(options)).state, 'activated');
          assert.equal(fs.existsSync(marker), false);
          assert.equal(
            (
              await admin.query('SELECT phase FROM cartoteca_catalog.restore_jobs WHERE id=$1', [
                prepared.id,
              ])
            ).rows[0].phase,
            'committed',
          );
          await assert.rejects(applyOrganizationRestore(options));
        },
      );
      await t.test(
        'rollback preserves foreign cabinet writes and refuses to erase newer target changes',
        async () => {
          await notes(foreign, 'Foreign write after target restore');
          await notes(actor, 'New target write must survive');
          await assert.rejects(rollbackOrganizationRestore(options), /New target data/);
          assert.equal((await patient(actor)).notes, 'New target write must survive');
          assert.equal(fs.existsSync(marker), false);
          // Restore the exact applied ciphertext, not a newly encrypted equivalent, so the signed stale-write proof becomes valid again.
          const inventory = JSON.parse(
            fs.readFileSync(path.join(jobDirectory, 'candidate', 'inventory.json'), 'utf8'),
          );
          const report = inventory.cabinet.tables.find((row) => row.name === 'patients');
          const row = JSON.parse(
            fs
              .readFileSync(path.join(jobDirectory, 'candidate', report.file), 'utf8')
              .trim()
              .split('\n')[0],
          );
          const valueIndex =
            inventory.cabinet.metadata.tables.patients.columns.findIndex(
              (column) => column.name === 'value',
            ) + 1;
          await admin.query(
            'UPDATE cartoteca_cabinet.patients SET value=$3 WHERE _store_id=$1 AND id=$2',
            [storeId(actor), actor.patientId, Buffer.from(row[valueIndex], 'base64')],
          );
          assert.equal((await rollbackOrganizationRestore(options)).state, 'rolled-back');
          assert.equal((await patient(actor)).notes, 'Current target notes');
          assert.equal((await patient(foreign)).notes, 'Foreign write after target restore');
          assert.deepEqual(await protectedRows(), identities);
          assert.equal(
            (
              await admin.query('SELECT phase FROM cartoteca_catalog.restore_jobs WHERE id=$1', [
                prepared.id,
              ])
            ).rows[0].phase,
            'rolled-back',
          );
          assert.equal(organizationRestoreStatus(options).state, 'rolled-back');
        },
      );
      await t.test('signed plan and candidate byte tampering fail before activation', async () => {
        const nextJob = path.join(runtime.root, 'organization-tamper-job');
        const next = await prepareOrganizationRestore({
          source: assets,
          archive: archive.file,
          keyFile,
          jobDirectory: nextJob,
          organizationId: actor.organizationId,
          connection: runtime.admin,
        });
        const original = fs.readFileSync(path.join(nextJob, 'plan.json'));
        const altered = JSON.parse(original);
        altered.organizationId = foreign.organizationId;
        fs.writeFileSync(path.join(nextJob, 'plan.json'), JSON.stringify(altered));
        await assert.rejects(
          verifyOrganizationRestore({ jobDirectory: nextJob, keyFile }),
          /authentication/,
        );
        fs.writeFileSync(path.join(nextJob, 'plan.json'), original);
        const inventory = JSON.parse(
          fs.readFileSync(path.join(nextJob, 'candidate', 'inventory.json'), 'utf8'),
        );
        const report = inventory.cabinet.tables.find((row) => row.name === 'patients');
        fs.appendFileSync(path.join(nextJob, 'candidate', report.file), '[]\n');
        await assert.rejects(
          applyOrganizationRestore({
            source: assets,
            keyFile,
            jobDirectory: nextJob,
            confirmation: next.id,
            stopped: true,
            connection: runtime.admin,
          }),
        );
        assert.equal(fs.existsSync(marker), false);
        assert.equal((await patient(actor)).notes, 'Current target notes');
        assert.deepEqual(await protectedRows(), identities);
      });
      assert.equal(plan.backend, 'postgres');
    } finally {
      await admin.end();
      await runtime.close();
    }
  },
);
