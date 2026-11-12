const test = require('node:test'),
  assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  pausePendingNotifications,
} = require('../src/server/modules/notifications/pause-pending.cjs');
for (const clientOnly of [false, true])
  test('explicit pause cancels waiting work once with correct audience: ' + clientOnly, (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    const tables = [
      'telegram_jobs',
      'notification_channel_jobs',
      'staff_max_jobs',
      'staff_push_jobs',
    ];
    for (const table of tables) {
      db.exec('CREATE TABLE ' + table + '(organization_id TEXT,status TEXT,lease_until INTEGER)');
      db.exec(
        'INSERT INTO ' +
          table +
          " VALUES('one','pending',0),('one','reserved',10),('one','sending',10),('one','sent',0),('two','pending',0)",
      );
    }
    assert.throws(() => pausePendingNotifications({ db }, 'one', clientOnly), /transaction/);
    db.exec('BEGIN');
    pausePendingNotifications({ db }, 'one', clientOnly);
    db.exec('COMMIT');
    for (const table of tables) {
      const paused =
        !clientOnly || table === 'telegram_jobs' || table === 'notification_channel_jobs';
      assert.deepEqual(
        db
          .prepare('SELECT status FROM ' + table)
          .all()
          .map((row) => row.status),
        [
          paused ? 'cancelled' : 'pending',
          paused ? 'cancelled' : 'reserved',
          'sending',
          'sent',
          'pending',
        ],
      );
    }
  });
