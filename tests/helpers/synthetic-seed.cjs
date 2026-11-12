const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

// Test-only, process-local seed. The builder must close every SQLite/server handle
// before returning. Every scenario receives ordinary copied files, never links or
// live shared stores. Authentication setup must use real registration/login APIs.
function createSyntheticSeed({ name, prepare }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof prepare !== 'function')
    throw Error('Invalid synthetic seed configuration');
  const temporary = path.resolve(os.tmpdir());
  const prefix = 'cartoteca-' + name + '-';
  let pending, closed = false;

  function remove(directory) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== temporary || !path.basename(target).startsWith(prefix))
      throw Error('Unsafe synthetic seed cleanup');
    if (!fs.existsSync(target)) return;
    const entry = fs.lstatSync(target);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw Error('Synthetic seed directory was replaced');
    fs.rmSync(target, { recursive: true, force: true });
  }

  function manifest(directory, relative = '') {
    const files = [];
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error('Synthetic seed cannot contain links');
      if (entry.isDirectory()) files.push(...manifest(directory, file));
      else {
        if (!entry.isFile()) throw Error('Synthetic seed requires regular files');
        if (/-(?:wal|shm|journal)$/i.test(entry.name))
          throw Error('Close SQLite handles before preparing a synthetic seed');
        files.push([file, crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(directory, file))).digest('hex')]);
      }
    }
    return files;
  }

  function initialize() {
    if (!pending) pending = (async () => {
      const directory = fs.mkdtempSync(path.join(temporary, prefix + 'seed-'));
      try {
        const data = structuredClone(await prepare(directory));
        return { directory, data, signature: JSON.stringify(manifest(directory)) };
      } catch (error) {
        remove(directory);
        throw error;
      }
    })();
    return pending;
  }

  return {
    async clone() {
      if (closed) throw Error('Synthetic seed is closed');
      const seed = await initialize();
      if (closed) throw Error('Synthetic seed is closed');
      if (JSON.stringify(manifest(seed.directory)) !== seed.signature)
        throw Error('Synthetic seed was changed after preparation');
      const dir = fs.mkdtempSync(path.join(temporary, prefix + 'case-'));
      try {
        // mkdtemp reserves the parent; copy each child to a previously absent target.
        // Node 24.22 rejects copying onto an existing directory with errorOnExist.
        for (const name of fs.readdirSync(seed.directory))
          fs.cpSync(path.join(seed.directory, name), path.join(dir, name), {
            recursive: true, force: false, errorOnExist: true,
          });
        const data = structuredClone(seed.data);
        let released = false;
        return { dir, data, close() { if (!released) { remove(dir); released = true; } } };
      } catch (error) {
        remove(dir);
        throw error;
      }
    },
    async close() {
      closed = true;
      // Cleanup still runs after failed initialization, without hiding its error.
      const seed = await pending?.catch(() => null);
      if (seed) remove(seed.directory);
    },
  };
}

// Opt-in timing separates setup/body/cleanup without writing normal-test noise or
// including synthetic account/session metadata. It never changes assertions.
function createFixtureTimer(t, name) {
  const started = performance.now();
  let ready;
  return {
    ready() { ready = performance.now(); },
    async cleanup(callback) {
      const cleanupStarted = performance.now();
      try { await callback(); }
      finally {
        if (process.env.CARTOTECA_FIXTURE_TIMINGS === '1')
          t.diagnostic(JSON.stringify({ fixture: name, setupCompleted: ready !== undefined,
            setupMs: Number(((ready ?? cleanupStarted) - started).toFixed(3)),
            bodyMs: ready === undefined ? 0 : Number((cleanupStarted - ready).toFixed(3)),
            cleanupMs: Number((performance.now() - cleanupStarted).toFixed(3)) }));
      }
    },
  };
}

module.exports = { createSyntheticSeed, createFixtureTimer };
