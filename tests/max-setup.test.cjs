const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const {
  createMaxProtectedConfig,
} = require('../src/server/infrastructure/max-protected-config.cjs');
const { createMaxSetupServer } = require('../src/server/application/max-setup-server.cjs');
const {
  syntheticMessagePreview,
} = require('../src/server/modules/notifications/notification-message.cjs');
const { MAX_USERNAME } = require('../src/server/modules/notifications/max-connections.cjs');
const { setupProblem } = require('../src/server/modules/notifications/max-setup-diagnostics.cjs');

const syntheticToken = 'synthetic-setup-token-not-a-real-credential';
test('setup diagnostics expose a strict safe reason, never a provider message', () => {
  for (const [error, phase, code] of [
    [{ message: syntheticToken, safeReason: 'tls_certificate' }, 'provider', 'tls_certificate'],
    [{ message: syntheticToken, providerStatus: 401 }, 'provider', 'authorization'],
    [{ message: syntheticToken, safeReason: 'network' }, 'provider', 'network'],
    [{ message: syntheticToken }, 'load', 'protected_config'],
    [{ message: syntheticToken }, 'identity', 'different_bot'],
  ]) {
    const problem = setupProblem(error, phase);
    assert.equal(problem.code, code);
    assert.equal(JSON.stringify(problem).includes(syntheticToken), false);
  }
});
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-max-setup-synthetic-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-max-setup-synthetic-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
test(
  'Windows DPAPI stores no plaintext and preserves webhook secret on explicit token replacement',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const filename = path.join(directory(t), 'private', 'max.dpapi');
    const store = createMaxProtectedConfig(filename);
    assert.equal(store.exists(), false);
    assert.deepEqual(await store.save(syntheticToken), { saved: true });
    assert.equal(fs.readFileSync(filename).includes(Buffer.from(syntheticToken)), false);
    const first = await store.load();
    assert.equal(first.token, syntheticToken);
    await assert.rejects(store.save('synthetic-replacement'), /Confirm replacement/);
    await store.save('synthetic-replacement', { replace: true });
    assert.equal((await store.load()).webhookSecret, first.webhookSecret);
    assert.equal((await store.load()).token, 'synthetic-replacement');
    const damaged = fs.readFileSync(filename);
    damaged[damaged.length - 2] ^= 1;
    fs.writeFileSync(filename, damaged);
    await assert.rejects(store.load());
  },
);
test('protected storage refuses invalid tokens and paths without writing', async (t) => {
  const dir = directory(t);
  const store = createMaxProtectedConfig(path.join(dir, 'max.dpapi'));
  for (const token of ['', 'line\nbreak', 'привет', 'x'.repeat(2049)])
    await assert.rejects(store.save(token));
  assert.equal(store.exists(), false);
  fs.writeFileSync(path.join(dir, 'not-directory'), 'synthetic');
  const invalid = createMaxProtectedConfig(path.join(dir, 'not-directory', 'max.dpapi'));
  assert.throws(() => invalid.exists());
});
test('setup is loopback-only, CSRF protected, secret-free and never verifies/sends on save', async (t) => {
  let value = null,
    writes = 0,
    reads = 0,
    calls = 0;
  const store = {
    exists: () => Boolean(value),
    save: async (token) => {
      writes++;
      value = { token };
    },
    load: async () => {
      reads++;
      return value;
    },
  };
  const server = createMaxSetupServer({
    store,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(new URL(url).pathname, '/me');
      assert.equal(options.method, 'GET');
      return {
        ok: true,
        status: 200,
        json: async () => ({ user_id: 123, username: MAX_USERNAME, is_bot: true }),
      };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(origin);
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const text = await page.text();
  const csrf = text.match(/name="cartoteca-setup" content="([^"]+)"/)[1];
  const post = (route, body = {}, extra = {}) =>
    fetch(origin + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin,
        'x-cartoteca-setup': csrf,
        ...extra,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post('/save', { token: syntheticToken }, { origin: 'https://evil.test' })).status,
    403,
  );
  const foreignHost = await new Promise((resolve, reject) => {
    // fetch normalizes Host; use the real HTTP header for this boundary check.
    const request = require('node:http').request(
      origin,
      { headers: { host: 'evil.test' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal(
    (await post('/save', { token: syntheticToken }, { 'x-cartoteca-setup': 'wrong' })).status,
    403,
  );
  assert.equal((await post('/save', { token: syntheticToken }, { cookie: '' })).status, 403);
  assert.equal(
    (await post('/save', { token: syntheticToken, padding: 'x'.repeat(5000) })).status,
    413,
  );
  assert.equal(writes, 0);
  const saved = await post('/save', { token: syntheticToken });
  assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes(syntheticToken), false);
  assert.equal(calls, 0);
  assert.equal(reads, 0);
  const result = await post('/verify');
  assert.equal((await result.json()).state, 'ready');
  assert.equal(calls, 1);
  const status = await (await post('/state')).text();
  assert.equal(status.includes(syntheticToken), false);
  assert.equal(status.includes('webhookSecret'), false);
  assert.equal((await fetch(origin + '?token=forbidden')).status, 400);
});
test('wrong bot verification and replacement failure disclose neither token nor provider response', async (t) => {
  const store = {
    exists: () => true,
    save: async () => {
      throw Error(syntheticToken);
    },
    load: async () => ({ token: syntheticToken }),
  };
  const server = createMaxSetupServer({
    store,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ user_id: 123, username: 'other_synthetic_bot', is_bot: true }),
    }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(origin);
  const csrf = (await page.text()).match(/name="cartoteca-setup" content="([^"]+)"/)[1];
  for (const route of ['/verify', '/save']) {
    const result = await fetch(origin + route, {
      method: 'POST',
      headers: {
        origin,
        cookie: page.headers.get('set-cookie').split(';')[0],
        'content-type': 'application/json',
        'x-cartoteca-setup': csrf,
      },
      body: JSON.stringify(route === '/save' ? { token: syntheticToken } : {}),
    });
    assert.equal(result.status, 400);
    const text = await result.text();
    assert.equal(text.includes(syntheticToken), false);
    assert.equal(text.includes('other_synthetic_bot'), false);
  }
});
test('message preview uses the delivery renderer, contains only synthetic fields and hides MAX services', () => {
  const value = syntheticMessagePreview();
  assert.match(value.max, /08\.01\.2030 в 14:30/);
  assert.doesNotMatch(value.max, /\/privacy|Услуги:|patient|token/i);
  assert.match(value.telegram, /\/privacy/);
  assert.match(value.repeated, /не меняются/);
});
test('setup UI clears the token, disables overlapping actions and never persists it in browser storage', async (t) => {
  const html = fs.readFileSync(path.join(__dirname, '../src/client/setup/max-setup.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '../src/client/setup/max-setup.js'), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./);
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:1234/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.fetch = async (route, options) => {
    calls.push({ route, options });
    return {
      ok: true,
      json: async () => ({
        saved: route !== '/state',
        label: 'Токен сохранён',
        state: 'saved',
        nickname: MAX_USERNAME,
        preview: syntheticMessagePreview(),
      }),
    };
  };
  dom.window.eval(source);
  await new Promise((resolve) => setImmediate(resolve));
  const input = dom.window.document.querySelector('#token');
  assert.equal(input.type, 'password');
  input.value = syntheticToken;
  dom.window.document
    .querySelector('#setup-form')
    .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(input.value, '');
  assert.equal(dom.window.document.querySelector('#save').disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((x) => x.route === '/save').length, 1);
  assert.equal(
    calls.some((x) => x.route === '/verify'),
    false,
  );
  assert.equal(dom.window.document.body.textContent.includes(syntheticToken), false);
});
