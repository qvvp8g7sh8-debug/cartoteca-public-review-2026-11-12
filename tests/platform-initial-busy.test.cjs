const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');

// BEGIN EXCLUSIVE does not block WAL readers. A fresh owned copy is put into
// DELETE journal mode solely to deterministically exercise the initial reader
// lock. The separately recorded real261/BUSY_RECOVERY is not fabricated here.
test('initial platform schema read waits for a brief independent SQLite lock and preserves schema/quota',
  { timeout: 12000, concurrency: false }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-initial-busy-'));
    fs.chmodSync(directory, 0o700);
    const nonce = randomUUID();
    fs.writeFileSync(path.join(directory, '.initial-busy-owned.json'), JSON.stringify({
      purpose: 'initial-platform-read-lock', parentPid: process.pid, nonce,
    }), { flag: 'wx', mode: 0o600 });
    let seed, setup, store, inspection, child, deadline, force;
    let closed = false, exited = false, terminal, openError, attemptedAt;
    const packets = [], diagnostics = [], stderrCodes = new Set();
    let resolveLocked, rejectLocked, resolveClosed;
    const locked = new Promise((resolve, reject) => { resolveLocked = resolve; rejectLocked = reject; });
    void locked.catch(() => {});
    const drained = new Promise((resolve) => { resolveClosed = resolve; });
    function stopOwned() {
      if (!child || closed || exited) return;
      child.kill('SIGTERM');
      if (!force) force = setTimeout(() => { if (!closed && !exited) child.kill('SIGKILL'); }, 750);
    }
    const aborted = () => stopOwned();
    t.signal.addEventListener('abort', aborted, { once: true });
    try {
      seed = createPlatformStore(directory); seed.close(); seed = null;
      setup = new DatabaseSync(path.join(directory, 'platform.sqlite'), { timeout: 5000 });
      const schemaVersion = setup.prepare('PRAGMA user_version').get().user_version;
      assert.equal(schemaVersion, 11);
      assert.equal(setup.prepare('PRAGMA journal_mode=DELETE').get().journal_mode, 'delete');
      setup.exec("CREATE TABLE initial_read_probe(value TEXT NOT NULL); INSERT INTO initial_read_probe VALUES('preserved-synthetic');");
      setup.close(); setup = null;
      assert.equal(t.signal.aborted, false);
      child = fork(path.join(__dirname, 'fixtures/platform-initial-busy-holder.cjs'), [directory, nonce], {
        shell: false, detached: false,
        execArgv: ['--max-old-space-size=128', '--max-semi-space-size=8'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderrBytes = 0;
      child.stderr.on('data', (bytes) => {
        stderrBytes += bytes.length;
        for (const code of bytes.toString().match(/\b(?:ERR_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|EACCES|ENOENT|EIO)\b/g) || []) stderrCodes.add(code);
        if (stderrBytes > 8192) stopOwned();
      });
      child.on('message', (value) => {
        if (!value || !['locked', 'released', 'holder-error'].includes(value.kind)) return;
        const packet = { kind: value.kind, lockedAt: value.lockedAt, releasedAt: value.releasedAt,
          phase: value.phase, reason: value.reason, schemaVersion: value.schemaVersion,
          journalMode: value.journalMode, name: value.name, code: value.code, errcode: value.errcode };
        packets.push(packet);
        if (value.kind === 'locked') resolveLocked(packet);
        if (value.kind === 'released') terminal = packet;
        if (value.kind === 'holder-error') {
          diagnostics.push(packet); rejectLocked(Error('Synthetic lock holder error: ' + JSON.stringify(packet)));
        }
      });
      child.once('error', (error) => {
        diagnostics.push({ name: error.name, code: error.code || null }); rejectLocked(error);
      });
      child.once('exit', () => { exited = true; });
      child.once('close', (code, signal) => {
        closed = true; clearTimeout(force); clearTimeout(deadline);
        resolveClosed({ code, signal });
        rejectLocked(Error('Owned lock holder closed before ready: ' + JSON.stringify({ code, signal })));
      });
      deadline = setTimeout(stopOwned, 9000);
      const lock = await locked;
      assert.equal(lock.schemaVersion, schemaVersion); assert.equal(lock.journalMode, 'delete');
      // The independent child releases while this process is inside synchronous SQLite.
      child.send({ kind: 'release-after-delay', nonce }, (error) => {
        if (error) { diagnostics.push({ name: error.name, code: error.code || null }); stopOwned(); }
      });
      attemptedAt = Date.now();
      try { store = createPlatformStore(directory); } catch (error) { openError = error; }
      const exit = await drained;
      assert.equal(exit.code, 0, JSON.stringify({ exit, diagnostics, stderrCodes: [...stderrCodes] }));
      assert.equal(exit.signal, null); assert.equal(terminal?.reason, 'release-after-delay');
      assert.ok(attemptedAt < terminal.releasedAt, 'platform open starts before independent release');
      assert.deepEqual(diagnostics, []);
      assert.ifError(openError);
      inspection = new DatabaseSync(path.join(directory, 'platform.sqlite'), { timeout: 5000 });
      assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, schemaVersion);
      assert.equal(inspection.prepare('SELECT value FROM initial_read_probe').get().value, 'preserved-synthetic');
      assert.equal(inspection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      for (let index = 0; index < 10; index++)
        store.consumePublicAuthRequest('register', 'initial-' + index + '@example.test', 'initial-shared-synthetic-ip');
      assert.throws(() => store.consumePublicAuthRequest('register', 'eleventh@example.test',
        'initial-shared-synthetic-ip'), { status: 429 });
      assert.equal(packets.filter((packet) => packet.kind === 'locked').length, 1);
      assert.equal(packets.filter((packet) => packet.kind === 'released').length, 1);
    } finally {
      clearTimeout(deadline);
      t.signal.removeEventListener('abort', aborted);
      if (child && !closed) { stopOwned(); await drained; }
      clearTimeout(force); child?.stderr?.removeAllListeners('data'); child?.removeAllListeners('message');
      inspection?.close(); store?.close(); setup?.close(); seed?.close();
      assert.ok(!child || closed, 'only owned helper fully drained before fixture cleanup');
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('cartoteca-initial-busy-'));
      const marker = JSON.parse(fs.readFileSync(path.join(directory, '.initial-busy-owned.json'), 'utf8'));
      assert.equal(marker.nonce, nonce); assert.equal(marker.parentPid, process.pid);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
