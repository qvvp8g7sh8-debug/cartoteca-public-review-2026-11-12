const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createNotificationChannelState,
} = require('../src/server/modules/notifications/channel-state.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL); CREATE TABLE telegram_jobs(status TEXT); CREATE TABLE staff_notification_jobs(status TEXT); CREATE TABLE staff_max_jobs(status TEXT); CREATE TABLE staff_push_jobs(status TEXT); CREATE TABLE notification_channel_jobs(channel TEXT,status TEXT,lease_until INTEGER);',
  );
  return {
    db,
    seal: (value) => Buffer.from(JSON.stringify(value)),
    open: (value) => JSON.parse(Buffer.from(value).toString()),
    transaction: (work) => {
      db.exec('BEGIN');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
test('unmanaged and passive configurations do not access storage', () => {
  const c = {
    db: {
      prepare: () => {
        throw Error('Unexpected storage access');
      },
    },
  };
  assert.equal(createNotificationChannelState(c).enabled('telegram'), true);
  assert.equal(createNotificationChannelState(c, { passive: true }).enabled('telegram'), false);
});
test('global disable cancels only never-started work for that channel once', (t) => {
  const c = fixture(t),
    flags = { telegram: true, max: true, push: true };
  const active = createNotificationChannelState(c, flags);
  assert.equal(active.version('telegram'), '');
  c.db.exec(
    "INSERT INTO telegram_jobs VALUES('pending'),('sending'),('sent'); INSERT INTO staff_notification_jobs VALUES('pending'),('sending'); INSERT INTO staff_max_jobs VALUES('pending'); INSERT INTO staff_push_jobs VALUES('pending'); INSERT INTO notification_channel_jobs VALUES('telegram','pending',0),('telegram','reserved',10),('telegram','sending',10),('max','pending',0);",
  );
  const disabled = createNotificationChannelState(c, { ...flags, telegram: false });
  assert.equal(disabled.enabled('telegram'), false);
  assert.equal(active.enabled('telegram'), false);
  assert.notEqual(disabled.version('telegram'), '');
  assert.deepEqual(
    c.db
      .prepare('SELECT status FROM telegram_jobs')
      .all()
      .map((row) => row.status),
    ['cancelled', 'sending', 'sent'],
  );
  assert.deepEqual(
    c.db
      .prepare('SELECT status FROM notification_channel_jobs')
      .all()
      .map((row) => row.status),
    ['cancelled', 'cancelled', 'sending', 'pending'],
  );
  assert.equal(c.db.prepare('SELECT status FROM staff_max_jobs').get().status, 'pending');
  assert.equal(c.db.prepare('SELECT status FROM staff_push_jobs').get().status, 'pending');
  const before = c.db.prepare('SELECT total_changes() n').get().n;
  createNotificationChannelState(c, { ...flags, telegram: false });
  assert.equal(c.db.prepare('SELECT total_changes() n').get().n, before);
});
test('disable then enable rotates the channel epoch without rewriting accepted or in-flight jobs', (t) => {
  const c = fixture(t),
    flags = { telegram: true, max: true, push: true };
  const original = createNotificationChannelState(c, flags).version('max');
  c.db.exec("INSERT INTO staff_max_jobs VALUES('pending'),('sending'),('sent'),('uncertain');");
  const off = createNotificationChannelState(c, { ...flags, max: false }).version('max');
  const on = createNotificationChannelState(c, flags);
  assert.equal(on.enabled('max'), true);
  assert.notEqual(on.version('max'), original);
  assert.notEqual(on.version('max'), off);
  assert.deepEqual(
    c.db
      .prepare('SELECT status FROM staff_max_jobs')
      .all()
      .map((row) => row.status),
    ['cancelled', 'sending', 'sent', 'uncertain'],
  );
});
for (const mode of ['channel-off', 'reminder-off'])
  test('legacy scheduler avoids cabinet reads and claims: ' + mode, async () => {
    const unexpected = () => {
      throw Error('Disabled work reached storage');
    };
    const store = {
      settings: unexpected,
      organizations: unexpected,
      organizationBatch: unexpected,
      claim: unexpected,
      hasReminderRecipients: () => false,
    };
    const runtime = createTelegramRuntime({
      platform: {
        telegram: store,
        notificationChannels: { enabled: () => mode !== 'channel-off', version: () => '' },
      },
      tenantStore: unexpected,
      bot: { initialize: async () => ({ username: 'SyntheticBot', botId: '1' }) },
    });
    await runtime.initialize();
    assert.equal(runtime.schedule(), true);
    assert.equal(await runtime.scheduleBatched(), true);
    await runtime.tick();
  });
