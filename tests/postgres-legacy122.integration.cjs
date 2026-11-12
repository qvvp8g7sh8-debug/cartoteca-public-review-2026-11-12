const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { createStorage } = require('../storage.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
const { scrypt, passwordOptions } = require('../src/server/infrastructure/platform-constants.cjs');

test(
  'legacy root cabinet migrates to actual PostgreSQL and remains readable after isolated HTTP login',
  { timeout: 120000 },
  async (t) => {
    const fixture = await nativeIsolatedFixture(t, { organizations: 0 });
    const email = 'synthetic-legacy-root@synthetic.test';
    const password = 'Synthetic-legacy-root-password';
    const salt = randomBytes(16).toString('hex');
    const imported = fixture.platform.importLegacyOwner({
      email,
      displayName: 'Synthetic legacy owner',
      organizationName: 'Synthetic legacy clinic',
      salt,
      passwordHash: (await scrypt(password, salt, 64, passwordOptions)).toString('hex'),
    });
    assert.equal(fixture.platform.organization(imported.organizationId).legacyData, true);
    const patientId = randomUUID();
    const seed = createStorage(fixture.directory);
    try {
      seed.write({
        revision: 0,
        services: [],
        patients: [
          {
            id: patientId,
            firstName: 'Synthetic',
            lastName: 'Legacy',
            name: 'Synthetic Legacy',
            createdBy: imported.accountId,
            notes: 'Synthetic root cabinet history',
            visits: [],
            appointments: [
              {
                id: 'synthetic-root-appointment',
                staffId: imported.accountId,
                roomId: 'main',
                date: '2035-01-02',
                time: '11:00',
                duration: 30,
                service: 'Synthetic legacy service',
              },
            ],
          },
        ],
      });
    } finally {
      seed.close();
    }
    const sourceClose = fixture.platform.close;
    let sourceClosed = false;
    fixture.platform.close = () => {
      if (!sourceClosed) {
        sourceClosed = true;
        sourceClose();
      }
    };
    fixture.platform.close();
    const runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin);
    const destination = path.join(runtime.root, 'legacy-root-assets');
    let server;
    await admin.connect();
    try {
      const migrated = await migratePostgresData({
        source: fixture.directory,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        offline: true,
        dryRun: false,
      });
      assert.equal(migrated.sourceUnchanged, true);
      const marker = JSON.parse(
        fs.readFileSync(path.join(destination, 'postgresql-runtime.json'), 'utf8'),
      );
      const root = marker.stores.find(
        (store) => store.kind === 'cabinet' && store.relativeDirectory === '.',
      );
      assert.equal(root.storeId, marker.rootCabinetStoreId);
      assert.equal(root.organizationId, imported.organizationId);
      assert.equal(
        marker.stores.filter(
          (store) => store.kind === 'cabinet' && store.organizationId === imported.organizationId,
        ).length,
        1,
      );
      assert.equal(fs.existsSync(path.join(destination, 'cabinet.sqlite')), false);
      assert.equal(
        fs.existsSync(path.join(destination, 'tenants', imported.organizationId)),
        false,
        'legacy reads retain the registered root rather than provisioning a second tenant',
      );
      server = await createIsolatedServer({
        ...fixture.config,
        dataDir: destination,
        storageBackend: 'postgres',
        postgres: runtime.application,
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = 'http://127.0.0.1:' + server.address().port;
      const login = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
        body: JSON.stringify({ email, password }),
      });
      const identity = await login.json();
      assert.equal(login.status, 200, JSON.stringify(identity));
      assert.equal(identity.user.id, imported.accountId);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const headers = {
        cookie,
        'x-cartoteca-account-id': imported.accountId,
        'x-cartoteca-organization-id': imported.organizationId,
      };
      const response = await fetch(base + '/api/cabinet/patient?id=' + patientId, { headers });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.patients[0].id, patientId);
      assert.equal(body.patients[0].notes, 'Synthetic root cabinet history');
      const calendar = await fetch(base + '/api/cabinet/calendar?from=2035-01-01&to=2035-01-07', {
        headers,
      });
      const schedule = await calendar.json();
      assert.equal(calendar.status, 200, JSON.stringify(schedule));
      assert.equal(schedule.appointments[0].id, 'synthetic-root-appointment');
      assert.equal(
        fs.existsSync(path.join(destination, 'tenants', imported.organizationId)),
        false,
      );
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await admin.end();
      await runtime.close();
    }
  },
);
