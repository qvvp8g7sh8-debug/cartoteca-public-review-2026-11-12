const test = require('node:test');
const assert = require('node:assert/strict');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const {
  createNotificationChannelState,
} = require('../src/server/modules/notifications/channel-state.cjs');
const {
  createNotificationPolicy,
} = require('../src/server/modules/notifications/notification-policy.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const {
  createAppointmentStateReader,
} = require('../src/server/modules/notifications/appointment-state-reader.cjs');
const channelKey = 'notification-channel-state-v1';

function fixture(t) {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  let channelReads = 0;
  const measured = new Proxy(f.database.db, {
    get(target, name) {
      if (name === 'prepare')
        return (sql) => {
          const statement = target.prepare(sql);
          if (sql !== 'SELECT value FROM telegram_runtime WHERE key=?') return statement;
          return {
            get(key) {
              if (key === channelKey) channelReads++;
              return statement.get(key);
            },
          };
        };
      const value = target[name];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const notificationChannels = createNotificationChannelState(
    { ...f.database, db: measured },
    { telegram: true, max: true, push: false },
  );
  const platform = {
    ...f.platform,
    notificationChannels,
    withReadSnapshot: f.database.readOnlySnapshot,
  };
  const providers = {
    telegram: { status: () => ({ configured: true, connected: true, botId: '456' }) },
    max: { status: () => ({ configured: true, connected: true, botId: '123' }) },
  };
  for (let i = 0; i < 40; i++)
    f.patients[0].appointments.push({
      id: 'synthetic-appointment-' + i,
      staffId: 'owner',
      date: '2099-01-01',
      time: '10:00',
      duration: 30,
      service: 'Synthetic',
    });
  const issue = f.links.issue('org', 'p', 'owner', '123', () => {}, f.now);
  f.links.consume(issue.token, '123', '111', () => {}, f.now);
  const store = createNotificationStore(f.database);
  const options = {
    platform,
    tenantStore: f.tenantStore,
    store,
    links: f.links,
    providers,
    clock: () => f.now,
  };
  const coordinator = createNotificationCoordinator(options);
  const reader = createAppointmentStateReader({
    platform,
    store: platform.telegram,
    tenantStore: f.tenantStore,
    coordinator,
  });
  function setMax(enabled) {
    const row = f.database.db
      .prepare('SELECT value FROM telegram_runtime WHERE key=?')
      .get(channelKey);
    const value = f.database.open(row.value);
    value.max = { enabled, version: enabled ? 'synthetic-enabled' : 'synthetic-disabled' };
    f.database.db
      .prepare('UPDATE telegram_runtime SET value=? WHERE key=?')
      .run(f.database.seal(value), channelKey);
  }
  return {
    ...f,
    platform,
    setMax,
    policy: createNotificationPolicy(options),
    read(org = 'org') {
      channelReads = 0;
      const result = reader({ patients: structuredClone(f.patients) }, org);
      return { result, channelReads };
    },
    reset: () => {
      channelReads = 0;
    },
    channelReads: () => channelReads,
  };
}

test('one response reads channel SQL once per channel, with fresh values on the next response', (t) => {
  const f = fixture(t);
  const first = f.read();
  assert.equal(first.channelReads, 2, '40 appointments do not cause 80 channel row reads');
  assert.equal(first.result.patients[0].appointments.length, 40);
  for (const appointment of first.result.patients[0].appointments)
    assert.deepEqual(appointment.deliveryChannels, ['max']);
  f.setMax(false);
  const stopped = f.read();
  assert.equal(stopped.channelReads, 2);
  for (const appointment of stopped.result.patients[0].appointments)
    assert.deepEqual(appointment.deliveryChannels, []);
  f.setMax(true);
  assert.deepEqual(f.read().result.patients[0].appointments[0].deliveryChannels, ['max']);
});

test('response channel reuse does not cross organizations or retain revoked staff authority', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.read().result.patients[0].appointments[0].deliveryChannels, ['max']);
  const foreign = f.read('other-org');
  assert.equal(foreign.channelReads, 0, 'an empty fresh selection needs no channel SQL');
  assert.deepEqual(foreign.result.patients[0].appointments[0].deliveryChannels, []);
  f.database.db
    .prepare("UPDATE memberships SET status='suspended' WHERE organization_id=? AND account_id=?")
    .run('org', 'owner');
  assert.deepEqual(f.read().result.patients[0].appointments[0].deliveryChannels, []);
});

test('scalar policy and send guards reread channel changes inside the same transaction', (t) => {
  const f = fixture(t);
  const appointment = f.patients[0].appointments[0];
  f.database.readOnlySnapshot(() => {
    f.reset();
    assert.deepEqual(f.policy.current('org', 'p', appointment.id).channels, ['max']);
    assert.equal(f.channelReads(), 2);
  });
  f.database.transaction(() => {
    f.reset();
    assert.deepEqual(f.policy.current('org', 'p', appointment.id).channels, ['max']);
    f.setMax(false);
    assert.deepEqual(f.policy.current('org', 'p', appointment.id).channels, []);
    assert.equal(f.channelReads(), 4, 'current(..., null) retains fresh scalar authority checks');
  });
});
