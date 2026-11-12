const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { configuration } = require('../src/server/config.cjs');
const {
  notificationSchema,
  assertPreparedNotifications,
} = require('../src/server/application/startup-schema.cjs');

test('future scheduler requires explicit schema18 and leaves existing Push defaults unchanged', () => {
  const defaults = configuration({ pushEnabled: true }, {});
  assert.equal(defaults.scheduledNotifications, false);
  assert.equal(notificationSchema(defaults, {}), 17);
  const enabled = configuration(
    {},
    { CARTOTECA_PUSH_ENABLED: '1', CARTOTECA_SCHEDULED_NOTIFICATIONS: '1' },
  );
  assert.equal(enabled.scheduledNotifications, true);
  assert.throws(() => notificationSchema(enabled, {}), { status: 503 });
  assert.throws(() => notificationSchema({ ...enabled, notificationSchema: 17 }, {}), {
    status: 503,
  });
  assert.equal(notificationSchema({ ...enabled, notificationSchema: 18 }, {}), 18);
  assert.equal(notificationSchema(enabled, { CARTOTECA_MAX_SCHEMA: '18' }), 18);
  assert.equal(
    notificationSchema({ notificationSchema: 18, scheduledNotifications: false }, {}),
    18,
  );
});

test('prepared schema18 gate is read-only and requires all scheduling tables', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-startup-schema-'));
  const parent = path.join(directory, 'platform');
  fs.mkdirSync(parent);
  const db = new DatabaseSync(path.join(parent, 'platform.sqlite'));
  t.after(() => {
    db.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.match(path.basename(target), /^cartoteca-startup-schema-/);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const table of [
    'max_client_links',
    'notification_channel_jobs',
    'notification_confirmations',
    'max_event_inbox',
    'max_runtime_leases',
    'staff_max_links',
    'staff_max_tokens',
    'staff_max_jobs',
    'staff_max_stops',
    'staff_push_config',
    'staff_push_devices',
    'staff_push_jobs',
    'notification_schedule',
    'notification_schedule_dirty',
  ])
    db.exec('CREATE TABLE ' + table + '(synthetic INTEGER)');
  db.exec('PRAGMA user_version=18');
  assert.throws(() => assertPreparedNotifications(directory, 18), { status: 503 });
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_schedule_intents'").get(),
    undefined,
  );
  db.exec('CREATE TABLE notification_schedule_intents(synthetic INTEGER)');
  assert.doesNotThrow(() => assertPreparedNotifications(directory, 18));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  db.exec('PRAGMA user_version=17');
  assert.throws(() => assertPreparedNotifications(directory, 18), { status: 503 });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    tables,
  );
});
