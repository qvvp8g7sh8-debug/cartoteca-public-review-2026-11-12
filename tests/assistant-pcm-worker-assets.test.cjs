const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { files, generatedFiles } = require('../src/shared/web-assets.cjs');
const { releaseFiles, clientRelease } = require('../src/server/http/client-release.cjs');
const { serveStatic } = require('../src/server/http/static-files.cjs');
const { prepareStatic } = require('../src/server/http/static-snapshot.cjs');
function fixture(t, worker = 'self.onmessage=()=>{};\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-worker-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of files) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      name === 'assistant-pcm-pump.js'
        ? worker
        : name.endsWith('.html')
          ? '<!doctype html><head></head><body></body>'
          : '// synthetic ' + name + '\n',
    );
  }
  return dir;
}
function response() {
  return {
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(bytes) {
      this.bytes = bytes;
    },
  };
}
test('PCM worker belongs to complete static inventory and changes release fingerprint', async (t) => {
  assert.equal(files.length, 44);
  assert.equal(files.filter((n) => n === 'assistant-pcm-pump.js').length, 1);
  assert.ok(generatedFiles.includes('assistant-pcm-pump.js'));
  assert.ok(releaseFiles.includes('assistant-pcm-pump.js'));
  const first = fixture(t, 'self.onmessage=()=>1;\n'),
    second = fixture(t, 'self.onmessage=()=>2;\n');
  assert.notEqual(
    await clientRelease(first),
    await clientRelease(second),
    'worker content participates in interface release',
  );
  assert.match(
    fs.readFileSync('scripts/build-client.cjs', 'utf8'),
    /'assistant-pcm-pump\.js': 'src\/client\/workers\/assistant-pcm-pump\.js'/,
  );
});
test('PCM worker is private JS with strict build-version GET and HEAD semantics', async (t) => {
  const dir = fixture(t),
    snapshot = prepareStatic(dir),
    base = 'http://synthetic.invalid/assistant-pcm-pump.js';
  for (const method of ['GET', 'HEAD']) {
    await assert.rejects(
      serveStatic(
        { method, headers: {} },
        response(),
        new URL(base + '?v=' + snapshot.version),
        null,
        dir,
      ),
      { status: 401 },
    );
    for (const suffix of [
      '',
      '?v=stale',
      '?v=' + snapshot.resources['assistant-pcm-pump.js'],
      '?v=' + snapshot.version + '&build=stale',
    ])
      await assert.rejects(
        serveStatic({ method, headers: {} }, response(), new URL(base + suffix), {}, dir),
        { status: 409 },
      );
    for (const suffix of [
      '?v=' + snapshot.version,
      '?v=' + snapshot.resources['assistant-pcm-pump.js'] + '&build=' + snapshot.version,
    ]) {
      const res = response();
      await serveStatic({ method, headers: {} }, res, new URL(base + suffix), {}, dir);
      assert.equal(res.status, 200);
      assert.equal(res.headers['Content-Type'], 'text/javascript; charset=utf-8');
      assert.equal(res.headers['Cache-Control'], 'private, max-age=31536000, immutable');
      assert.equal(
        method === 'HEAD'
          ? res.bytes === undefined
          : res.bytes.toString().includes('self.onmessage'),
        true,
      );
    }
  }
  await assert.rejects(
    serveStatic({ method: 'POST', headers: {} }, response(), new URL(base), {}, dir),
    { status: 405 },
  );
});
test('private PCM worker does not become a PWA offline cached resource', () => {
  const source = fs.readFileSync('src/client/pwa/service-worker.js', 'utf8');
  assert.equal(source.includes('/assistant-pcm-pump.js'), false);
  assert.match(source, /if \(!SHELL\.includes\(url.pathname\)\) return/);
  const security = fs.readFileSync('src/server/http/security.cjs', 'utf8');
  assert.match(security, /script-src 'self'/);
  assert.equal(security.includes('worker-src'), false);
});
