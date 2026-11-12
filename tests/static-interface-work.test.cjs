const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { adminFixture } = require('./helpers/admin-fixture.cjs');
const { clientRelease, releaseFiles } = require('../src/server/http/client-release.cjs');
const { files } = require('../src/shared/web-assets.cjs');
const { prepareStatic } = require('../src/server/http/static-snapshot.cjs');
const IMMUTABLE = 'private, max-age=31536000, immutable';
const serverFile = path.resolve(__dirname, '../src/server/application/server.cjs');
const serverSource = fs.readFileSync(serverFile, 'utf8');
const serverRequire = createRequire(serverFile);
const yieldTurn = () => new Promise(setImmediate);

// Actual dispatcher, security, current SQLite session, static router and release
// module. Only the server's fixed interface root is injected by a local loader.
// No listener/port, browser, provider, timers for background jobs or real data.
async function fixture(t, { cold = false } = {}) {
  const f = await adminFixture(t), projectRoot = path.join(f.directory, 'synthetic-interface'),
    root = path.join(projectRoot, 'dist', 'public');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, '.synthetic-static-work'), 'owned test fixture\n');
  const contents = new Map();
  for (const file of files) {
    const text = file.endsWith('.html')
      ? '<html><head></head><body>Synthetic shell<script src="app.js"></script></body></html>'
      : '// Synthetic public interface: ' + file + '\n';
    const bytes = Buffer.from(text);
    contents.set(file, bytes);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), bytes);
  }
  const digest = createHash('sha256');
  for (const file of releaseFiles) digest.update(file + '\0').update(contents.get(file));
  const version = digest.digest('hex').slice(0, 16);
  if (!cold) assert.equal(await clientRelease(root), version);
  let authChecks = 0;
  const module = { exports: {} };
  const localRequire = (name) => {
    if (name === '../config.cjs') return { ...serverRequire(name), root: projectRoot };
    if (name !== './platform.cjs') return serverRequire(name);
    const actual = serverRequire(name);
    return { ...actual, createPlatformStore(...args) {
      const platform = actual.createPlatformStore(...args), session = platform.session;
      platform.session = (...values) => { authChecks++; return session(...values); };
      return platform;
    } };
  };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' +
    serverSource + '\n})', { filename: serverFile })(
    localRequire, module, module.exports, serverFile, path.dirname(serverFile));
  const server = module.exports.createMultiServer({
    dataDir: f.directory, production: false, processRole: 'web', origin: '',
    host: '127.0.0.1', port: 4174, sendMail: null, telegramBot: null,
    supportDelivery: { telegram: null, email: null }, telegramAutostart: false,
    supportAutostart: false, adminEmailAutostart: false, bookingPublicationAutostart: false,
    telegramIdentityAutostart: false, maxEnabled: false, maxConnectionsEnabled: false,
    maxAutostart: false, pushEnabled: false, pushAutostart: false,
    commonNotificationsEnabled: false, scheduledNotifications: false,
    assistantCodexEnabled: false, assistantLocalSpeechEnabled: false,
    sharedCabinetWrites: false, isolatedReadBudgets: false, readBudgetVersion: 0,
    metricsEnabled: false,
  });
  f.cleanup(() => new Promise((resolve) => server.close(resolve)));
  const request = (url, method = 'GET', authenticated = true, extraHeaders = {}) =>
    new Promise((resolve) => {
      const req = new EventEmitter(), res = new EventEmitter();
      Object.assign(req, { method, url, complete: true, aborted: false,
        socket: { localPort: 4174, remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:4174', ...extraHeaders,
          ...(authenticated ? { cookie: 'cartoteca_v2_session=' + f.ownerSession.token } : {}) },
        pause() {}, resume() {} });
      Object.assign(res, { statusCode: 200, headers: {}, headersSent: false,
        destroyed: false, writableEnded: false, writableFinished: false,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        writeHead(status, headers) { this.statusCode = status;
          for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value);
          this.headersSent = true; },
        end(body) { this.body = body === undefined ? undefined : Buffer.from(body);
          this.writableEnded = this.writableFinished = true; this.emit('finish'); resolve(this); } });
      server.emit('request', req, res);
    });
  return { ...f, root, version, contents, request, authChecks: () => authChecks };
}

