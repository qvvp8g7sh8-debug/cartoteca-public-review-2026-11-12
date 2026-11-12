const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { createConfiguredMultiServer } = require('../src/server/application/max-startup.cjs');
const { gatedRelease } = require('../src/server/application/release-gate.cjs');

test('migration gate overrides all writers and returns the ordinary options unchanged when absent', () => {
  const plain = { notificationSchema: 16 };
  assert.equal(gatedRelease(plain), plain);
  const gated = gatedRelease({
    releaseGate: true,
    maxConnectionsEnabled: true,
    maxAutostart: true,
  });
  for (const name of [
    'telegramAutostart',
    'supportAutostart',
    'maxAutostart',
    'adminEmailAutostart',
    'bookingPublicationAutostart',
    'maxConnectionsEnabled',
    'commonNotificationsEnabled',
    'pushEnabled',
    'pushAutostart',
  ])
    assert.equal(gated[name], false, name);
});

for (const schema of [16, 17])
  test(
    'gated schema ' +
      schema +
      ' starts without reading MAX secrets, blocks every API and preserves sessions and queues',
    async (t) => {
      const f = await staffMaxFixture(t, { schema });
      f.connect(f.users[2], 2);
      f.create();
      const before = f.database.db.prepare('SELECT value FROM staff_max_jobs ORDER BY id').all();
      let providerCalls = 0;
      const server = await createConfiguredMultiServer(
        { dataDir: f.source, production: false, origin: '', pushEnabled: true },
        {
          environment: {
            CARTOTECA_RELEASE_GATE: '1',
            CARTOTECA_MAX_ENABLED: '1',
            CARTOTECA_MAX_SCHEMA: String(schema),
            MAX_PROTECTED_CONFIG: 'synthetic-path-that-must-never-be-opened',
          },
          fetchImpl: async () => {
            providerCalls++;
            throw Error('Provider must not be called');
          },
        },
      );
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        assert.equal((await fetch(base + '/login.html')).status, 200);
        assert.equal((await fetch(base + '/app.js')).status, 401);
        for (const [method, route] of [
          ['GET', '/api/auth/session'],
          ['POST', '/api/auth/login'],
          ['GET', '/api/cabinet'],
          ['POST', '/api/max/webhook'],
          ['GET', '/api/photos/synthetic'],
        ]) {
          const response = await fetch(base + route, {
            method,
            headers: {
              origin: base,
              'x-cartoteca-request': '1',
              cookie: 'cartoteca_v2_session=' + f.users[2].token,
            },
          });
          assert.equal(response.status, 503, method + ' ' + route);
          assert.equal(response.headers.get('retry-after'), '30');
        }
        assert.equal(providerCalls, 0);
        assert.equal(server.startBackground(), false);
        assert.equal(
          f.database.db
            .prepare("SELECT 1 FROM telegram_runtime WHERE key='application-process-roles'")
            .get(),
          undefined,
        );
        assert.deepEqual(
          f.database.db.prepare('SELECT value FROM staff_max_jobs ORDER BY id').all(),
          before,
        );
        assert.equal(f.platform.session(f.users[2].token).accountId, f.users[2].accountId);
        assert.deepEqual(f.database.db.prepare('SELECT * FROM max_runtime_leases').all(), []);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );

test('gate refuses an unprepared schema before secrets or provider access', async (t) => {
  const f = await staffMaxFixture(t, { schema: 15 });
  await assert.rejects(
    createConfiguredMultiServer(
      { dataDir: f.source },
      {
        environment: {
          CARTOTECA_RELEASE_GATE: '1',
          CARTOTECA_MAX_SCHEMA: '16',
          MAX_PROTECTED_CONFIG: 'must-not-open',
        },
        fetchImpl: async () => {
          assert.fail('provider');
        },
      },
    ),
    { status: 503 },
  );
});

test('the production image includes the explicit offline staff MAX preparation command', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /COPY scripts\/backup-v2\.cjs[^\n]*scripts\/prepare-staff-max-upgrade\.cjs/,
  );
});
