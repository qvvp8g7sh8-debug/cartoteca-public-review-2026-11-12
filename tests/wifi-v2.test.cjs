const test = require('node:test'),
  assert = require('node:assert/strict');
const http = require('node:http'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createMultiServer } = require('../multi-server.cjs'),
  { createPlatformStore } = require('../platform-store.cjs');
const { configuration } = require('../src/server/config.cjs'),
  { wifiAddress, localOrigins } = require('../src/server/http/local-network.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
test('v2 Wi-Fi selects a private adapter and rejects unsafe or production HTTP origins', () => {
  const interfaces = {
    'Wi-Fi': [
      { family: 'IPv4', internal: false, address: '192.168.123.5', netmask: '255.255.255.0' },
    ],
  };
  assert.deepEqual(wifiAddress(interfaces), {
    name: 'Wi-Fi',
    address: '192.168.123.5',
    subnet: '192.168.123.0',
    prefix: 24,
  });
  assert.throws(() => wifiAddress(interfaces, 'missing'));
  assert.throws(() =>
    wifiAddress({ 'Wi-Fi': [{ family: 'IPv4', address: '8.8.8.8', netmask: '255.255.255.0' }] }),
  );
  assert.deepEqual(localOrigins(['http://192.168.123.5:4174', 'http://192.168.123.5:4174']), [
    'http://192.168.123.5:4174',
  ]);
  for (const value of [
    'http://evil.test:4174',
    'http://8.8.8.8:4174',
    'https://192.168.123.5:4174',
    'http://192.168.123.5:4174/path',
    'http://user@192.168.123.5:4174',
    'http://192.168.123.5:4174/',
  ])
    assert.throws(() => localOrigins([value]));
  assert.throws(() =>
    configuration({
      production: true,
      origin: 'https://example.test',
      additionalOrigins: ['http://192.168.123.5:4174'],
    }),
  );
  assert.throws(() =>
    configuration({
      origin: 'http://127.0.0.1:4174',
      additionalOrigins: ['http://192.168.123.5:4174'],
    }),
  );
});
test('v2 LAN and loopback retain authentication and exact Host/Origin protections', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-v2-wifi-')),
    lan = 'http://192.168.123.5:4174';
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'wifi@example.test',
    password: 'Wifi-v2-test-password',
    displayName: 'Owner',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  platform.close();
  const outbox = [];
  const server = createMultiServer({
    dataDir: dir,
    additionalOrigins: [lan],
    sendMail: async (email, url) => outbox.push({ email, url }),
    telegramBot: null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = server.address().port,
    local = 'http://127.0.0.1:' + port;
  const contexts = new Map();
  function request(
    route,
    { host = new URL(lan).host, origin = lan, body, cookie = '', custom = true } = {},
  ) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: route,
          method: body ? 'POST' : 'GET',
          headers: {
            Host: host,
            Origin: origin,
            Cookie: cookie,
            'Content-Type': 'application/json',
            ...contexts.get(cookie),
            ...(custom ? { 'X-Cartoteca-Request': '1' } : {}),
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            const issued = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (route === '/api/auth/login' && res.statusCode === 200 && issued)
              contexts.set(issued, authContextHeaders(JSON.parse(text)));
            resolve({ status: res.statusCode, headers: res.headers, text });
          });
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  assert.equal((await request('/login.html')).status, 200);
  assert.equal((await request('/api/cabinet')).status, 401);
  assert.equal((await request('/api/photos/unknown')).status, 401);
  for (const host of ['evil.test:4174', '192.168.123.6:4174'])
    assert.equal((await request('/login.html', { host })).status, 403);
  const body = { email: 'wifi@example.test', password: 'Wifi-v2-test-password' };
  for (const options of [
    { origin: local },
    { origin: 'http://evil.test' },
    { origin: 'null' },
    { custom: false },
  ])
    assert.equal((await request('/api/auth/login', { body, ...options })).status, 403);
  const login = await request('/api/auth/login', { body });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('/api/cabinet', { cookie })).status, 200);
  assert.equal(
    (await request('/api/cabinet', { cookie, host: new URL(local).host, origin: local })).status,
    200,
  );
  const invited = await request('/api/organization/invitations', {
    cookie,
    body: { email: 'staff@example.test', role: 'cosmetologist' },
  });
  assert.equal(invited.status, 201);
  assert.equal(JSON.parse(invited.text).inviteUrl, undefined);
  assert.ok(outbox.at(-1).url.startsWith(lan + '/login.html#invite='));
  const reset = await request('/api/auth/forgot', { body: { email: 'wifi@example.test' } });
  assert.equal(reset.status, 200);
  assert.equal(JSON.parse(reset.text).resetUrl, undefined);
  assert.ok(outbox.at(-1).url.startsWith(lan + '/#reset='));
  assert.equal((await request('/api/auth/logout', { body: {}, cookie })).status, 200);
  assert.equal((await request('/api/cabinet', { cookie })).status, 401);
});