// Count only this owned synthetic interface root. No require-cache mutation and
// no spy on session keys/databases. Restore both global methods in every finally.
async function countWork(f, run, { gateReads = false } = {}) {
  const original = { stat: fs.promises.stat, readFile: fs.promises.readFile, open: fs.promises.open };
  const originalSync = Object.fromEntries(['statSync', 'readFileSync', 'openSync', 'closeSync'].map((name) => [name, fs[name]]));
  let release;
  const gate = gateReads ? new Promise((resolve) => { release = resolve; }) : null;
  const work = { stats: [], reads: [], syncCalls: [], pendingStats: [], handles: new Set(), openCalls: 0, closeCalls: 0,
    release: () => release?.() };
  const relative = (file) => {
    if (typeof file !== 'string') return null;
    const name = path.relative(f.root, path.resolve(file));
    return name && !name.startsWith('..') && !path.isAbsolute(name)
      ? name.split(path.sep).join('/') : null;
  };
  for (const [method, actual] of Object.entries(originalSync)) fs[method] = function(file, ...args) {
    const name = relative(file);
    if (name) {
      work.syncCalls.push(method + ':' + name);
      if (method === 'readFileSync') work.reads.push(name);
      if (method === 'statSync') work.stats.push(name);
    }
    return actual.call(this, file, ...args);
  };
  fs.promises.stat = function (file, ...args) {
    const name = relative(file), pending = original.stat.call(this, file, ...args);
    if (name) { work.stats.push(name); work.pendingStats.push(pending); }
    return pending;
  };
  fs.promises.readFile = async function (file, ...args) {
    const name = relative(file);
    if (name) { work.reads.push(name); await work.beforeRead?.(name); if (gate) await gate; }
    return original.readFile.call(this, file, ...args);
  };
  fs.promises.open = async function (file, ...args) {
    const handle = await original.open.call(this, file, ...args);
    const name = relative(file);
    if (name) {
      work.openCalls++; work.handles.add(handle);
      const close = handle.close.bind(handle), read = handle.readFile.bind(handle);
      handle.readFile = (...values) => { work.reads.push(name); return read(...values); };
      handle.close = async (...values) => { work.closeCalls++;
        try { return await close(...values); } finally { work.handles.delete(handle); } };
      await work.onOpen?.(name, handle);
    }
    return handle;
  };
  try { return await run(work); }
  finally {
    release?.();
    try { await Promise.all([...work.handles].map((handle) => handle.close())); }
    finally { Object.assign(fs.promises, original); Object.assign(fs, originalSync); }
  }
}
function validAsset(response, f, file, head = false) {
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], IMMUTABLE);
  assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
  if (head) assert.equal(response.body, undefined);
  else assert.deepEqual(response.body, f.contents.get(file));
}

test('warm deferred GET preserves current headers, executable body and fresh session',
  { concurrency: false }, async (t) => {
    const f = await fixture(t);
    for (const file of ['app-settings.js', 'app-assistant.js']) await t.test(file, async () => {
      await countWork(f, async (work) => {
        const before = f.authChecks();
        validAsset(await f.request('/' + file + '?v=' + f.version), f, file);
        assert.equal(f.authChecks() - before, 1, 'fresh server session before static code');
        assert.deepEqual(work.reads, []);
        assert.deepEqual(work.stats, []);
        assert.deepEqual(work.syncCalls, [], 'prepared GET has no sync disk I/O either');
        assert.equal(work.openCalls, 0);
      });
    });
  });

test('warm deferred HEAD preserves headers/version/auth without loading executable body',
  { concurrency: false }, async (t) => {
    const f = await fixture(t);
    for (const file of ['app-settings.js', 'app-assistant.js']) await t.test(file, async () => {
      await countWork(f, async (work) => {
        const before = f.authChecks();
        validAsset(await f.request('/' + file + '?v=' + f.version, 'HEAD'), f, file, true);
        assert.equal(f.authChecks() - before, 1);
        assert.deepEqual(work.reads, []);
        assert.deepEqual(work.stats, []);
        assert.deepEqual(work.syncCalls, []);
        assert.equal(work.openCalls, 0);
      });
    });
  });

test('four concurrent cold deferred imports use startup bytes and keep four fresh authorizations',
  { concurrency: false }, async (t) => {
    const f = await fixture(t, { cold: true }), file = 'app-settings.js';
    await countWork(f, async (work) => {
      const responses = await Promise.all(Array.from({ length: 4 }, () => f.request('/' + file + '?v=' + f.version)));
      for (const response of responses) validAsset(response, f, file);
      assert.equal(f.authChecks(), 4, 'coalescing does not share authorization');
      assert.deepEqual(work.reads, []);
      assert.deepEqual(work.stats, []);
      assert.deepEqual(work.syncCalls, []);
    });
  });

test('disk changes cannot replace the pinned release or immutable response bytes',
  { concurrency: false }, async (t) => {
    const f = await fixture(t), file = 'app-assistant.js';
    fs.appendFileSync(path.join(f.root, file), '// Updated synthetic generation\n');
    validAsset(await f.request('/' + file + '?v=' + f.version), f, file);
    assert.equal(await clientRelease(f.root), f.version);
    assert.doesNotMatch((await f.request('/' + file + '?v=' + f.version)).body.toString(), /Updated synthetic generation/);
  });

test('warm valid and stale versions cannot bypass current session revocation',
  { concurrency: false }, async (t) => {
    const f = await fixture(t);
    validAsset(await f.request('/app-settings.js?v=' + f.version), f, 'app-settings.js');
    f.store.logout(f.ownerSession.token);
    await countWork(f, async (work) => {
      for (const version of [f.version, 'stale']) for (const method of ['GET', 'HEAD']) {
        assert.equal((await f.request('/app-settings.js?v=' + version, method)).statusCode, 401);
      }
      assert.deepEqual(work.stats, []);
      assert.deepEqual(work.reads, []);
      assert.deepEqual(work.syncCalls, []);
      assert.equal(work.openCalls, 0);
    });
  });

