const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { clientRelease, releaseFiles } = require('../src/server/http/client-release.cjs');
const { files } = require('../src/shared/web-assets.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cartoteca-static-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(
      path.join(root, file),
      file.endsWith('.html')
        ? '<html><head></head><body>Synthetic interface</body></html>'
        : '// Synthetic interface',
    );
  }
  return { root, version: await clientRelease(root) };
}
function response() {
  return {
    headers: { 'Cache-Control': 'no-store' },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    },
  };
}
async function read(f, file, session = { userId: 'synthetic' }, method = 'GET') {
  const res = response();
  await serveStatic({ method }, res, new URL(file, 'https://synthetic.invalid'), session, f.root);
  return res;
}
test('only current versioned interface JS/CSS receives private browser cache', async (t) => {
  const f = await fixture(t);
  for (const file of [
    'app.js',
    'app-settings.js',
    'app-assistant.js',
    'assistant-capture-worklet.js',
    'assistant-playback-worklet.js',
    'security.js',
    'ui-extra.css',
    'login.js',
    'auth.css',
  ]) {
    const res = await read(f, '/' + file + '?v=' + f.version);
    assert.equal(res.headers['Cache-Control'], 'private, max-age=31536000, immutable');
  }
  const head = await read(f, '/app.js?v=' + f.version, {}, 'HEAD');
  assert.equal(head.body, undefined);
  assert.equal(head.headers['Cache-Control'], 'private, max-age=31536000, immutable');
});
test('missing versions stay no-store, stale versions reject, and pinned bytes survive disk changes', async (t) => {
  const f = await fixture(t);
  for (const file of ['/app.js', '/app.js?v='])
    assert.equal((await read(f, file)).headers['Cache-Control'], 'no-store');
  await assert.rejects(read(f, '/app.js?v=stale'), { status: 409 });
  const original = (await read(f, '/app.js?v=' + f.version)).body;
  await fs.appendFile(path.join(f.root, 'app.js'), '\n// New synthetic release');
  const pinned = await read(f, '/app.js?v=' + f.version);
  assert.equal(pinned.headers['Cache-Control'], 'private, max-age=31536000, immutable');
  assert.deepEqual(pinned.body, original);
  assert.equal(await clientRelease(f.root), f.version);
});
test('HTML, manifest and service worker preserve their cache boundaries', async (t) => {
  const f = await fixture(t);
  for (const file of ['index.html', 'login.html', 'booking.html', 'manifest.webmanifest'])
    assert.equal(
      (await read(f, '/' + file + '?v=' + f.version)).headers['Cache-Control'],
      'no-store',
    );
  assert.equal(
    (await read(f, '/service-worker.js?v=' + f.version)).headers['Cache-Control'],
    'no-cache',
  );
});
test('version parameter does not bypass protected asset ACL or allow API/photos', async (t) => {
  const f = await fixture(t);
  for (const file of [
    'app.js',
    'app-settings.js',
    'app-assistant.js',
    'assistant-capture-worklet.js',
    'assistant-playback-worklet.js',
    'security.js',
  ])
    await assert.rejects(read(f, '/' + file + '?v=' + f.version, null), { status: 401 });
  for (const file of ['api/auth/session', 'photos/synthetic.png'])
    await assert.rejects(read(f, '/' + file + '?v=' + f.version), { status: 404 });
});

test('deferred module rejects missing, empty and stale release before sending executable content', async (t) => {
  const f = await fixture(t);
  for (const file of [
    'app-settings.js',
    'app-assistant.js',
    'assistant-capture-worklet.js',
    'assistant-playback-worklet.js',
  ])
    for (const suffix of ['', '?v=', '?v=stale'])
      for (const method of ['GET', 'HEAD'])
        await assert.rejects(read(f, '/' + file + suffix, {}, method), { status: 409 });
  await fs.appendFile(path.join(f.root, 'app-settings.js'), '\n// Another synthetic release');
  for (const file of ['app-settings.js', 'app-assistant.js']) {
    const pinned = await read(f, '/' + file + '?v=' + f.version);
    assert.doesNotMatch(pinned.body.toString(), /Another synthetic release/);
  }
});
