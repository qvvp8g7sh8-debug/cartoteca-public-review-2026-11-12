'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const {
  createBackupKey,
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
} = require('../src/server/infrastructure/backup/service.cjs');
const { identifier: q } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { codec } = require('../src/server/migrations/prepare-cabinet-records.cjs');
const {
  preparePostgresPackage145,
  MARKER,
} = require('../src/server/infrastructure/postgres/package-prepare145.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  verifyAssetProfile,
} = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');
test(
  'one offline145 package commits three components once, reconciles lost reply, restores backup and inverses CURRENT data',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t, { cabinetVersion: 1 });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-package145-'));
    t.after(() => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.match(path.basename(root), /^cartoteca-package145-/);
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(root, 'platform'));
    const platformKey = randomBytes(32);
    fs.writeFileSync(path.join(root, 'platform/platform.key'), platformKey, {
      flag: 'wx',
      mode: 0o600,
    });
    await f.admin.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [f.platform.storeId],
    );
    for (const id of f.organizations)
      await f.admin.query(
        'UPDATE cartoteca_platform.organizations SET value=$1 WHERE _store_id=$2 AND id=$3',
        [codec(platformKey).encode({ id, name: 'Synthetic' }), f.platform.storeId, id],
      );
    const keys = new Map();
    for (let n = 0; n < f.cabinets.length; n++) {
      const scope = f.cabinets[n],
        folder = n ? path.join(root, 'tenants', scope.organizationId) : root;
      fs.mkdirSync(folder, { recursive: true });
      const key = randomBytes(32);
      keys.set(scope.storeId, key);
      fs.writeFileSync(path.join(folder, 'encryption.key'), key, { flag: 'wx', mode: 0o600 });
      f.a.c[n].prepare('INSERT INTO patients(id,value) VALUES(?,?)').run(
        'p',
        codec(key).encode({
          id: 'p',
          name: 'Synthetic',
          visits: [{ id: 'v', date: '2020-01-01', procedure: 'Untouched', photos: [] }],
          appointments: [
            { id: 'a', date: '2035-01-01', time: '10:00', duration: 30, service: 'Synthetic' },
          ],
        }),
      );
    }
    await f.a.owner.close();
    const runtimeFile = path.join(root, 'postgresql-runtime.json'),
      gate = path.join(root, '.restore-in-progress');
    fs.writeFileSync(runtimeFile, JSON.stringify(f.identity.lineage), { flag: 'wx', mode: 0o600 });
    const admin = f.admin,
      options = { client: admin, directory: root, applicationRole: f.runtime.application.user };
    await assert.rejects(preparePostgresPackage145(options));
    fs.writeFileSync(gate, MARKER, { flag: 'wx', mode: 0o600 });
    let loseReply = true;
    const lostCommit = {
      async query(...args) {
        const result = await admin.query(...args);
        if (args[0] === 'COMMIT' && loseReply) {
          loseReply = false;
          throw Error('Synthetic lost COMMIT reply');
        }
        return result;
      },
    };
    await assert.rejects(
      preparePostgresPackage145({ ...options, client: lostCommit }),
      (error) => error.outcomeUnknown === true,
    );
    assert.equal(fs.existsSync(gate), true);
    assert.equal(JSON.parse(fs.readFileSync(runtimeFile)).cabinetSchema, 1);
    assert.ok(
      (
        await admin.query("SELECT version FROM cartoteca_catalog.stores WHERE kind='cabinet'")
      ).rows.every((row) => Number(row.version) === 2),
    );
    const count = Number(
      (await admin.query('SELECT count(*) n FROM cartoteca_platform.assistant_state_schema'))
        .rows[0].n,
    );
    assert.equal(count, 1);
    await assert.rejects(preparePostgresPackage145(options), /journal exists/);
    const forward = await preparePostgresPackage145({ ...options, resumeCommitted: true });
    assert.equal(forward.passed, true);
    assert.equal(forward.resumedCommittedPublication, true);
    assert.equal(forward.cabinetSchema, 2);
    assert.equal(forward.assistant.backend, 'rows-v1');
    assert.equal(fs.existsSync(gate), false);
    const prepared = JSON.parse(fs.readFileSync(runtimeFile));
    await verifyAssetProfile(admin, prepared);
    assert.equal(
      Number(
        (await admin.query('SELECT count(*) n FROM cartoteca_platform.assistant_state_schema'))
          .rows[0].n,
      ),
      count,
    );
    await t.test(
      'prepared rows compose both the planning platform and full assistant; file mode stays fail-closed',
      async () => {
        const {
          createPostgresCoordinator,
        } = require('../src/server/infrastructure/postgres/coordinator.cjs');
        const { createPlatformStore } = require('../src/server/application/platform.cjs');
        for (const [backend, assistantComposition] of [
          ['file', false],
          ['rows-v1', false],
          ['rows-v1', true],
        ]) {
          const owner = createPostgresCoordinator({
            connection: f.runtime.application,
            allowBlocking: true,
            revisionProfile: 3,
          });
          let platform;
          try {
            await owner.ready();
            owner.verifyProfile({ ...f.identity, markerHash: digest(prepared), lineage: prepared });
            const compose = () =>
              createPlatformStore(path.join(root, 'platform'), {
                databaseOwner: owner,
                notificationSchema: 19,
                sharedCabinetWrites: true,
                assistantStateBackend: backend,
                assistantComposition,
                administrationComposition: false,
                notificationChannelProjection: true,
                scheduledNotifications: false,
                scheduleStartupReconcile: false,
                notificationMaintenanceEnabled: false,
                paymentNetworkEnabled: false,
              });
            if (backend === 'file') {
              assert.throws(compose, /Prepared assistant rows require rows-v1 backend/);
            } else {
              platform = compose();
              assert.equal(Boolean(platform.assistant), assistantComposition);
              assert.ok(owner.open(f.platform).catalog.tables.assistant_reservations);
              if (assistantComposition)
                assert.equal(platform.assistant.runtimeStats().dialogues.active, 0);
            }
          } finally {
            platform?.close();
            owner.closeSync();
            await owner.close();
          }
        }
      },
    );
    const backupRoot = root + '-backup',
      keyFile = path.join(backupRoot, 'backup.key'),
      destination = path.join(backupRoot, 'restored'),
      database = 'package145_' + randomBytes(8).toString('hex');
    fs.mkdirSync(backupRoot);
    t.after(() => {
      assert.equal(path.dirname(backupRoot), path.resolve(os.tmpdir()));
      assert.match(path.basename(backupRoot), /^cartoteca-package145-/);
      fs.rmSync(backupRoot, { recursive: true, force: true });
    });
    createBackupKey(keyFile);
    const archive = await createV2Backup({
      source: root,
      directory: path.join(backupRoot, 'archives'),
      keyFile,
      connection: f.runtime.admin,
    });
    assert.equal(archive.verified, true);
    assert.equal((await verifyV2Backup(archive.file, keyFile)).patients, 2);
    await admin.query('CREATE DATABASE ' + q(database) + ' OWNER ' + q(f.runtime.admin.user));
    try {
      const restored = await restoreV2Backup(archive.file, keyFile, destination, {
        connection: { ...f.runtime.admin, database },
        offline: true,
      });
      assert.equal(restored.sessionsRevoked, true);
      const client = new Client({ ...f.runtime.admin, database });
      await client.connect();
      try {
        const runtime = JSON.parse(
          fs.readFileSync(path.join(destination, 'postgresql-runtime.json')),
        );
        await verifyAssetProfile(client, runtime);
        assert.deepEqual(runtime.cabinetTemplates, prepared.cabinetTemplates);
        for (const table of [
          'patients',
          'cabinet_patient_records',
          'cabinet_history_entries',
          'cabinet_history_manifests',
        ]) {
          const sql =
            'SELECT * FROM cartoteca_cabinet.' +
            q(table) +
            ' ORDER BY _store_id,' +
            (table === 'patients'
              ? 'id'
              : table === 'cabinet_patient_records'
                ? 'kind,id'
                : table === 'cabinet_history_entries'
                  ? 'patient_id,audience,stream,rank'
                  : 'patient_id,audience,stream');
          assert.deepEqual((await client.query(sql)).rows, (await admin.query(sql)).rows);
        }
        assert.equal(
          Number(
            (await client.query('SELECT count(*) n FROM cartoteca_platform.assistant_state_schema'))
              .rows[0].n,
          ),
          1,
        );
      } finally {
        await client.end();
      }
    } finally {
      await admin.query('DROP DATABASE ' + q(database) + ' WITH (FORCE)');
    }
    const scope = f.cabinets[0],
      crypto = codec(keys.get(scope.storeId));
    const row = (
      await admin.query(
        "SELECT value FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1 AND kind='appointment' AND id='a'",
        [scope.storeId],
      )
    ).rows[0];
    const changed = { ...crypto.decode(row.value), notes: 'Current post-prepare change' };
    await admin.query(
      "UPDATE cartoteca_cabinet.cabinet_patient_records SET value=$1 WHERE _store_id=$2 AND kind='appointment' AND id='a'",
      [crypto.encode(changed), scope.storeId],
    );
    fs.writeFileSync(gate, MARKER, { flag: 'wx', mode: 0o600 });
    const originalWrite = fs.writeFileSync;
    let failReceipt = true;
    fs.writeFileSync = function (filename, ...args) {
      if (String(filename).includes('package145-inverse-result.json.next-') && failReceipt) {
        failReceipt = false;
        throw Error('Synthetic completion receipt failure');
      }
      return originalWrite.call(this, filename, ...args);
    };
    try {
      await assert.rejects(
        preparePostgresPackage145({ ...options, rollback: true }),
        /Synthetic completion receipt failure/,
      );
    } finally {
      fs.writeFileSync = originalWrite;
    }
    assert.equal(fs.existsSync(gate), false);
    assert.equal(JSON.parse(fs.readFileSync(runtimeFile)).cabinetSchema, 1);
    const inverse = await preparePostgresPackage145({
      ...options,
      rollback: true,
      resumeCommitted: true,
    });
    assert.equal(inverse.passed, true);
    assert.equal(inverse.currentDataInverse, true);
    assert.equal(inverse.assistant.backend, 'file');
    const current = (
      await admin.query(
        'SELECT value FROM cartoteca_cabinet.patients WHERE _store_id=$1 AND id=$2',
        [scope.storeId, 'p'],
      )
    ).rows[0];
    assert.deepEqual(crypto.decode(current.value).appointments, [changed]);
    assert.equal(crypto.decode(current.value).visits[0].procedure, 'Untouched');
    assert.equal(
      Number(
        (await admin.query('SELECT count(*) n FROM cartoteca_cabinet.cabinet_patient_records'))
          .rows[0].n,
      ),
      0,
    );
    assert.equal(
      Number(
        (await admin.query('SELECT count(*) n FROM cartoteca_platform.assistant_state_schema'))
          .rows[0].n,
      ),
      0,
    );
    await verifyAssetProfile(admin, JSON.parse(fs.readFileSync(runtimeFile)));
    assert.equal(inverse.dataCopiesCreated, 0);
    assert.equal(digest(f.identity.lineage), inverse.afterRuntimeHash);
  },
);