test('stale or missing deferred version rejects GET/HEAD before executable reads',
  { concurrency: false }, async (t) => {
    const f = await fixture(t);
    await countWork(f, async (work) => {
      for (const query of ['', '?v=', '?v=stale']) for (const method of ['GET', 'HEAD']) {
        const response = await f.request('/app-assistant.js' + query, method);
        assert.equal(response.statusCode, 409);
        assert.equal(response.headers['cache-control'], 'no-store');
      }
      assert.deepEqual(work.reads, []);
      assert.deepEqual(work.syncCalls, []);
    });
  });

test('public shell and conditional requests retain existing status/cache/MIME contracts',
  { concurrency: false }, async (t) => {
    const f = await fixture(t);
    const shell = await f.request('/', 'GET', false);
    assert.equal(shell.statusCode, 200);
    assert.equal(shell.headers['cache-control'], 'no-store');
    assert.match(shell.body.toString(), new RegExp('cartoteca-build" content="' + f.version));
    const style = await f.request('/style.css?v=' + f.version, 'GET', false);
    assert.equal(style.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(style.headers['cache-control'], IMMUTABLE);
    const worker = await f.request('/service-worker.js', 'HEAD', false);
    assert.equal(worker.statusCode, 200); assert.equal(worker.body, undefined);
    assert.equal(worker.headers['cache-control'], 'no-cache');
    assert.equal(worker.headers['service-worker-allowed'], '/');
    validAsset(await f.request('/app.js?v=' + f.version, 'GET', true,
      { 'if-none-match': 'synthetic', 'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT' }), f, 'app.js');
    assert.equal((await f.request('/unknown-resource.js', 'HEAD', false)).statusCode, 404);
  });

function rawRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-static-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '// Synthetic startup bytes: ' + file);
  }
  return root;
}

test('startup reads and verifies every declared resource once, separately from request I/O', async (t) => {
  const root = rawRoot(t);
  await countWork({ root }, async (work) => {
    const snapshot = prepareStatic(root);
    assert.deepEqual([...snapshot.assets.keys()].sort(), [...files].sort());
    assert.deepEqual([...work.reads].sort(), [...files].sort());
    assert.equal(work.stats.length, files.length * 2);
    const reads = work.reads.length, stats = work.stats.length;
    assert.strictEqual(prepareStatic(root), snapshot);
    assert.equal(work.reads.length, reads); assert.equal(work.stats.length, stats);
  });
});

test('startup rejects absent resources and directories; prepared HEAD remains coherent after disk removal', async (t) => {
  for (const directory of [false, true]) {
    const root = rawRoot(t), target = path.join(root, 'app.js');
    fs.unlinkSync(target);
    if (directory) fs.mkdirSync(target);
    assert.throws(() => prepareStatic(root));
  }
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.root, 'app.js'));
  validAsset(await f.request('/app.js?v=' + f.version, 'HEAD'), f, 'app.js', true);
});

test('unreadable startup resource fails without pinning partial bytes; repaired startup can retry', async (t) => {
  const root = rawRoot(t), target = path.join(root, 'app.js');
  const previous = await clientRelease(root), actual = fs.readFileSync;
  fs.appendFileSync(target, '// synthetic new version');
  fs.readFileSync = function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === target)
      throw Object.assign(Error('Synthetic denied read'), { code: 'EACCES' });
    return actual.call(this, file, ...args);
  };
  try { assert.throws(() => prepareStatic(root), { code: 'EACCES' }); }
  finally { fs.readFileSync = actual; }
  assert.notEqual(await clientRelease(root), previous, 'failed startup must not pin the old detector version');
  const snapshot = prepareStatic(root);
  assert.match(snapshot.assets.get('app.js').identity.toString(), /synthetic new version/);
});

test('a resource changing during startup rejects the whole snapshot and never pins partial bytes', async (t) => {
  const root = rawRoot(t), actual = fs.readFileSync;
  const target = path.join(root, 'app-settings.js');
  let changed = false;
  fs.readFileSync = function(file, ...args) {
    const bytes = actual.call(this, file, ...args);
    if (typeof file === 'string' && path.resolve(file) === target && !changed) {
      changed = true;
      fs.appendFileSync(target, '// Mid-startup synthetic generation');
    }
    return bytes;
  };
  try { assert.throws(() => prepareStatic(root), /changed during startup/); }
  finally { fs.readFileSync = actual; }
  assert.equal(changed, true);
  const snapshot = prepareStatic(root);
  assert.match(snapshot.assets.get('app-settings.js').identity.toString(), /Mid-startup synthetic generation/);
  assert.equal(await clientRelease(root), snapshot.version);
});
