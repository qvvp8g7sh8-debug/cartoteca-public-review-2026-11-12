const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
  rollbackEmptyNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');

function fixture(t, channel = 'max') {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  const { db, seal, tokenHash } = f.database;
  db.prepare('INSERT INTO notification_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'job',
    'org',
    'p',
    'a',
    'stamp',
    tokenHash('synthetic'),
    seal({ channel, callback: 'synthetic', recipient: { userId: '789', botId: '123' } }),
    'uncertain',
    f.now,
    f.now + 60000,
    2,
    0,
  );
  db.prepare('INSERT INTO notification_confirmations VALUES(?,?,?,?,?)').run(
    'org',
    'p',
    'a',
    'stamp',
    seal({ notificationConfirmedAt: f.now, notificationConfirmedChannel: 'telegram' }),
  );
  return f;
}

test('candidate 014 preserves encrypted jobs and first receipts with a verified version-13 snapshot', (t) => {
  const f = fixture(t),
    db = f.database.db;
  const oldJob = db.prepare('SELECT * FROM notification_jobs').get();
  const oldReceipt = db.prepare('SELECT * FROM notification_confirmations').get();
  const oldAccount = db.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value;
  const result = migrateNotificationChannels(f.database, f.directory);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
  assert.deepEqual(db.prepare('SELECT * FROM notification_jobs').get(), oldJob);
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM notification_channel_jobs').get() },
    {
      ...oldJob,
      channel: 'max',
    },
  );
  assert.deepEqual(db.prepare('SELECT * FROM notification_confirmations').get(), oldReceipt);
  assert.deepEqual(
    db.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value,
    oldAccount,
  );
  assert.ok(
    result.snapshotDirectory.startsWith(path.join(f.directory, 'migration-backups') + path.sep),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(result.snapshotDirectory, 'platform.key')),
    f.database.key,
  );
  const snapshot = new DatabaseSync(path.join(result.snapshotDirectory, 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 13);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(snapshot.prepare('SELECT * FROM notification_jobs').get(), oldJob);
    assert.deepEqual(
      snapshot.prepare('SELECT * FROM notification_confirmations').get(),
      oldReceipt,
    );
  } finally {
    snapshot.close();
  }
  const count = fs.readdirSync(path.join(f.directory, 'migration-backups')).length;
  migrateNotificationChannels(f.database, f.directory);
  assert.equal(fs.readdirSync(path.join(f.directory, 'migration-backups')).length, count);
  assert.throws(() => rollbackEmptyNotificationChannels(f.database), /full verified backup/);
  assert.deepEqual(db.prepare('SELECT * FROM notification_confirmations').get(), oldReceipt);
});

test('invalid legacy channel rolls back the candidate DDL and keeps all old data', (t) => {
  const f = fixture(t, 'invalid'),
    db = f.database.db;
  const before = db.prepare('SELECT * FROM notification_jobs').get();
  assert.throws(
    () => migrateNotificationChannels(f.database, f.directory),
    /Invalid staging notification channel/,
  );
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_channel_jobs'").get(),
    undefined,
  );
  assert.deepEqual(db.prepare('SELECT * FROM notification_jobs').get(), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_confirmations').get().n, 1);
});
