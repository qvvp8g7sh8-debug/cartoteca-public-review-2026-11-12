const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Client } = require('pg');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { notificationSchema } = require('../src/server/application/startup-schema.cjs');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
const { createPostgresServer } = require('../src/server/application/postgres-server.cjs');

// Connect to the synthetic loopback listener while retaining the public Host
// that the real HTTPS reverse proxy forwards to the production application.
function jsonRequest(server, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: route,
        headers: { host: 'synthetic.test', ...headers },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function patientRequest(server, patientId, headers = {}) {
  return jsonRequest(server, '/api/cabinet/patient?id=' + patientId, headers);
}

test(
  'explicit production PG factory starts actual isolated web, read workers and background with a stable private pin',
  { timeout: 120000 },
  async (t) => {
    const fixture = await nativeIsolatedFixture(t, { organizations: 1 });
    const close = fixture.platform.close;
    let closed = false;
    fixture.platform.close = () => {
      if (!closed) {
        closed = true;
        close();
      }
    };
    fixture.platform.close();
    // A release-gated owner requires the same prepared MAX schema as the
    // deployed profile. Prepare only this synthetic source before importing it.
    const source = createPlatformDatabase(path.join(fixture.directory, 'platform'));
    try {
      for (const [file, method] of [
        ['012-max-connections', 'migrateMaxConnections'],
        ['013-notification-queue', 'migrateNotificationQueue'],
        ['014-notification-channels', 'migrateNotificationChannels'],
        ['015-max-inbox', 'migrateMaxInbox'],
      ])
        require('../src/server/migrations/' + file + '.cjs')[method](
          source,
          path.join(fixture.directory, 'platform'),
        );
    } finally {
      source.closeWriter();
      source.db.close();
    }
    fixture.config.notificationSchema = 15;
    assert.equal(notificationSchema({ ...fixture.config, releaseGate: true }, {}), 15);
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin);
    const destination = path.join(runtime.root, 'production-assets');
    let server,
      phase = 'migration';
    const diagnose = (event) => t.diagnostic(JSON.stringify({ phase, ...event }));
    await admin.connect();
    try {
      await migratePostgresData({
        source: fixture.directory,
        destination,
        client: admin,
        applicationRole: runtime.application.user,
        offline: true,
        dryRun: false,
      });
      const create = (environment = {}) =>
        createPostgresServer(
          {
            ...fixture.config,
            dataDir: destination,
            production: true,
            origin: 'https://synthetic.test',
            storageBackend: 'postgres',
            postgresProfile: 'production-v1',
            postgresAllowedHosts: [runtime.application.host],
            postgres: runtime.application,
          },
          { environment },
        );
      phase = 'initial-start';
      server = await create();
      phase = 'duplicate-rejected';
      await assert.rejects(create(), { code: 'POSTGRES_SERVER_ALREADY_RUNNING' });
      phase = 'initial-http';
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const actor = fixture.actors[0];
      const wrongHost = await patientRequest(server, actor.patientId, {
        host: '127.0.0.1:' + server.address().port,
      });
      assert.equal(
        wrongHost.status,
        403,
        'production continues to reject a Host outside APP_ORIGIN',
      );
      const response = await patientRequest(server, actor.patientId, {
        cookie: 'cartoteca_v2_session=' + actor.token,
        'x-cartoteca-account-id': actor.accountId,
        'x-cartoteca-organization-id': actor.organizationId,
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.patients[0].id, actor.patientId);
      const denied = await patientRequest(server, actor.patientId);
      assert.equal(denied.status, 401);
      const status = server.isolationStatus();
      assert.equal(status.closeState, 'open');
      assert.equal(status.owner.state, 'ready');
      for (const role of ['application', 'background']) {
        assert.equal(status.owner[role].ready, true);
        assert.equal(status.owner[role].exited, false);
      }
      assert.equal(status.queries.closed, false);
      assert.equal(status.queries.readyWorkers, 2);
      assert.equal(status.queries.readyWorkers, status.queries.limits.concurrency);
      phase = 'normal-close';
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server = null;
      phase = 'restart-after-close';
      server = await create();
      assert.equal(
        server.isolationStatus().owner.state,
        'ready',
        'confirmed close permits a new production gateway',
      );
      phase = 'guardian-loss';
      const lost = new Promise((resolve) => server.once('backgroundError', resolve));
      const guardian = (
        await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='cartoteca-production-guardian'",
        )
      ).rows;
      assert.equal(guardian.length, 1);
      await admin.query('SELECT pg_terminate_backend($1)', [guardian[0].pid]);
      assert.equal((await lost).code, 'POSTGRES_SERVER_AUTHORITY_LOST');
      assert.notEqual(server.isolationStatus().closeState, 'open');
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server = null;
      phase = 'restart-after-guardian-loss';
      server = await create();
      assert.equal(
        server.isolationStatus().owner.state,
        'ready',
        'lost guardian never reconnects the old server',
      );
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server = null;
      phase = 'gated-start';
      server = await create({ CARTOTECA_RELEASE_GATE: '1' });
      phase = 'gated-http';
      const gated = server.isolationStatus();
      assert.equal(gated.owner.state, 'ready');
      assert.equal(gated.owner.background.ready, true);
      assert.equal(gated.queries.readyWorkers, 2);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const auth = {
        cookie: 'cartoteca_v2_session=' + actor.token,
        'x-cartoteca-account-id': actor.accountId,
        'x-cartoteca-organization-id': actor.organizationId,
      };
      for (const route of [
        '/api/cabinet/bootstrap?paged=1',
        '/api/cabinet/directory',
        '/api/cabinet/patient?id=' + actor.patientId,
        '/api/cabinet/calendar?from=2035-01-01&to=2035-01-07',
        '/api/cabinet/operation?id=synthetic-gated&statusOnly=1',
      ]) {
        const result = await jsonRequest(server, route, auth);
        assert.equal(result.status, 503, route + ': ' + JSON.stringify(result.body));
        assert.equal(result.headers['retry-after'], '30');
      }
      const stateful = await jsonRequest(server, '/api/account/profile', auth);
      assert.equal(
        stateful.status,
        503,
        'the stateful application owner uses the same normalized gate',
      );
    } catch (error) {
      diagnose({ event: 'phase-failed', code: error.code });
      throw error;
    } finally {
      phase = 'final-cleanup';
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
