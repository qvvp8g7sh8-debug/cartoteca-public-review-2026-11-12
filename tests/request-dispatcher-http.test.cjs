const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../auth-store.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');

test('HTTP dispatcher reads paused JSON bodies and checks session after queued admission', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-request-dispatch-'));
  const legacy = createStore(directory);
  await legacy.setup('synthetic@dispatch.test', 'Synthetic-dispatch-password', 'synthetic');
  legacy.write({ revision: 0, patients: [], services: [] });
  legacy.close();
  const server = createMultiServer({
    dataDir: directory,
    processRole: 'web',
    telegramBot: null,
    sendMail: null,
    supportDelivery: {},
    metricsEnabled: true,
  });
  const platform = createPlatformStore(path.join(directory, 'platform'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    platform.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-request-dispatch-'));
    fs.rmSync(directory, { recursive: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Cartoteca-Request': '1' },
    body: JSON.stringify({
      email: 'synthetic@dispatch.test',
      password: 'Synthetic-dispatch-password',
    }),
  });
  assert.equal(login.status, 200);
  const expected = authContextHeaders(await login.json());
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const first = await fetch(origin + '/api/cabinet', { headers: { Cookie: cookie, ...expected } });
  assert.equal(first.status, 200);
  await first.json();
  // Registered after the HTTP handler: inline dispatch would read before logout.
  server.on('request', (req) => {
    if (req.url === '/api/cabinet') platform.logout(cookie.slice(cookie.indexOf('=') + 1));
  });
  const revoked = await fetch(origin + '/api/cabinet', {
    headers: { Cookie: cookie, ...expected },
  });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).patients, undefined);
  const snapshot = server.requestMetrics.snapshot();
  assert.ok(snapshot.resources.requestDispatcher.admitted >= 3);
  assert.equal(snapshot.resources.requestDispatcher.pending, 0);
  assert.doesNotMatch(
    JSON.stringify(snapshot.resources.requestDispatcher),
    /synthetic|dispatch\.test/,
  );
});
