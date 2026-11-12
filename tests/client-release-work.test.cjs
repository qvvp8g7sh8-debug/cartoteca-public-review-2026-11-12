const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const moduleFile = path.resolve(__dirname, '../src/server/http/client-release.cjs');
const moduleSource = fs.readFileSync(moduleFile, 'utf8');
const localRequire = createRequire(moduleFile);
const { releaseFiles } = localRequire('./client-release.cjs');
const deferred = () => {
  let resolve; const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// A fresh instance of the actual source owns its private Map. Only its fs/crypto
// ports are observed; all stat/read operations still use real owned temp files.
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-release-work-'));
  fs.writeFileSync(path.join(directory, '.synthetic-release-work'), 'owned fixture\n');
  const roots = ['first', 'second'].map((name) => path.join(directory, name));
  const expected = new Map(), filesByRoot = new Map();
  for (const [index, root] of roots.entries()) {
    const files = new Map(), digest = crypto.createHash('sha256');
    for (const file of releaseFiles) {
      const bytes = Buffer.from(String(index) + ':synthetic:' + file);
      files.set(file, bytes);
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), bytes);
      digest.update(file + '\0').update(bytes);
    }
    filesByRoot.set(root, files); expected.set(root, digest.digest('hex').slice(0, 16));
  }
  const work = { stats: [], reads: [], hashes: 0, statPromises: [] }, hooks = {}, pending = new Set();
  const changes = new EventEmitter();
  function tracked(promise) {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  }
  const promises = {
    ...fs.promises,
    stat(file, ...args) {
      const promise = (async () => {
        work.stats.push(file); changes.emit('work');
        const value = await fs.promises.stat(file, ...args);
        return hooks.stat ? hooks.stat(file, value) : value;
      })();
      work.statPromises.push(promise); return tracked(promise);
    },
    readFile(file, ...args) {
      return tracked((async () => {
        await hooks.beforeRead?.(file);
        const bytes = await fs.promises.readFile(file, ...args);
        work.reads.push(file); changes.emit('work');
        await hooks.afterRead?.(file, bytes);
        return bytes;
      })());
    },
  };
  const module = { exports: {} };
  const requirePort = (name) => name === 'node:fs' ? { ...fs, promises }
    : name === 'node:crypto' ? { ...crypto, createHash(...args) {
      work.hashes++; return crypto.createHash(...args);
    } } : localRequire(name);
  vm.runInThisContext('(function(require,module,exports){' + moduleSource + '\n})',
    { filename: moduleFile })(requirePort, module, module.exports);
  t.after(async () => {
    await Promise.allSettled([...pending]);
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-release-work-'));
    assert.equal(fs.readFileSync(path.join(directory, '.synthetic-release-work'), 'utf8'), 'owned fixture\n');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { roots, work, hooks, release: module.exports.clientRelease, pin: module.exports.pinClientRelease, expected,
    settleReads: () => Promise.allSettled([...pending]),
    observed(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const finish = (error) => { clearTimeout(timer); changes.removeListener('work', inspect);
          if (error) reject(error); else resolve(); };
        const inspect = () => { if (predicate()) finish(); };
        const timer = setTimeout(() => finish(new Error('Synthetic operation gate timed out')), 3000);
        changes.on('work', inspect); inspect();
      });
    },
    change(root, file) {
      const files = filesByRoot.get(root), bytes = Buffer.concat([files.get(file), Buffer.from(':changed')]);
      files.set(file, bytes); fs.writeFileSync(path.join(root, file), bytes);
      const digest = crypto.createHash('sha256');
      for (const [name, value] of files) digest.update(name + '\0').update(value);
      expected.set(root, digest.digest('hex').slice(0, 16));
    } };
}

