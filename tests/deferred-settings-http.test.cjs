const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createServer } = require('../serve.cjs');
test('legacy shell versions its protected background module and rejects anonymous or stale imports', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cartoteca-legacy-settings-'));
  const server = createServer({ dataDir: dir, sendMail: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const login = await fetch(base + '/api/auth/setup', { method: 'POST',
    headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'settings@example.test', password: 'Synthetic-legacy-password-2026' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/', { headers: { Cookie: cookie } });
  const html = await response.text();
  const version = html.match(/name="cartoteca-build" content="([a-f0-9]{16})"/)[1];
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const method of ['GET', 'HEAD']) {
    const current = await fetch(base + '/app-settings.js?v=' + version, { method, headers: { Cookie: cookie } });
    assert.equal(current.status, 200); assert.equal(current.headers.get('cache-control'), 'no-store');
    if (method === 'HEAD') assert.equal(await current.text(), '');
    assert.equal((await fetch(base + '/app-settings.js?v=stale', { method, headers: { Cookie: cookie } })).status, 409);
    assert.equal((await fetch(base + '/app-settings.js?v=' + version, { method })).status, 401);
  }
});
