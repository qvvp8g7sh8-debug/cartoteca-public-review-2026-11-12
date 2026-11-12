const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { gunzipSync, brotliDecompressSync } = require('node:zlib');
const { files } = require('../src/shared/web-assets.cjs');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { prepareStatic } = require('../src/server/http/static-snapshot.cjs');
const { clientRelease } = require('../src/server/http/client-release.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-resource-contract-'));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file.endsWith('.html')
      ? '<html><head><link href="style.css"><script src="app.js"></script></head><body>Synthetic shell</body></html>'
      : ('/* synthetic ' + file + ' */\n').repeat(200));
  }
  const server = http.createServer(async (req, res) => {
    try {
      await serveStatic(req, res, new URL(req.url, 'http://synthetic.test'), req.headers['x-synthetic-session'] ? {} : null, root);
    } catch (error) {
      res.writeHead(error.status || 500, { 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : 'Synthetic resource error');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (url, { method = 'GET', encoding = '', authenticated = true } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method,
      headers: { 'Accept-Encoding': encoding, ...(authenticated ? { 'X-Synthetic-Session': '1' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  return { root, request };
}

test('real resource HTTP negotiates prepared bytes, q=0, HTML metadata and HEAD without bypassing auth', async (t) => {
  const f = await fixture(t), snapshot = prepareStatic(f.root);
  const plain = await f.request('/');
  const html = plain.body.toString();
  assert.match(html, new RegExp('style.css\\?v=' + snapshot.resources['style.css']));
  assert.match(html, new RegExp('cartoteca-resource-app-settings" content="' + snapshot.resources['app-settings.js']));
  assert.equal(plain.headers['cache-control'], 'no-store');
  for (const [encoding, expected] of [['gzip', 'gzip'], ['gzip;q=0, br', 'br'], ['br;q=0, gzip;q=0', undefined], ['*;q=1, gzip;q=0, br;q=0', undefined], ['gzip;q=.3, br;q=.8, identity;q=0', 'br']]) {
    const response = await f.request('/', { encoding });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], expected);
    assert.equal(response.headers.vary, 'Accept-Encoding');
    assert.equal(Number(response.headers['content-length']), response.body.length);
    assert.match(response.headers['content-type'], /^text\/html/);
    const decoded = expected === 'gzip' ? gunzipSync(response.body) : expected === 'br' ? brotliDecompressSync(response.body) : response.body;
    assert.deepEqual(decoded, plain.body, 'compression must cover transformed HTML');
    const head = await f.request('/', { encoding, method: 'HEAD' });
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-encoding'], expected);
    assert.equal(head.headers['content-length'], response.headers['content-length']);
  }
  assert.equal((await f.request('/', { encoding: '*;q=0' })).status, 406);
  const url = '/style.css?v=' + snapshot.resources['style.css'];
  const css = await f.request(url, { encoding: 'gzip' });
  assert.equal(css.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.equal((await f.request('/style.css?v=stale')).status, 409);
  assert.equal((await f.request('/app.js?v=stale', { authenticated: false })).status, 401);
  assert.equal((await f.request('/app.js?v=stale')).status, 409);
  for (const file of ['app-settings.js', 'app-assistant.js']) {
    const resource = '/'+file+'?v='+snapshot.resources[file];
    assert.equal((await f.request(resource)).status, 409);
    assert.equal((await f.request(resource+'&build='+snapshot.version)).status, 200);
    assert.equal((await f.request(resource+'&build=stale')).status, 409);
    const revoked = await f.request(resource+'&build='+snapshot.version, { authenticated: false, method: 'HEAD', encoding: 'br' });
    assert.equal(revoked.status, 401); assert.equal(revoked.body.length, 0);
    assert.equal(revoked.headers['content-encoding'], undefined);
    assert.equal((await f.request('/'+file+'?v='+snapshot.version)).status, 200);
  }
});

test('snapshot pins coherent bytes and support version until restart; new process changes only modified resource hashes', async (t) => {
  const f = await fixture(t), first = prepareStatic(f.root);
  const original = (await f.request('/app.js?v='+first.resources['app.js'])).body;
  fs.appendFileSync(path.join(f.root, 'app.js'), '\n/* changed synthetic release */');
  assert.equal(await clientRelease(f.root), first.version);
  assert.strictEqual(prepareStatic(f.root), first);
  assert.deepEqual((await f.request('/app.js?v='+first.resources['app.js'])).body, original);
  const helper = path.resolve(__dirname, 'helpers/mobile-resource-upgrade-child.cjs');
  const next = spawnSync(process.execPath, [helper, f.root, JSON.stringify({ version: first.version, resources: first.resources })], { encoding: 'utf8', timeout: 10000 });
  assert.equal(next.status, 0, next.stderr);
  const second = JSON.parse(next.stdout);
  assert.notEqual(second.version, first.version);
  assert.notEqual(second.resources['app.js'], first.resources['app.js']);
  assert.equal(second.stale.status, 409); assert.equal(second.stale.cache, 'no-store');
  assert.equal(second.current.status, 200);
  assert.equal(second.current.hash, second.resources['app.js']);
  assert.equal(second.current.cache, 'private, max-age=31536000, immutable');
  assert.equal(second.denied.status, 401); assert.equal(second.denied.cache, 'no-store');
  assert.equal(second.staleDeferred.status, 409); assert.equal(second.staleDeferred.cache, 'no-store');
  assert.equal(second.currentDeferred.status, 200);
  for (const file of ['style.css', 'ui-extra.css', 'icons/icon-192.png']) {
    assert.equal(second.resources[file], first.resources[file]);
    assert.equal('/'+file+'?v='+second.resources[file], '/'+file+'?v='+first.resources[file]);
  }
  assert.notEqual('/app-settings.js?v='+second.resources['app-settings.js']+'&build='+second.version,
    '/app-settings.js?v='+first.resources['app-settings.js']+'&build='+first.version,
    'deferred URLs deliberately change with the compatible release even when bytes are unchanged');
});

test('late release detection cannot overwrite the serving snapshot pin', async (t) => {
  const f = await fixture(t);
  const pending = clientRelease(f.root);
  const snapshot = prepareStatic(f.root);
  assert.equal(await pending, snapshot.version);
  assert.equal(await clientRelease(f.root), snapshot.version);
});

function workerFixture(timing = {}) {
  const handlers = new Map(), entries = new Map(), fetched = [], saved = [];
  let transport = async () => new Response('synthetic public CSS', { headers: { 'Content-Type': 'text/css' } });
  const cache = {
    match: async (request) => entries.get(request.url),
    put: async (request, response) => { saved.push(request.url); entries.set(request.url, response); },
    keys: async () => [...entries.keys()].map((url) => ({ url })),
    delete: async (request) => entries.delete(request.url),
  };
  const storage = { open: async () => cache };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/client/pwa/service-worker.js'), 'utf8'), {
    URL, Response, Headers, Uint8Array, AbortController, setTimeout: timing.setTimeout || setTimeout, clearTimeout,
    self: { location: { origin: 'https://synthetic.test' }, addEventListener: (name, handler) => handlers.set(name, handler) },
    caches: storage,
    fetch: async (request, options) => { fetched.push(request.url); return transport(request, options); },
  });
  const dispatch = (path, mode) => {
    let result;
    handlers.get('fetch')({ request: { url: 'https://synthetic.test'+path, method: 'GET', mode }, respondWith: (value) => { result = value; } });
    return result;
  };
  return { dispatch, fetched, saved, cache, storage, setTransport: (value) => { transport = value; } };
}

test('PWA uses exact public resource URLs and never persists sessions, protected bundles, API or failed responses', async () => {
  const f = workerFixture();
  for (const path of ['/api/patients', '/api/photos/synthetic', '/app.js?v=1111111111111111', '/app-settings.js?v=1111111111111111', '/booking.html']) assert.equal(f.dispatch(path), undefined);
  await f.dispatch('/style.css?v=1111111111111111');
  await f.dispatch('/style.css?v=1111111111111111');
  assert.equal(f.fetched.length, 1); assert.equal(f.saved.length, 1);
  await f.dispatch('/style.css?v=2222222222222222');
  assert.equal(f.fetched.length, 2); assert.equal(f.saved.length, 2);
  f.setTransport(async () => new Response('denied', { status: 401 }));
  assert.equal((await f.dispatch('/style.css?v=3333333333333333')).status, 401);
  assert.equal(f.saved.length, 2);
  await f.dispatch('/style.css'); assert.equal(f.saved.length, 2);
  f.setTransport(async () => { throw TypeError('synthetic offline'); });
  const offline = await f.dispatch('/', 'navigate');
  assert.equal(offline.status, 503); assert.equal(offline.headers.get('cache-control'), 'no-store');
  assert.match(await offline.text(), /Повторить загрузку/);
  assert.equal(f.saved.length, 2);
});

test('PWA cache storage and quota failures preserve successful network responses', async () => {
  for (const operation of ['open', 'match', 'put', 'keys']) {
    const f = workerFixture();
    (operation === 'open' ? f.storage : f.cache)[operation] = async () => { throw Error('synthetic cache failure'); };
    const response = await f.dispatch('/style.css?v=1111111111111111');
    assert.equal(response.status, 200, operation);
    assert.equal(await response.text(), 'synthetic public CSS', operation);
  }
});

test('PWA interrupted navigation has a finite deadline and returns a neutral retry shell', async () => {
  const f = workerFixture();
  f.setTransport((request, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Error('synthetic slow network')));
  }));
  const started = Date.now();
  const response = await f.dispatch('/', 'navigate');
  assert.equal(response.status, 503);
  assert.ok(Date.now() - started < 5500);
  const html = await response.text();
  assert.match(html, /Проверьте интернет/);
  assert.doesNotMatch(html, /app\.js|patient|<script/i);
  assert.equal(f.saved.length, 0);
});

test('PWA navigation deadline covers a stalled HTML body after successful headers', async () => {
  const f = workerFixture();
  let cancelled = false;
  f.setTransport(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html><head>')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/html' } }));
  const started = Date.now();
  const response = await f.dispatch('/', 'navigate');
  assert.equal(response.status, 503);
  assert.ok(Date.now() - started < 5500);
  assert.match(await response.text(), /Повторить загрузку/);
  assert.equal(cancelled, true);
});

