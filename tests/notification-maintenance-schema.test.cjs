const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  schema,
  validate,
  definitions,
} = require('../src/server/infrastructure/notification-maintenance-schema.cjs');
const { configuration } = require('../src/server/config.cjs');
function fixture(t, version = 19, transform = (sql) => sql) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const table of [
    'notification_channel_jobs',
    'staff_notification_jobs',
    'staff_max_jobs',
    'staff_push_jobs',
  ])
    db.exec(
      `CREATE TABLE ${table}(id TEXT PRIMARY KEY, channel TEXT, status TEXT, next_at INTEGER, lease_until INTEGER, expires_at INTEGER);`,
    );
  db.exec('PRAGMA user_version=' + version);
  db.exec(transform(schema));
  return db;
}
for (const version of [19, 20])
  test(`maintenance component ${version} validates read-only with no platform version change`, (t) => {
    const db = fixture(t, version);
    db.exec('PRAGMA query_only=ON');
    const before = db.prepare('SELECT total_changes() n').get().n;
    assert.deepEqual(validate(db, { required: true }), { version: 1 });
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
  });
for (const [name, transform] of [
  ['missing index', (sql) => sql.replace(definitions[0].sql + ';', '')],
  [
    'changed predicate literal',
    (sql) => sql.replace("WHERE status='pending'", "WHERE status='PENDING'"),
  ],
  [
    'predicate made broad',
    (sql) => sql.replace("WHERE status='pending'", "WHERE status IN ('pending','sending')"),
  ],
  [
    'column order',
    (sql) => sql.replace('(channel,next_at,id,expires_at)', '(channel,id,next_at,expires_at)'),
  ],
  [
    'descending order',
    (sql) => sql.replace('(channel,next_at,id,expires_at)', '(channel,next_at DESC,id,expires_at)'),
  ],
  [
    'nonbinary collation',
    (sql) =>
      sql.replace(
        '(channel,next_at,id,expires_at)',
        '(channel COLLATE NOCASE,next_at,id,expires_at)',
      ),
  ],
  [
    'unexpected uniqueness',
    (sql) =>
      sql.replace('CREATE INDEX nqm_v1_client_ready', 'CREATE UNIQUE INDEX nqm_v1_client_ready'),
  ],
  [
    'registration guard',
    (sql) =>
      sql.replace('CHECK(version=1)', 'CHECK(version=2)').replace('VALUES(1,1)', 'VALUES(1,2)'),
  ],
])
  test(`component refuses ${name} even with feature OFF`, (t) => {
    const db = fixture(t, 19, transform);
    db.exec('PRAGMA query_only=ON');
    assert.throws(() => validate(db), /component schema/);
  });
test('partial component, unknown component indexes and wrong platform version fail closed', (t) => {
  const db = fixture(t);
  db.exec('DELETE FROM notification_queue_maintenance_schema');
  assert.throws(() => validate(db), /component schema/);
  db.exec(
    'INSERT INTO notification_queue_maintenance_schema VALUES(1,1); CREATE INDEX nqm_v1_extra ON staff_max_jobs(id);',
  );
  assert.throws(() => validate(db), /component schema/);
  db.exec('DROP INDEX nqm_v1_extra; PRAGMA user_version=18');
  assert.throws(() => validate(db), /component schema/);
});
test('new index plans cover due ordering, expiry, recovery and retention without BLOB payloads', (t) => {
  const db = fixture(t);
  for (const [sql, index] of [
    [
      "SELECT id,expires_at FROM notification_channel_jobs WHERE channel='telegram' AND status='pending' AND next_at<=10 AND expires_at>10 ORDER BY next_at,id LIMIT 1",
      'client_ready',
    ],
    [
      "SELECT id FROM notification_channel_jobs WHERE channel='max' AND status='reserved' AND lease_until<=10 ORDER BY lease_until,id LIMIT 128",
      'client_reserved',
    ],
    [
      "SELECT id FROM staff_max_jobs WHERE status='sending' AND lease_until<=10 ORDER BY lease_until,id LIMIT 128",
      'max_sending',
    ],
    [
      "SELECT id FROM staff_push_jobs WHERE status IN ('pending','sending') AND expires_at<=10 ORDER BY expires_at,id LIMIT 128",
      'push_expiry',
    ],
    [
      "SELECT id FROM staff_notification_jobs WHERE status IN ('sent','failed','cancelled') AND expires_at<10 ORDER BY expires_at,id LIMIT 128",
      'telegram_retention',
    ],
    [
      "SELECT id FROM staff_max_jobs WHERE status IN ('pending','sending') AND status='pending' AND next_at<=10 AND expires_at>10 ORDER BY next_at,id LIMIT 1",
      'max_ready',
    ],
  ]) {
    const details = db
      .prepare('EXPLAIN QUERY PLAN ' + sql)
      .all()
      .map((row) => row.detail)
      .join('\n');
    assert.match(details, new RegExp('nqm_v1_' + index));
    assert.doesNotMatch(details, /TEMP B-TREE/);
  }
});
test('maintenance flag is explicit, boolean, separate from scheduled018 and disabled by default', () => {
  assert.equal(configuration({}, {}).notificationMaintenanceEnabled, false);
  const config = configuration({}, { CARTOTECA_NOTIFICATION_MAINTENANCE: '1' });
  assert.equal(config.notificationMaintenanceEnabled, true);
  assert.equal(config.scheduledNotifications, false);
  assert.throws(
    () => configuration({ notificationMaintenanceEnabled: '1' }, {}),
    /maintenance flag/,
  );
});
