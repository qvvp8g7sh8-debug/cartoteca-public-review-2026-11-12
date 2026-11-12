const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
function fingerprint(directory) {
  const hash = createHash('sha256');
  function visit(root, relative = '') {
    for (const entry of fs
      .readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative + entry.name,
        file = path.join(root, entry.name);
      if (entry.isDirectory()) visit(file, name + '/');
      else {
        // Read-only SQLite may create SHM read marks and a zero-byte WAL.
        // Neither contains committed rows; every nonempty WAL is fingerprinted.
        if (
          name.endsWith('.sqlite-shm') ||
          (name.endsWith('.sqlite-wal') && fs.statSync(file).size === 0)
        )
          continue;
        hash.update(name);
        hash.update(fs.readFileSync(file));
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}
function headers(actor) {
  return {
    cookie: 'cartoteca_v2_session=' + actor.token,
    'x-cartoteca-account-id': actor.accountId,
    'x-cartoteca-organization-id': actor.organizationId,
  };
}
async function request(base, actor, url, options = {}) {
  const res = await fetch(base + url, {
    ...options,
    headers: { ...headers(actor), ...options.headers },
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}
test(
  'actual PostgreSQL preserves source, account identity, five calendar reads and manual save/replay through isolated HTTP',
  { timeout: 120000 },
  async (t) => {
    const f = await nativeIsolatedFixture(t, { organizations: 2 });
    const [actor, foreign] = f.actors;
    const closeSource = f.platform.close;
    let sourceClosed = false;
    f.platform.close = () => {
      if (!sourceClosed) {
        sourceClosed = true;
        closeSource();
      }
    };
    const seed = createStorage(path.join(f.directory, 'tenants', actor.organizationId));
    try {
      const state = seed.read();
      state.patients[0].appointments = [
        {
          id: 'synthetic-calendar-appointment',
          staffId: actor.accountId,
          roomId: 'main',
          date: '2035-01-02',
          time: '10:00',
          duration: 30,
          service: 'Synthetic service',
        },
      ];
      seed.write(state);
    } finally {
      seed.close();
    }
    f.platform.close();
    const before = fingerprint(f.directory);
    const runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin);
    await admin.connect();
    const destination = path.join(runtime.root, 'assets');
    let owner, platform, cabinet, server;
    try {
      const result = await migratePostgresData({
        source: f.directory,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        dryRun: false,
        offline: true,
      });
      assert.equal(result.sourceUnchanged, true);
      assert.equal(result.cutover, false);
      assert.equal(fingerprint(f.directory), before);
      const config = {
        ...f.config,
        dataDir: destination,
        storageBackend: 'postgres',
        postgres: runtime.application,
      };
      const options = await initializePostgresOwner(config);
      owner = options.databaseOwner;
      platform = createPlatformStore(path.join(destination, 'platform'), {
        notificationSchema: 11,
        databaseOwner: owner,
      });
      assert.equal(platform.session(actor.token).accountId, actor.accountId);
      const auth = await platform.login(
        'native-owner-0@synthetic.test',
        'Synthetic-native-isolation-password',
      );
      assert.equal(platform.session(auth.token).accountId, actor.accountId);
      cabinet = createStorage(path.join(destination, 'tenants', actor.organizationId), {
        databaseOwner: owner,
        databaseRoot: destination,
        photoOrganizationId: actor.organizationId,
      });
      const original = cabinet.read();
      assert.equal(original.patients[0].id, actor.patientId);
      cabinet.close();
      cabinet = null;
      platform.close();
      platform = null;
      await owner.close();
      owner = null;
      server = await createIsolatedServer(config);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = 'http://127.0.0.1:' + server.address().port;
      const paths = [
        '/api/cabinet/bootstrap?paged=1',
        '/api/cabinet/directory',
        '/api/cabinet/patient?id=' + actor.patientId,
        '/api/cabinet/calendar?from=2035-01-01&to=2035-01-07',
        '/api/cabinet/operation?id=synthetic-unknown&statusOnly=1',
      ];
      for (const url of paths) {
        const got = await request(base, actor, url);
        assert.equal(got.status, 200, JSON.stringify({ url, body: got.body }));
        const denied = await request(base, actor, url, {
          headers: { cookie: headers(foreign).cookie },
        });
        assert.equal(denied.status, 428);
        assert.equal(denied.body.code, 'AUTH_CONTEXT_CHANGED');
      }
      assert.equal(
        (await request(base, actor, '/api/cabinet/patient?id=' + foreign.patientId)).status,
        404,
      );
      for (const to of ['2035-01-07', '2035-01-31']) {
        const calendar = await request(
          base,
          actor,
          '/api/cabinet/calendar?from=2035-01-01&to=' + to,
        );
        assert.equal(calendar.status, 200);
        assert.equal(calendar.body.appointments.length, 1);
        assert.equal(calendar.body.appointments[0].id, 'synthetic-calendar-appointment');
      }
      const operation = randomUUID(),
        patient = original.patients[0],
        next = { ...patient, notes: 'Synthetic manual correction' };
      const save = {
        method: 'PATCH',
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
          'X-Cartoteca-Operation': operation,
        },
        body: JSON.stringify({
          revision: original.revision,
          patients: [{ id: patient.id, before: patient, after: next }],
          services: [],
        }),
      };
      const saved = await request(base, actor, '/api/cabinet/changes', save);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const replay = await request(base, actor, '/api/cabinet/changes', save);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.revision, saved.body.revision);
      const proof = await request(
        base,
        actor,
        '/api/cabinet/operation?statusOnly=1&id=' + operation,
      );
      assert.equal(proof.body.status, 'committed');
      assert.equal(proof.body.revision, saved.body.revision);
      assert.equal(
        (await request(base, actor, '/api/cabinet/patient?id=' + actor.patientId)).body.patients[0]
          .notes,
        next.notes,
      );
      const marker = JSON.parse(
        fs.readFileSync(path.join(destination, 'postgresql-runtime.json'), 'utf8'),
      );
      await admin.query(
        'UPDATE cartoteca_platform.accounts SET global_admin=1 WHERE _store_id=$1 AND id=$2',
        [marker.platformStoreId, actor.accountId],
      );
      try {
        for (const url of paths) assert.equal((await request(base, actor, url)).status, 403, url);
        assert.equal((await request(base, actor, '/api/admin/overview')).status, 200);
      } finally {
        await admin.query(
          'UPDATE cartoteca_platform.accounts SET global_admin=0 WHERE _store_id=$1 AND id=$2',
          [marker.platformStoreId, actor.accountId],
        );
      }
      await admin.query(
        "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND account_id=$2",
        [marker.platformStoreId, actor.accountId],
      );
      for (const url of paths) assert.equal((await request(base, actor, url)).status, 401, url);
      const sourceAfter = fingerprint(f.directory);
      assert.equal(sourceAfter, before);
      const sqlite = [];
      function noSqlite(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, e.name);
          if (e.isDirectory()) noSqlite(file);
          else if (/\.sqlite(?:-|$)/.test(e.name)) sqlite.push(file);
        }
      }
      noSqlite(destination);
      assert.deepEqual(sqlite, [], 'PG runtime never creates SQLite sidecars');
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      cabinet?.close();
      platform?.close();
      if (owner) await owner.close();
      await admin.end();
      await runtime.close();
    }
  },
);
