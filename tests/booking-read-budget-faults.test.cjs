const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setImmediate } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const store = require('../src/server/infrastructure/booking-read-budget-store.cjs');
const { createBookingPublicLimits } = require('../src/server/modules/booking/public-limits.cjs');
const {
  migrateBookingReadBudget,
} = require('../src/server/migrations/001-booking-read-budget.cjs');
const {
  prepareBookingReadBudgetCopy,
} = require('../src/server/migrations/prepare-booking-read-budget.cjs');
const { createBackupKey } = require('../src/server/infrastructure/backup/service.cjs');
const { dataInventory } = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const NOW = 1900000000000;
const worker = path.join(__dirname, 'helpers/booking-read-budget-fault-worker.cjs');
const markerText = 'booking-read-budget-preparation-v1';
const sqliteCode = (code) => (error) =>
  error.code === 'ERR_SQLITE_ERROR' && (error.errcode & 255) === code;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-budget-faults-'));
  const closers = [];
  const source = path.join(root, 'source'),
    directory = path.join(root, 'archives');
  const keyFile = path.join(root, 'synthetic-backup.key');
  createPlatformStore(path.join(source, 'platform')).close();
  createBackupKey(keyFile);
  withDb(source, 'platform.sqlite', (db) => {
    const put = db.prepare('INSERT INTO login_limits VALUES(?,?,?,?)');
    put.run('booking-budget:read-address:synthetic', 239, NOW, NOW + 60000);
    put.run('booking-budget:site-read:synthetic', 19999, NOW, NOW + 60000);
    put.run('booking-budget:address:submit', 7, NOW, NOW + 3600000);
  });
  t.after(() => {
    for (const close of closers.reverse()) close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^cartoteca-budget-faults-/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { root, source, directory, keyFile, closers };
}
function withDb(root, name, callback) {
  const db = new DatabaseSync(path.join(root, 'platform', name));
  try {
    return callback(db);
  } finally {
    db.close();
  }
}
function rows(db) {
  return db.prepare('SELECT * FROM login_limits ORDER BY key').all();
}
function integrity(db) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}
function runtime(t, f) {
  let now = NOW;
  const platformDir = path.join(f.source, 'platform');
  const marker = path.join(f.source, '.restore-in-progress');
  fs.writeFileSync(marker, markerText);
  migrateBookingReadBudget(platformDir);
  fs.unlinkSync(marker);
  const context = createPlatformDatabase(platformDir, { isolatedReadBudgets: true });
  const readBudget = store.openBookingReadBudget(context.db, platformDir, true);
  const limits = createBookingPublicLimits(context, { readBudget, clock: () => now });
  f.closers.push(() => {
    readBudget.close();
    context.closeWriter();
    context.db.close();
  });
  const snapshot = () => ({ rows: rows(readBudget.db), cleanup: readBudget.cleanup.last() });
  return {
    context,
    readBudget,
    limits,
    snapshot,
    setClock: (value) => {
      now = value;
    },
  };
}
function blocked(root) {
  assert.equal(fs.readFileSync(path.join(root, '.restore-in-progress'), 'utf8'), markerText);
  assert.throws(
    () =>
      createMultiServer({
        dataDir: root,
        production: false,
        telegramBot: null,
        sendMail: null,
      }),
    /Restore publication is incomplete/,
  );
}
function runFault(f, fault, rollback = false) {
  const destination = path.join(f.root, fault + (rollback ? '-rollback' : ''));
  const proof = destination + '.proof.json';
  const result = spawnSync(
    process.execPath,
    [worker, f.source, destination, f.directory, f.keyFile, fault, proof, String(rollback)],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16384,
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(proof, 'utf8')), { fault, reached: true });
  if (fault === 'archive-full') assert.equal(result.status, 0, result.stderr);
  else
    assert.ok(
      result.signal === 'SIGKILL' || result.status === 1,
      'Worker must terminate via hard process kill, not catch/finally',
    );
  return destination;
}

test('read-only SQLite budget rejects admission without spending either token or advancing cleanup', async (t) => {
  const f = fixture(t),
    r = runtime(t, f),
    before = r.snapshot();
  const authority = rows(r.context.db);
  // SQLite enforces this connection as read-only on both Windows and Linux;
  // do not rely on chmod, which administrators/root can bypass.
  r.readBudget.db.exec('PRAGMA query_only=ON');
  await assert.rejects(r.limits.consumeReadAsync('read-only-address'), sqliteCode(8));
  assert.deepEqual(r.snapshot(), before);
  assert.deepEqual(rows(r.context.db), authority);
  assert.equal(r.readBudget.db.isTransaction, false);
  await setImmediate();
  assert.equal(r.readBudget.stats().pending, 0);
  r.readBudget.db.exec('PRAGMA query_only=OFF');
  await r.limits.consumeReadAsync('read-only-address');
  integrity(r.readBudget.db);
});

