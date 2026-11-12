const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const {
  createV2Backup,
  createBackupKey,
  recoverUpgradeCopy,
} = require('../src/server/infrastructure/backup/service.cjs');
const {
  prepareBookingReadBudgetCopy,
} = require('../src/server/migrations/prepare-booking-read-budget.cjs');

const preparationMarker = 'booking-read-budget-preparation-v1';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-budget-preparation-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-budget-preparation-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  createStorage(source).close();
  createPlatformStore(path.join(source, 'platform')).close();
  const keyFile = path.join(root, 'keys', 'synthetic-backup.key');
  createBackupKey(keyFile);
  return { root, source, keyFile, directory: path.join(root, 'archives') };
}

function assertStartupBlocked(destination) {
  assert.throws(
    () =>
      createMultiServer({
        dataDir: destination,
        production: false,
        telegramBot: null,
        sendMail: null,
      }),
    /Restore publication is incomplete/,
  );
}

test('upgrade recovery flushes and retains its preparation marker before exposing files or resolving', async (t) => {
  const f = fixture(t),
    backup = await createV2Backup(f);
  const destination = path.join(f.root, 'prepared-copy');
  const marker = path.join(destination, '.restore-in-progress');
  const open = fs.openSync,
    sync = fs.fsyncSync,
    rename = fs.renameSync;
  let descriptor,
    flushed = false,
    moved = 0;
  t.mock.method(fs, 'openSync', (...args) => {
    const result = open(...args);
    if (path.resolve(String(args[0])) === marker) descriptor = result;
    return result;
  });
  t.mock.method(fs, 'fsyncSync', (fd) => {
    const result = sync(fd);
    if (fd === descriptor) flushed = true;
    return result;
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.dirname(to) === destination) {
      assert.equal(fs.readFileSync(marker, 'utf8'), preparationMarker);
      assert.equal(flushed, true, 'the marker must be durable before publishing restored files');
      moved++;
    }
    return rename(from, to);
  });
  const result = await recoverUpgradeCopy(backup.file, f.keyFile, destination, {
    preparationMarker,
  }).then((value) => {
    assert.equal(fs.readFileSync(marker, 'utf8'), preparationMarker);
    assertStartupBlocked(destination);
    return value;
  });
  assert.ok(moved > 0);
  assert.equal(result.upgradeCopy, true);
  assert.equal(result.sessionsRevoked, false);
  assert.equal(fs.readFileSync(marker, 'utf8'), preparationMarker);
});

test('unknown preparation markers fail before reading an archive or creating a destination', async (t) => {
  const f = fixture(t),
    destination = path.join(f.root, 'must-not-appear');
  for (const value of [null, false, '', '2', 'other-preparation', {}]) {
    await assert.rejects(
      recoverUpgradeCopy(path.join(f.root, 'absent.enc'), f.keyFile, destination, {
        preparationMarker: value,
      }),
      /Unsupported offline preparation marker/,
    );
    assert.equal(fs.existsSync(destination), false);
  }
  assert.equal(
    fs.readdirSync(f.root).some((name) => name.startsWith('.cartoteca-v2-')),
    false,
  );
});

test('a deliberate preparation failure retains the recovered marker and never starts the partial copy', async (t) => {
  const f = fixture(t),
    destination = path.join(f.root, 'failed-copy');
  // A new legacy fixture cannot be rolled back from isolated mode. The failure
  // occurs after recovery, precisely where a removed/recreated marker left a gap.
  await assert.rejects(
    prepareBookingReadBudgetCopy({ ...f, destination, offline: true, rollback: true }),
    /Unexpected source read-budget mode/,
  );
  assert.equal(
    fs.readFileSync(path.join(destination, '.restore-in-progress'), 'utf8'),
    preparationMarker,
  );
  assertStartupBlocked(destination);
  const original = new DatabaseSync(path.join(f.source, 'platform/platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(original.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(
      original.prepare("SELECT 1 FROM sqlite_schema WHERE name='booking_read_budget_store'").get(),
      undefined,
    );
  } finally {
    original.close();
  }
  assert.equal(fs.existsSync(path.join(f.source, '.restore-in-progress')), false);
  assert.equal(fs.existsSync(path.join(f.source, 'platform/booking-read-budget.sqlite')), false);
  assert.equal(fs.readdirSync(f.directory).filter((name) => name.endsWith('.enc')).length, 1);
  await assert.rejects(
    prepareBookingReadBudgetCopy({ ...f, destination, offline: true }),
    /destination must be new/,
  );
});
