const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const {
  prepareRevisionProfile,
} = require('../src/server/infrastructure/postgres/revision-operator132.cjs');
const {
  preparePostgresRuntimeConfig,
} = require('../src/server/infrastructure/postgres/prepared-profile.cjs');
const { initializePostgresOwner } = require('../src/server/infrastructure/postgres/initialize.cjs');
const { createIsolatedServer } = require('../src/server/application/isolated-server.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { readOperationStatus } = require('../src/server/infrastructure/mutation-receipts.cjs');
const { readRuntime } = require('../src/server/infrastructure/postgres/runtime.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');

const headers = (actor) => ({
  cookie: 'cartoteca_v2_session=' + actor.token,
  'x-cartoteca-account-id': actor.accountId,
  'x-cartoteca-organization-id': actor.organizationId,
});
async function request(base, actor, url, options = {}) {
  const response = await fetch(base + url, {
    ...options,
    headers: { ...headers(actor), ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}
function change(state, notes) {
  const patient = state.patients[0];
  return {
    revision: state.revision,
    patients: [{ id: patient.id, before: patient, after: { ...patient, notes } }],
    services: [],
  };
}
function saveOptions(base, body, operation) {
  return {
    method: 'PATCH',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Cartoteca-Request': '1',
      'X-Cartoteca-Operation': operation,
    },
    body: JSON.stringify(body),
  };
}
function beginUpload(base, actor, body, operation) {
  const bytes = Buffer.from(JSON.stringify(body));
  let outgoing;
  const result = new Promise((resolve, reject) => {
    outgoing = http.request(
      new URL('/api/cabinet/changes', base),
      {
        method: 'PATCH',
        headers: {
          ...headers(actor),
          ...saveOptions(base, body, operation).headers,
          'Content-Length': bytes.length,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.once('error', reject);
    outgoing.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
  });
  return {
    result,
    finish: () => outgoing.end(bytes.subarray(Math.floor(bytes.length / 2))),
    cancel: () => outgoing.destroy(),
  };
}

test(
  'actual attested PostgreSQL v2 automatically starts one command child and preserves manual receipt, account and upload-revocation boundaries',
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
    f.platform.close();
    const runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin);
    let server, owner, cabinet, upload;
    try {
      await admin.connect();
      const destination = path.join(runtime.root, 'assets');
      const migration = await migratePostgresData({
        source: f.directory,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        dryRun: false,
        offline: true,
      });
      assert.equal(migration.sourceUnchanged, true);
      await admin.query('BEGIN');
      try {
        await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
        await prepareRevisionProfile(admin, runtime.application.user);
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
      const prepared = await preparePostgresRuntimeConfig({
        ...f.config,
        dataDir: destination,
        storageBackend: 'postgres',
        postgres: runtime.application,
      });
      assert.equal(prepared.postgresRevisionProfile, 2);
      assert.equal(
        prepared.nativeCommandIsolation,
        undefined,
        'activation must follow attestation, not an explicit test override',
      );
      const ownOptions = await initializePostgresOwner({ ...prepared, processRole: 'web' });
      owner = ownOptions.databaseOwner;
      cabinet = createStorage(path.join(destination, 'tenants', actor.organizationId), {
        databaseOwner: owner,
        databaseRoot: destination,
        photoOrganizationId: actor.organizationId,
      });
      assert.equal(
        cabinet.db.revisionProfile,
        2,
        'native owner pins the attested revision profile',
      );
      assert.equal(typeof cabinet.db.localMutationClock, 'number');
      const original = cabinet.read();
      server = await createIsolatedServer(prepared);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = 'http://127.0.0.1:' + server.address().port;
      const topology = server.isolationStatus();
      assert.equal(topology.owner.command.role, 'command');
      assert.equal(
        new Set([
          topology.owner.application.pid,
          topology.owner.background.pid,
          topology.owner.command.pid,
        ]).size,
        3,
      );
      assert.notEqual(topology.owner.command.pid, process.pid);
      assert.equal(topology.commands.activeLimit, 1);
      const session = await request(base, actor, '/api/auth/session');
      assert.equal(session.status, 200);
      assert.equal(session.body.user.id, actor.accountId);
      const patientUrl = '/api/cabinet/patient?id=' + actor.patientId;
      assert.equal((await request(base, actor, patientUrl)).status, 200);
      assert.equal(
        (await request(base, actor, '/api/cabinet/patient?id=' + foreign.patientId)).status,
        404,
      );
      const operation = randomUUID();
      const body = change(original, 'Synthetic PostgreSQL v2 manual command');
      const options = saveOptions(base, body, operation);
      const saved = await request(base, actor, '/api/cabinet/changes', options);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.ok(saved.body.revision > original.revision);
      const replay = await request(base, actor, '/api/cabinet/changes', options);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(
        replay.body.revision,
        saved.body.revision,
        'old-revision same-ID replay cannot commit again',
      );
      const receiptUrl = '/api/cabinet/operation?statusOnly=1&id=' + operation;
      const receipt = await request(base, actor, receiptUrl);
      assert.equal(receipt.body.status, 'committed');
      assert.equal(receipt.body.revision, saved.body.revision);
      assert.deepEqual((await request(base, foreign, receiptUrl)).body, { status: 'unknown' });
      const crossed = await request(base, actor, '/api/cabinet/changes', {
        ...options,
        headers: { ...options.headers, cookie: headers(foreign).cookie },
      });
      assert.equal(crossed.status, 428);
      assert.equal(crossed.body.code, 'AUTH_CONTEXT_CHANGED');
      assert.equal(cabinet.read().patients[0].notes, body.patients[0].after.notes);
      const beforeRevocation = cabinet.read();
      const rejectedOperation = randomUUID();
      upload = beginUpload(
        base,
        actor,
        change(beforeRevocation, 'Synthetic revoked upload must not commit'),
        rejectedOperation,
      );
      const deadline = Date.now() + 3000;
      while (server.isolationStatus().commands.active !== 1) {
        assert.ok(Date.now() < deadline, 'streamed command was not admitted');
        await delay(20);
      }
      // Keep JSON incomplete across a committed database revocation. Parsing and
      // committing after this await must repeat the original server authorization.
      await delay(80);
      const marker = readRuntime(destination);
      await admin.query(
        "UPDATE cartoteca_platform.memberships SET status='suspended' WHERE _store_id=$1 AND account_id=$2",
        [marker.platformStoreId, actor.accountId],
      );
      upload.finish();
      const revoked = await upload.result;
      upload = null;
      assert.equal(revoked.status, 401, JSON.stringify(revoked.body));
      assert.equal((await request(base, actor, patientUrl)).status, 401);
      const final = cabinet.read();
      assert.equal(final.revision, beforeRevocation.revision);
      assert.equal(final.patients[0].notes, beforeRevocation.patients[0].notes);
      assert.deepEqual(
        readOperationStatus(cabinet, { ...actor, role: 'owner' }, rejectedOperation),
        { status: 'unknown' },
      );
    } finally {
      upload?.cancel();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      cabinet?.close();
      await owner?.close();
      await admin.end();
      await runtime.close();
    }
  },
);