test('real SQLITE_FULL rolls back both counters and cleanup; recovery does not reset active windows', async (t) => {
  const f = fixture(t),
    r = runtime(t, f);
  const pages = r.readBudget.db.prepare('PRAGMA page_count').get().page_count;
  r.readBudget.db.exec('PRAGMA max_page_count=' + pages);
  const authority = rows(r.context.db);
  let failure, failedAddress, before;
  for (let i = 0; i < 1000; i++) {
    before = r.snapshot();
    failedAddress = 'full-address-' + i;
    try {
      await r.limits.consumeReadAsync(failedAddress);
    } catch (error) {
      failure = error;
      break;
    }
  }
  assert.ok(failure, 'A bounded real SQLite page cap must be exhausted');
  assert.ok(sqliteCode(13)(failure), failure.message);
  assert.deepEqual(r.snapshot(), before, 'No partial address/site debit after SQLITE_FULL');
  r.setClock(NOW + 1000);
  await assert.rejects(r.limits.consumeReadAsync(failedAddress), sqliteCode(13));
  assert.deepEqual(r.snapshot(), before, 'Cleanup marker update rolls back with failed debit');
  assert.deepEqual(rows(r.context.db), authority);
  assert.equal(r.readBudget.db.isTransaction, false);
  await setImmediate();
  assert.equal(r.readBudget.stats().pending, 0);
  integrity(r.readBudget.db);
  r.readBudget.db.exec('PRAGMA max_page_count=1073741823');
  await r.limits.consumeReadAsync(failedAddress);
  const oldSite = before.rows.find(
    (row) => row.key === r.context.limitKey('booking-budget:site-read', 'all'),
  );
  assert.equal(
    r.readBudget.db
      .prepare('SELECT failures FROM login_limits WHERE key=?')
      .get(r.context.limitKey('booking-budget:site-read', 'all')).failures,
    (oldSite?.failures || 0) + 1,
  );
  assert.equal(
    r.readBudget.db
      .prepare('SELECT failures FROM login_limits WHERE key=?')
      .get('booking-budget:read-address:synthetic').failures,
    239,
  );
});

for (const fault of ['before-budget-commit', 'after-budget-commit', 'after-platform-commit']) {
  test(
    'hard preparation crash at ' + fault + ' leaves source unchanged and copy unstartable',
    (t) => {
      const f = fixture(t),
        before = dataInventory(f.source);
      const expected = withDb(f.source, 'platform.sqlite', (db) =>
        rows(db).filter((row) => /:(read-address|site-read):/.test(row.key)),
      );
      const destination = runFault(f, fault);
      blocked(destination);
      assert.deepEqual(dataInventory(f.source), before);
      withDb(destination, 'platform.sqlite', (db) => {
        integrity(db);
        if (fault === 'after-platform-commit') {
          assert.equal(store.registration(db).mode, 'isolated');
          store.validateLegacyGuards(db, store.registration(db));
          assert.deepEqual(
            db.prepare('SELECT * FROM login_limits WHERE ' + store.readWhere).all(),
            [],
          );
        } else {
          assert.equal(store.registration(db), null);
          assert.throws(
            () => store.assertMode(db, path.join(destination, 'platform'), true),
            /Unregistered/,
          );
          assert.deepEqual(
            rows(db).filter((row) => /:(read-address|site-read):/.test(row.key)),
            expected,
          );
        }
      });
      withDb(destination, store.filename, (db) => {
        integrity(db);
        if (fault === 'before-budget-commit')
          assert.equal(
            db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table'").get().n,
            0,
          );
        else assert.deepEqual(rows(db), expected);
      });
      assert.equal(fs.readdirSync(f.directory).filter((name) => name.endsWith('.enc')).length, 1);
    },
  );
}

test('hard rollback crash between component and platform COMMIT retains isolated state and active limits', async (t) => {
  const f = fixture(t),
    isolated = path.join(f.root, 'complete-isolated');
  await prepareBookingReadBudgetCopy({ ...f, destination: isolated, offline: true });
  withDb(isolated, store.filename, (db) => db.exec('UPDATE login_limits SET failures=failures+1'));
  const before = dataInventory(isolated);
  const expected = withDb(isolated, store.filename, rows);
  const destination = runFault({ ...f, source: isolated }, 'before-platform-commit', true);
  blocked(destination);
  assert.deepEqual(dataInventory(isolated), before);
  withDb(destination, 'platform.sqlite', (db) => {
    integrity(db);
    assert.equal(store.registration(db).mode, 'isolated');
    store.validateLegacyGuards(db, store.registration(db));
    assert.deepEqual(db.prepare('SELECT * FROM login_limits WHERE ' + store.readWhere).all(), []);
  });
  withDb(destination, store.filename, (db) => {
    integrity(db);
    assert.deepEqual(rows(db), expected);
  });
});

test('ENOSPC publishing final verified archive retains marker after commits; source and prior archive survive', (t) => {
  const f = fixture(t),
    before = dataInventory(f.source);
  const destination = runFault(f, 'archive-full');
  blocked(destination);
  assert.deepEqual(dataInventory(f.source), before);
  withDb(destination, 'platform.sqlite', (db) => {
    assert.equal(store.registration(db).mode, 'isolated');
    store.assertMode(db, path.join(destination, 'platform'), true);
    integrity(db);
  });
  withDb(destination, store.filename, integrity);
  assert.equal(fs.readdirSync(f.directory).filter((name) => name.endsWith('.enc')).length, 1);
  assert.equal(
    fs.readdirSync(f.directory).some((name) => name.startsWith('.cartoteca-v2-')),
    false,
  );
});
