const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createPushActivity } = require('../src/server/modules/notifications/push-activity.cjs');

function projection(db, channel = { enabled: true, version: 'epoch-1' }) {
  return createPushActivity({
    db,
    open: (value) => value,
    seal: (value) => value,
    transaction: (callback) => callback(),
    notificationChannels: {
      enabled: () => channel.enabled,
      version: () => channel.version,
    },
  });
}
function postgresProjection() {
  const state = {
    revision: 10,
    clock: 0,
    transaction: false,
    row: null,
    probes: 0,
    revisions: 0,
  };
  const db = {
    dialect: 'postgres',
    revisionProfile: 2,
    get isTransaction() {
      return state.transaction;
    },
    get localMutationClock() {
      return state.clock;
    },
    prepare(sql) {
      if (sql === 'PRAGMA data_version')
        return {
          get() {
            state.revisions++;
            return { data_version: state.revision };
          },
        };
      if (sql.includes('SELECT status,next_at,lease_until,expires_at FROM staff_push_jobs'))
        return {
          get() {
            state.probes++;
            return state.row && { ...state.row };
          },
        };
      if (sql.startsWith('SELECT total_changes()'))
        throw Error('PostgreSQL revision must be read once per observation.');
      return {};
    },
  };
  const channel = { enabled: true, version: 'epoch-1' };
  return { state, channel, activity: projection(db, channel) };
}
const due = { status: 'pending', next_at: 100, lease_until: 0, expires_at: 10000 };

test('Push probe invalidates a cached absence on a local write even when the transaction revision is unchanged', () => {
  const f = postgresProjection();
  assert.equal(f.activity.hasPendingTests(200), false);
  assert.equal(f.activity.hasPendingTests(200), false);
  assert.equal(f.state.probes, 1);
  f.state.clock++;
  f.state.row = due;
  assert.equal(f.activity.hasPendingTests(200), true);
  assert.equal(f.state.probes, 2);
  assert.equal(f.state.revisions, 3);
});

test('Push does not retain an uncommitted candidate or an ABA cache after rollback', () => {
  const f = postgresProjection();
  assert.equal(f.activity.hasPendingTests(200), false);
  f.state.transaction = true;
  f.state.clock++;
  f.state.row = due;
  assert.equal(f.activity.hasPendingTests(200), true);
  f.state.row = null;
  f.state.clock++;
  assert.equal(f.activity.hasPendingTests(200), false);
  f.state.transaction = false;
  f.state.clock++;
  assert.equal(f.activity.hasPendingTests(200), false);
  f.state.row = due;
  f.state.clock++;
  assert.equal(f.activity.hasPendingTests(200), true);
});

test('Push invalidates cross-owner queue changes and channel epochs without enabling a disabled transport', () => {
  const f = postgresProjection();
  f.state.row = due;
  assert.equal(f.activity.hasPendingTests(200), true);
  f.state.row = null;
  f.state.revision++;
  assert.equal(f.activity.hasPendingTests(200), false);
  f.state.row = due;
  f.channel.version = 'epoch-2';
  assert.equal(f.activity.hasPendingTests(200), true);
  f.channel.enabled = false;
  const before = f.state.probes;
  assert.equal(f.activity.hasPendingTests(200), false);
  assert.equal(f.state.probes, before);
});

test('SQLite Push probes preserve rollback and committed-write invalidation', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB);
    CREATE TABLE organizations(id TEXT PRIMARY KEY);
    CREATE TABLE staff_push_jobs(event_key TEXT,status TEXT,next_at INTEGER,lease_until INTEGER,expires_at INTEGER);`);
  const activity = projection(db);
  assert.equal(activity.hasPendingTests(200), false);
  db.exec('BEGIN');
  db.prepare('INSERT INTO staff_push_jobs VALUES(?,?,?,?,?)').run(
    'self-test',
    'pending',
    100,
    0,
    10000,
  );
  assert.equal(activity.hasPendingTests(200), true);
  db.exec('ROLLBACK');
  assert.equal(activity.hasPendingTests(200), false);
  db.prepare('INSERT INTO staff_push_jobs VALUES(?,?,?,?,?)').run(
    'self-test',
    'pending',
    100,
    0,
    10000,
  );
  assert.equal(activity.hasPendingTests(200), true);
});
