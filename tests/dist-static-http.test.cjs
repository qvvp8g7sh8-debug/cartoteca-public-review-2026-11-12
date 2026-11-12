const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  files,
  staticSources,
  setupSources,
  setupAssetRoot,
} = require('../src/shared/web-assets.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { clientRelease } = require('../src/server/http/client-release.cjs');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { publicRoot, assetPath } = require('./helpers/interface-assets.cjs');
const projectRoot = path.resolve(__dirname, '..');

test('ready interface has one complete public tree and no compatibility copies in the project root', () => {
  const inventory = fs
    .readdirSync(publicRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(publicRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
  assert.deepEqual(inventory, [...files].sort());
  assert.equal(new Set(files).size, files.length, 'Declared resource inventory has no duplicates');
  for (const file of files) {
    assert.equal(
      fs.existsSync(path.join(projectRoot, file)),
      false,
      'Unexpected root copy: ' + file,
    );
    assert.ok(fs.statSync(assetPath(file)).isFile(), file);
  }
  for (const [file, source] of Object.entries(staticSources))
    assert.deepEqual(
      fs.readFileSync(assetPath(file)),
      fs.readFileSync(path.join(projectRoot, source)),
      source,
    );
  assert.deepEqual(
    fs.readdirSync(setupAssetRoot(projectRoot)).sort(),
    Object.keys(setupSources).sort(),
  );
  for (const [file, source] of Object.entries(setupSources)) {
    assert.equal(fs.existsSync(path.join(publicRoot, file)), false);
    assert.deepEqual(
      fs.readFileSync(path.join(setupAssetRoot(projectRoot), file)),
      fs.readFileSync(path.join(projectRoot, source)),
    );
    assert.throws(() => assetPath(file), /relative interface asset path/);
  }
  for (const invalid of [
    '',
    '.',
    '..',
    '../app.js',
    '/app.js',
    'src/client/static/index.html',
    'icons/../../app.js',
    'icons\\icon-192.png',
  ])
    assert.throws(() => assetPath(invalid), /relative interface asset path/);
});

test('dist interface retains public URLs, fresh access checks and cache boundaries over real local HTTP', async (t) => {
  const f = await adminFixture(t);
  const server = createMultiServer({
    dataDir: f.directory,
    production: false,
    origin: '',
    processRole: 'web',
    sendMail: null,
    telegramBot: null,
    supportDelivery: {},
    telegramAutostart: false,
    telegramIdentityAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
    maxEnabled: false,
    maxConnectionsEnabled: false,
    pushEnabled: false,
    assistantCodexEnabled: false,
    assistantLocalSpeechEnabled: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.cleanup(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const port = server.address().port;
  const version = await clientRelease(publicRoot);
  const request = (url, { method = 'GET', authenticated = false } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: url,
          method,
          headers: authenticated ? { Cookie: 'cartoteca_v2_session=' + f.ownerSession.token } : {},
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });

  await t.test(
    'root and original shell URL select the current login or cabinet without caching HTML',
    async () => {
      for (const url of ['/', '/index.html'])
        for (const authenticated of [false, true]) {
          const get = await request(url, { authenticated });
          assert.equal(get.status, 200);
          assert.equal(get.headers['cache-control'], 'no-store');
          assert.match(get.body.toString(), new RegExp('cartoteca-build" content="' + version));
          if (!authenticated) assert.match(get.body.toString(), /<title>Вход/);
          else {
            assert.match(get.body.toString(), /<title>Картотека · кабинет<\/title>/);
            assert.match(get.body.toString(), /src="app\.js\?v=/);
          }
          const head = await request(url, { authenticated, method: 'HEAD' });
          assert.equal(head.status, 200);
          assert.equal(head.body.length, 0);
          assert.equal(head.headers['cache-control'], 'no-store');
        }
    },
  );

  await t.test(
    'all registered assets keep their original URL and content with GET and HEAD',
    async () => {
      for (const file of files)
        for (const method of ['GET', 'HEAD']) {
          const pathname = file === 'product.html' ? '/product/' : '/' + file;
          const res = await request(pathname + '?v=' + version, { authenticated: true, method });
          assert.equal(res.status, 200, method + ' ' + file);
          if (method === 'HEAD') assert.equal(res.body.length, 0, file);
          else if (!file.endsWith('.html'))
            assert.deepEqual(res.body, fs.readFileSync(assetPath(file)), file);
        }
    },
  );

  const protectedFiles = [
    'app.js',
    'app-settings.js',
    'app-assistant.js',
    'assistant-capture-worklet.js',
    'assistant-playback-worklet.js',
    'security.js',
    'concept-clients.html',
    'concept-card.html',
    'concept.css',
    'concept-links.css',
    'concept-card.js',
  ];
  await t.test('versioned protected code stays inaccessible without a session', async () => {
    for (const file of protectedFiles)
      for (const method of ['GET', 'HEAD']) {
        const res = await request('/' + file + '?v=' + version, { method });
        assert.equal(res.status, 401, method + ' ' + file);
        assert.equal(res.headers['cache-control'], 'no-store');
        if (method === 'HEAD') assert.equal(res.body.length, 0);
      }
  });

  await t.test(
    'deferred modules require the current release before returning executable code',
    async () => {
      for (const file of [
        'app-settings.js',
        'app-assistant.js',
        'assistant-capture-worklet.js',
        'assistant-playback-worklet.js',
      ])
        for (const query of ['', '?v=', '?v=stale'])
          for (const method of ['GET', 'HEAD']) {
            const res = await request('/' + file + query, { authenticated: true, method });
            assert.equal(res.status, 409, method + ' ' + file + query);
            assert.equal(res.headers['cache-control'], 'no-store');
            if (method === 'HEAD') assert.equal(res.body.length, 0);
          }
    },
  );

  await t.test(
    'moving assets does not expose project sources, packaging files, data or traversal aliases',
    async () => {
      const forbidden = [
        '/dist',
        '/dist/public',
        '/dist/public/app.js',
        '/max-setup.html',
        '/max-setup.js',
        '/max-setup.css',
        '/dist/setup',
        '/dist/setup/max-setup.html',
        '/dist/setup/max-setup.js',
        '/dist/setup/max-setup.css',
        '/src/client/static/index.html',
        '/src/server/application/server.cjs',
        '/src/shared/web-assets.cjs',
        '/scripts/build-client.cjs',
        '/package.json',
        '/package-lock.json',
        '/Dockerfile',
        '/.dockerignore',
        '/.git/config',
        '/.env',
        '/private/secret.json',
        '/runtime/platform/platform.sqlite',
        '/node_modules/jsdom/package.json',
        '/icons/../../.env',
        '/dist/public/../../package.json',
        '/%2e%2e/.env',
        '/icons/%2e%2e/%2e%2e/src/server/config.cjs',
        '/%2e%2e%2f.env',
        '/..%5c.env',
        '/src%2fclient%2fstatic%2findex.html',
        '/C:%5cWindows%5cwin.ini',
      ];
      for (const url of forbidden)
        for (const method of ['GET', 'HEAD']) {
          const res = await request(url, { authenticated: true, method });
          assert.equal(res.status, 404, method + ' ' + url);
          assert.equal(res.headers['cache-control'], 'no-store');
          if (method === 'HEAD') assert.equal(res.body.length, 0);
        }
    },
  );

  await t.test(
    'public code cache and service worker scope retain their existing boundaries',
    async () => {
      const current = await request('/style.css?v=' + version);
      assert.equal(current.headers['cache-control'], 'private, max-age=31536000, immutable');
      for (const suffix of ['', '?v=', '?v=stale'])
        {
          const response = await request('/style.css' + suffix);
          assert.equal(response.status, suffix === '?v=stale' ? 409 : 200);
          assert.equal(response.headers['cache-control'], 'no-store');
        }
      const worker = await request('/service-worker.js', { method: 'HEAD' });
      assert.equal(worker.status, 200);
      assert.equal(worker.body.length, 0);
      assert.equal(worker.headers['cache-control'], 'no-cache');
      assert.equal(worker.headers['service-worker-allowed'], '/');
      for (const method of ['POST', 'PUT', 'DELETE'])
        await assert.rejects(
          serveStatic({ method }, {}, new URL('http://synthetic.invalid/app.js'), {}, publicRoot),
          { status: 405 },
        );
    },
  );

  await t.test(
    'revoked sessions cannot reuse cached versioned URLs to read protected modules',
    async () => {
      f.store.logout(f.ownerSession.token);
      for (const file of ['app.js', 'app-settings.js', 'app-assistant.js'])
        for (const method of ['GET', 'HEAD']) {
          const res = await request('/' + file + '?v=' + version, { authenticated: true, method });
          assert.equal(res.status, 401);
          assert.equal(res.headers['cache-control'], 'no-store');
          if (method === 'HEAD') assert.equal(res.body.length, 0);
        }
    },
  );
});
