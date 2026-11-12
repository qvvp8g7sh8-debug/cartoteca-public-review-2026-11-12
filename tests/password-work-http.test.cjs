const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { passwordWork } = require('../src/server/infrastructure/password-work.cjs');
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test(
  'HTTP password overload is retryable, preserves login failures and leaves an existing session usable',
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-password-budget-'));
    const platformDirectory = path.join(directory, 'platform');
    let platform, server;
    const gates = [deferred(), deferred()];
    t.after(async () => {
      gates.forEach((gate) => gate.resolve());
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      platform?.close();
      const absolute = path.resolve(directory),
        parent = path.resolve(os.tmpdir());
      assert.equal(path.dirname(absolute), parent);
      assert.ok(path.basename(absolute).startsWith('cartoteca-password-budget-'));
      fs.rmSync(absolute, { recursive: true, force: true });
    });
    platform = createPlatformStore(platformDirectory);
    const email = 'owner@password-budget.synthetic.test',
      password = 'Synthetic-password-budget-2026';
    const owner = await platform.registerOwner({
      email,
      password,
      displayName: 'Synthetic owner',
      organizationName: 'Synthetic organization',
    });
    platform.verifyEmail(owner.verificationToken);
    const login = await platform.login(email, password);
    platform.close();
    platform = null;
    server = createMultiServer({
      dataDir: directory,
      origin: '',
      processRole: 'preflight',
      sendMail: null,
      telegramBot: null,
      supportBot: null,
      supportDelivery: {},
      metricsEnabled: true,
      metricsIntervalMs: 0,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const failures = () => {
      const database = createPlatformDatabase(platformDirectory);
      try {
        return database.db
          .prepare('SELECT coalesce(sum(failures),0) failures FROM login_limits')
          .get().failures;
      } finally {
        database.db.close();
      }
    };
    const before = failures();
    const held = gates.map((gate) =>
      passwordWork.run(() => gate.promise, { key: owner.accountId }),
    );
    const request = (body) =>
      fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: base,
          'X-Cartoteca-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const overloaded = await request({ email, password });
    assert.equal(overloaded.status, 503);
    assert.equal(overloaded.headers.get('retry-after'), '1');
    assert.equal((await overloaded.json()).code, 'AUTH_WORK_CAPACITY');
    assert.equal(failures(), before);
    const current = await fetch(base + '/api/auth/session', {
      headers: { Cookie: 'cartoteca_v2_session=' + login.token },
    });
    assert.equal(current.status, 200);
    const session = await current.json();
    assert.equal(session.user.id, owner.accountId);
    assert.equal(session.user.organizationId, owner.organizationId);
    assert.equal(server.requestMetrics.snapshot().resources.passwordWork.active, 2);
    gates.forEach((gate) => gate.resolve());
    await Promise.all(held);
    const accepted = await request({ email, password });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).user.id, owner.accountId);
    assert.equal(failures(), before);
    const wrong = await request({ email, password: password + '-wrong' });
    assert.equal(wrong.status, 401);
    await wrong.json();
    assert.ok(failures() > before);
  },
);
