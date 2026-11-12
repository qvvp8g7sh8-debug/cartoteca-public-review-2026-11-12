const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  resetNotificationInterests,
} = require('../src/server/infrastructure/backup/notification-state.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE staff_notification_jobs(id TEXT,organization_id TEXT); CREATE TABLE staff_max_jobs(id TEXT,organization_id TEXT);',
  );
  const put = db.prepare('INSERT INTO telegram_runtime VALUES(?,?)');
  const keys = [
    'notification-channel-state-v1',
    'offset',
    'poll-leader',
    'push-interest-v1:ready',
    'push-interest-v1:reminder:synthetic-org-one:device-one',
    'push-interest-v1:created:synthetic-org-two:device-two',
    'client-interest-v1:ready',
    'client-interest-v1:all:synthetic-org-one',
    'client-interest-v1:reminder:synthetic-org-two',
    'staff-interest-v1:telegram:ready',
    'staff-interest-v1:telegram:appointment:' +
      JSON.stringify(['synthetic-org-one', 'synthetic-account-one']),
    'staff-interest-v1:max:created:' +
      JSON.stringify(['synthetic-org-two', 'synthetic-account-two']),
  ];
  for (const key of keys) put.run(key, Buffer.from('{}'));
  return {
    db,
    keys: () =>
      db
        .prepare('SELECT key FROM telegram_runtime ORDER BY key')
        .all()
        .map((row) => row.key),
  };
}
test('scoped restore removes restored organization lookup markers while preserving other organizations and global channel epochs', (t) => {
  const f = fixture(t);
  resetNotificationInterests(f.db, 'synthetic-org-one');
  assert.equal(
    f.keys().some((key) => key.includes('synthetic-org-one')),
    false,
  );
  assert.equal(f.keys().filter((key) => key.includes('synthetic-org-two')).length, 3);
  assert.ok(f.keys().includes('notification-channel-state-v1'));
  assert.ok(f.keys().includes('client-interest-v1:ready'));
  assert.ok(f.keys().includes('staff-interest-v1:telegram:ready'));
});
test('full restore clears derived indexes and sentinels while preserving delivery configuration and polling metadata', (t) => {
  const f = fixture(t);
  resetNotificationInterests(f.db);
  assert.deepEqual(f.keys(), ['notification-channel-state-v1', 'offset', 'poll-leader']);
});