test('PWA navigation rejects truncated bodies and preserves complete response status and safe headers', async () => {
  const broken = workerFixture();
  broken.setTransport(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html>')); controller.error(Error('synthetic truncated body')); },
  }), { headers: { 'Content-Type': 'text/html' } }));
  assert.equal((await broken.dispatch('/', 'navigate')).status, 503);
  const complete = workerFixture();
  complete.setTransport(async () => new Response('<html>synthetic login</html>', {
    status: 401, statusText: 'Unauthorized',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', 'Content-Length': '1000', 'X-Synthetic-Header': 'preserved' },
  }));
  const response = await complete.dispatch('/', 'navigate');
  assert.equal(response.status, 401); assert.equal(response.statusText, 'Unauthorized');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-synthetic-header'), 'preserved');
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(await response.text(), '<html>synthetic login</html>');
  assert.equal(complete.saved.length, 0);
});

test('PWA deadline also finishes a transport ignoring abort, and rejects an oversized shell', async () => {
  const noncooperative = workerFixture({ setTimeout: (callback) => setTimeout(callback, 25) });
  noncooperative.setTransport(() => new Promise(() => {}));
  assert.equal((await noncooperative.dispatch('/', 'navigate')).status, 503);
  const oversized = workerFixture();
  oversized.setTransport(async () => new Response('x'.repeat(512 * 1024 + 1)));
  assert.equal((await oversized.dispatch('/', 'navigate')).status, 503);
});