test('startup pin supersedes an already reading detector and all later support lookups', async (t) => {
  const f = fixture(t), root = f.roots[0], gate = deferred();
  f.hooks.afterRead = () => gate.promise;
  const pending = f.release(root);
  await f.observed(() => f.work.reads.length === releaseFiles.length);
  const pinned = 'abcdef0123456789';
  f.pin(root, pinned);
  gate.resolve();
  assert.equal(await pending, pinned);
  const before = { reads: f.work.reads.length, stats: f.work.stats.length };
  assert.equal(await f.release(root), pinned);
  assert.equal(f.work.reads.length, before.reads);
  assert.equal(f.work.stats.length, before.stats);
});
test('same-root same-signature cold calls each stat freshly but share content reads/hash', async (t) => {
  const f = fixture(t), root = f.roots[0], gate = deferred();
  f.hooks.afterRead = () => gate.promise;
  const calls = Array.from({ length: 4 }, () => f.release(root));
  try {
    await f.observed(() => f.work.stats.length === releaseFiles.length * 4);
    await Promise.all(f.work.statPromises);
    await Promise.resolve(); await Promise.resolve();
  } finally { gate.resolve(); }
  assert.deepEqual(await Promise.all(calls), Array(4).fill(f.expected.get(root)));
  assert.equal(f.work.stats.length, releaseFiles.length * 4,
    'every request verifies current metadata before considering shared computation');
  assert.equal(f.work.reads.length, releaseFiles.length, 'one shared public-content pass');
  assert.equal(f.work.hashes, 1);
});

test('equal metadata signatures from distinct roots never share content or versions', async (t) => {
  const f = fixture(t);
  // Deliberately equal timestamps, while actual same-size owned contents differ.
  f.hooks.stat = (_file, value) => ({ size: value.size, mtimeMs: 1, ctimeMs: 1 });
  const values = await Promise.all(f.roots.map((root) => f.release(root)));
  assert.deepEqual(values, f.roots.map((root) => f.expected.get(root)));
  assert.notEqual(values[0], values[1]);
  assert.equal(f.work.reads.length, releaseFiles.length * 2);
  assert.equal(f.work.hashes, 2);
});

test('late old completion cannot replace a newer completed signature and force re-reading it', async (t) => {
  const f = fixture(t), root = f.roots[0], oldGate = deferred();
  const oldExpected = f.expected.get(root);
  let hold = true;
  f.hooks.afterRead = () => hold ? oldGate.promise : undefined;
  const old = f.release(root);
  try {
    await f.observed(() => f.work.reads.length === releaseFiles.length);
    hold = false; f.change(root, 'style.css');
    const freshExpected = f.expected.get(root);
    assert.notEqual(freshExpected, oldExpected);
    assert.equal(await f.release(root), freshExpected, 'new metadata must not join old pending work');
    oldGate.resolve(); assert.equal(await old, oldExpected);
    const reads = f.work.reads.length, hashes = f.work.hashes;
    assert.equal(await f.release(root), freshExpected);
    assert.equal(f.work.reads.length, reads, 'late old work must not overwrite a newer cache record');
    assert.equal(f.work.hashes, hashes);
  } finally { hold = false; oldGate.resolve(); await old; }
});

test('old completion cannot clear a newer pending record; a new same-signature caller joins it', async (t) => {
  const f = fixture(t), root = f.roots[0], oldGate = deferred(), freshGate = deferred();
  const oldExpected = f.expected.get(root);
  let phase = 'old';
  f.hooks.afterRead = () => phase === 'old' ? oldGate.promise : freshGate.promise;
  const old = f.release(root);
  let fresh, follower;
  try {
    await f.observed(() => f.work.reads.length === releaseFiles.length);
    phase = 'fresh'; f.change(root, 'style.css');
    fresh = f.release(root);
    await f.observed(() => f.work.reads.length === releaseFiles.length * 2);
    oldGate.resolve(); assert.equal(await old, oldExpected);
    const previousStats = f.work.stats.length;
    follower = f.release(root);
    await f.observed(() => f.work.stats.length === previousStats + releaseFiles.length);
    await Promise.all(f.work.statPromises);
    await Promise.resolve(); await Promise.resolve();
  } finally { oldGate.resolve(); freshGate.resolve(); }
  assert.equal(await fresh, f.expected.get(root));
  assert.equal(await follower, f.expected.get(root));
  assert.equal(f.work.reads.length, releaseFiles.length * 2);
  assert.equal(f.work.hashes, 2);
});

