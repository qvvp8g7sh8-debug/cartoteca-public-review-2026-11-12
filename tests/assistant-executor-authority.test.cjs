const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const {
  acquireAssistantExecutorAuthority: acquire,
  filename,
} = require('../src/server/infrastructure/assistant-executor-authority.cjs');
const moduleFile = require.resolve('../src/server/infrastructure/assistant-executor-authority.cjs');
const unavailable = (error) => error.status === 503 && !error.message.includes(os.tmpdir());
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-assistant-authority-'));
  const owners = [];
  t.after(() => {
    for (const owner of owners) owner.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^cartoteca-assistant-authority-/);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    directory,
    file: path.join(directory, filename),
    open() {
      const owner = acquire(directory);
      owners.push(owner);
      return owner;
    },
  };
}
function startChild(t, directory, hold = false) {
  const source = `
    const { acquireAssistantExecutorAuthority } = require(${JSON.stringify(moduleFile)});
    let owner;
    try {
      owner = acquireAssistantExecutorAuthority(${JSON.stringify(directory)});
      process.send({ acquired: true });
      if (${JSON.stringify(hold)}) process.on('message', () => {
        owner.close(); process.send({ released: true }); process.disconnect();
      });
      else { owner.close(); process.disconnect(); }
    } catch (error) { process.send({ acquired: false, status: error.status }); process.disconnect(); }
  `;
  const child = fork('-e', [source], {
    execArgv: ['--max-old-space-size=96'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  });
  return { child, exit, message: once(child, 'message') };
}

test('exclusive authority rejects a second connection and keeps one stable disposable file', (t) => {
  const f = fixture(t),
    first = f.open();
  first.assertOwned();
  assert.throws(() => f.open(), unavailable);
  first.assertOwned();
  assert.deepEqual(fs.readdirSync(f.directory), [filename]);
  assert.ok(fs.statSync(f.file).size > 0, 'valid nonclinical SQLite header is initialized once');
  first.close();
  assert.ok(fs.existsSync(f.file), 'releasing ownership must not unlink the shared inode');
  f.open().assertOwned();
});

test('authority is isolated by the shared data directory', (t) => {
  const first = fixture(t),
    second = fixture(t);
  first.open().assertOwned();
  second.open().assertOwned();
});

test('closed ownership fails safely and close is idempotent', (t) => {
  const f = fixture(t),
    owner = f.open();
  owner.close();
  owner.close();
  assert.throws(() => owner.assertOwned(), unavailable);
  f.open().assertOwned();
});

test('idle authority and repeated guards create no timers, contents or additional writes', async (t) => {
  const f = fixture(t);
  const interval = global.setInterval,
    timeout = global.setTimeout;
  let timers = 0;
  global.setInterval = (...args) => {
    timers++;
    return interval(...args);
  };
  global.setTimeout = (...args) => {
    timers++;
    return timeout(...args);
  };
  try {
    const owner = f.open();
    const before = fs.statSync(f.file, { bigint: true });
    for (let i = 0; i < 100; i++) owner.assertOwned();
    await new Promise(setImmediate);
    const after = fs.statSync(f.file, { bigint: true });
    assert.equal(timers, 0);
    for (const key of ['size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
    assert.deepEqual(fs.readdirSync(f.directory), [filename]);
  } finally {
    global.setInterval = interval;
    global.setTimeout = timeout;
  }
});

test(
  'cross-process contender is rejected while the live owner remains usable',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      owner = f.open();
    const other = startChild(t, f.directory);
    assert.deepEqual((await other.message)[0], { acquired: false, status: 503 });
    await other.exit;
    owner.assertOwned();
  },
);

test(
  'cross-process orderly release admits a new owner without a stale lease',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      other = startChild(t, f.directory, true);
    assert.deepEqual((await other.message)[0], { acquired: true });
    assert.throws(() => f.open(), unavailable);
    const released = once(other.child, 'message');
    other.child.send('close');
    assert.deepEqual((await released)[0], { released: true });
    await other.exit;
    f.open().assertOwned();
  },
);

test(
  'OS releases a crashed child owner immediately without deleting the lock or waiting for TTL',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      other = startChild(t, f.directory, true);
    assert.deepEqual((await other.message)[0], { acquired: true });
    assert.throws(() => f.open(), unavailable);
    const original = fs.statSync(f.file, { bigint: true });
    other.child.kill('SIGKILL');
    await other.exit;
    const owner = f.open(),
      current = fs.statSync(f.file, { bigint: true });
    owner.assertOwned();
    assert.equal(current.dev, original.dev);
    assert.equal(current.ino, original.ino);
  },
);

test('symlink lock paths are rejected without following their contents', (t) => {
  const f = fixture(t),
    target = path.join(f.directory, 'target');
  fs.writeFileSync(target, 'synthetic sentinel');
  try {
    fs.symlinkSync(target, f.file, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip(
        'Windows account cannot create file symlinks; hardlink and replacement guards remain covered',
      );
      return;
    }
    throw error;
  }
  assert.throws(() => f.open(), unavailable);
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic sentinel');
});

test('hardlinked coordination paths cannot split ownership between names', (t) => {
  const f = fixture(t),
    target = path.join(f.directory, 'linked-lock');
  fs.writeFileSync(target, '');
  fs.linkSync(target, f.file);
  assert.throws(() => f.open(), unavailable);
});

test('removing or replacing the lock inode fences the previous owner, or the OS denies replacement', (t) => {
  const f = fixture(t),
    owner = f.open(),
    retired = path.join(f.directory, 'old-lock');
  try {
    fs.renameSync(f.file, retired);
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
      owner.assertOwned();
      assert.throws(() => f.open(), unavailable);
      return;
    }
    throw error;
  }
  fs.writeFileSync(f.file, '', { flag: 'wx' });
  assert.throws(() => owner.assertOwned(), unavailable);
  f.open().assertOwned();
});

test('invalid databases fail admission, close every acquired handle and preserve the original file', (t) => {
  const f = fixture(t),
    sentinel = Buffer.from('synthetic invalid sqlite');
  fs.writeFileSync(f.file, sentinel);
  assert.throws(() => f.open(), unavailable);
  assert.deepEqual(fs.readFileSync(f.file), sentinel);
  fs.writeFileSync(f.file, '');
  f.open().assertOwned();
});

test('WAL databases and unexpected sidecars are refused, never converted or deleted', (t) => {
  const f = fixture(t),
    db = new DatabaseSync(f.file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE synthetic(value)');
  db.close();
  assert.throws(() => f.open(), unavailable);
  const probe = new DatabaseSync(f.file);
  assert.equal(probe.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  probe.close();
  const fresh = fixture(t);
  fs.writeFileSync(fresh.file + '-wal', 'synthetic sentinel');
  assert.throws(() => fresh.open(), unavailable);
  assert.equal(fs.readFileSync(fresh.file + '-wal', 'utf8'), 'synthetic sentinel');
});

test('dangling journal links are rejected before SQLite can create their missing target', (t) => {
  const f = fixture(t),
    target = path.join(f.directory, 'missing-target');
  try {
    fs.symlinkSync(target, f.file + '-journal', 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows account cannot create file symlinks; Linux must cover dangling journals');
      return;
    }
    throw error;
  }
  assert.throws(() => f.open(), unavailable);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.lstatSync(f.file + '-journal').isSymbolicLink(), true);
});