test('a failed shared content read is not cached and a fresh retry succeeds', async (t) => {
  const f = fixture(t), root = f.roots[0];
  let fail = true;
  f.hooks.beforeRead = (file) => {
    if (path.basename(file) === 'style.css' && fail) {
      fail = false; throw Object.assign(new Error('Synthetic transient file failure'), { code: 'EIO' });
    }
  };
  await assert.rejects(f.release(root), { code: 'EIO' });
  // Promise.all rejects before the other real file reads have necessarily settled.
  await f.settleReads();
  assert.equal(await f.release(root), f.expected.get(root));
  const reads = f.work.reads.length, hashes = f.work.hashes;
  assert.equal(await f.release(root), f.expected.get(root));
  assert.equal(f.work.reads.length, reads);
  assert.equal(f.work.hashes, hashes);
});


test('four same-signature waiters share one controlled read failure, then fresh retry succeeds', async (t) => {
  const f = fixture(t), root = f.roots[0], failure = deferred();
  let failedAttempts = 0;
  f.hooks.beforeRead = async (file) => {
    if (path.basename(file) !== 'style.css') return;
    failedAttempts++; await failure.promise;
    throw Object.assign(new Error('Synthetic shared content failure'), { code: 'EIO' });
  };
  const settled = Promise.allSettled(Array.from({ length: 4 }, () => f.release(root)));
  try {
    await f.observed(() => f.work.stats.length === releaseFiles.length * 4);
    await Promise.all(f.work.statPromises);
    await f.observed(() => f.work.reads.length >= releaseFiles.length - 1);
  } finally { failure.resolve(); }
  for (const result of await settled) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'EIO');
  }
  assert.equal(failedAttempts, 1, 'all current waiters share the same failed content pass');
  assert.equal(f.work.hashes, 0, 'partial contents never produce a release');
  f.hooks.beforeRead = undefined;
  assert.equal(await f.release(root), f.expected.get(root), 'unchanged metadata can retry after failure');
  assert.equal(f.work.hashes, 1);
  const reads = f.work.reads.length;
  assert.equal(await f.release(root), f.expected.get(root));
  assert.equal(f.work.reads.length, reads);
});

test('a late old failure cannot clear a newer pending signature or start another content pass', async (t) => {
  const f = fixture(t), root = f.roots[0], oldGate = deferred(), freshGate = deferred();
  let phase = 'old';
  f.hooks.beforeRead = async (file) => {
    if (phase === 'old' && path.basename(file) === 'style.css') {
      await oldGate.promise;
      throw Object.assign(new Error('Synthetic old generation failure'), { code: 'EIO' });
    }
  };
  f.hooks.afterRead = () => phase === 'fresh' ? freshGate.promise : undefined;
  const old = Promise.allSettled([f.release(root)]);
  let fresh, follower;
  try {
    await f.observed(() => f.work.reads.length === releaseFiles.length - 1);
    phase = 'fresh'; f.change(root, 'style.css'); fresh = f.release(root);
    await f.observed(() => f.work.reads.length === releaseFiles.length * 2 - 1);
    oldGate.resolve();
    const [failed] = await old;
    assert.equal(failed.status, 'rejected'); assert.equal(failed.reason.code, 'EIO');
    const previousStats = f.work.stats.length;
    follower = f.release(root);
    await f.observed(() => f.work.stats.length === previousStats + releaseFiles.length);
    await Promise.all(f.work.statPromises);
    await Promise.resolve(); await Promise.resolve();
  } finally { oldGate.resolve(); freshGate.resolve(); }
  assert.equal(await fresh, f.expected.get(root)); assert.equal(await follower, f.expected.get(root));
  assert.equal(f.work.reads.length, releaseFiles.length * 2 - 1);
  assert.equal(f.work.hashes, 1, 'only the new complete signature is hashed');
});
