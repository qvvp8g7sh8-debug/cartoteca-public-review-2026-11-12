const test = require('node:test');
const assert = require('node:assert/strict');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const {
  createAppointmentStateReader,
} = require('../src/server/modules/notifications/appointment-state-reader.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
const {
  appointmentRows,
  pairKey,
} = require('../src/server/modules/notifications/appointment-state-batch.cjs');

function fixture(t) {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  const a = {
    id: 'frame',
    date: '2099-01-01',
    time: '12:00',
    duration: 30,
    staffId: 'owner',
    service: 'Synthetic',
    roomId: 'room',
  };
  f.patients[0].appointments.push(a);
  const zone = f.platform.organizationTimeZone('org'),
    c = f.platform.appointmentConfirmations;
  f.database.db
    .prepare('INSERT INTO telegram_links VALUES(?,?,?,?)')
    .run('org', 'p', 'synthetic-chat', f.database.seal({ chatId: 'synthetic-chat', linkedAt: 1 }));
  f.database.db
    .prepare('INSERT INTO telegram_confirmations VALUES(?,?,?,?,?)')
    .run('org', 'p', fingerprint(a, zone), 'synthetic-chat', 10);
  function manual(appointment, at) {
    f.database.db
      .prepare('INSERT OR REPLACE INTO appointment_manual_confirmations VALUES(?,?,?,?)')
      .run(
        'org',
        'p',
        appointment.id,
        f.database.seal({ stamp: c.stamp(appointment, zone), actorId: 'owner', confirmedAt: at }),
      );
  }
  function receipt(appointment, at) {
    f.database.db
      .prepare('INSERT OR REPLACE INTO notification_confirmations VALUES(?,?,?,?,?)')
      .run(
        'org',
        'p',
        appointment.id,
        c.stamp(appointment, zone),
        f.database.seal({ notificationConfirmedAt: at, notificationConfirmedChannel: 'telegram' }),
      );
  }
  manual(a, 20);
  receipt(a, 30);
  const counts = { settings: 0, legacy: 0, manual: 0, receipts: 0, selected: 0 };
  let active = false;
  const platform = {
    ...f.platform,
    withReadSnapshot(work) {
      assert.equal(active, false);
      active = true;
      try {
        return f.platform.withReadSnapshot(work);
      } finally {
        active = false;
      }
    },
    telegram: {
      ...f.platform.telegram,
      settings(org) {
        counts.settings++;
        return f.platform.telegram.settings(org);
      },
      confirmedMany(org, entries) {
        counts.legacy++;
        return f.platform.telegram.confirmedMany(org, entries);
      },
    },
    appointmentConfirmations: {
      ...c,
      readMany(org, entries) {
        counts.manual++;
        return c.readMany(org, entries);
      },
    },
  };
  const original = createNotificationStore(f.database);
  const store = {
    ...original,
    readMany(...args) {
      counts.receipts++;
      return original.readMany(...args);
    },
  };
  const tenantStore = (org) => ({
    ...f.tenantStore(org),
    get: () => null,
    readSelected(ids) {
      counts.selected++;
      return f.tenantStore(org).readSelected(ids);
    },
  });
  const coordinator = createNotificationCoordinator({
    platform,
    tenantStore,
    store,
    links: f.links,
    providers: {
      telegram: { status: () => ({ configured: true, connected: true, botId: 'bot' }) },
    },
    clock: () => f.now,
  });
  const reader = createAppointmentStateReader({
    platform,
    store: platform.telegram,
    tenantStore,
    coordinator,
  });
  const reset = () => Object.keys(counts).forEach((key) => (counts[key] = 0));
  const read = (patients = structuredClone(f.patients), org = 'org') => {
    const result = reader({ patients }, org);
    assert.equal(active, false, 'the owning snapshot has ended before the response is returned');
    return result.patients[0].appointments[0];
  };
  const scalar = (appointment = a, org = 'org') => coordinator.describe(org, 'p', appointment);
  return { ...f, a, zone, counts, reset, read, scalar, coordinator, manual, receipt };
}

test('one response frame reuses matching settings and confirmation batches; later responses and scalar calls stay fresh', (t) => {
  const f = fixture(t),
    expected = f.scalar();
  f.reset();
  const first = f.read();
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(first[key], value);
  assert.equal(first.telegramConfirmedAt, 10);
  assert.equal(first.manualConfirmedAt, 20);
  assert.equal(first.notificationConfirmedAt, 30);
  assert.deepEqual(f.counts, { settings: 1, legacy: 1, manual: 1, receipts: 1, selected: 1 });
  // The prior response has ended. Do not retain its settings or confirmation maps.
  f.manual(f.a, 45);
  f.database.db.prepare('DELETE FROM telegram_links WHERE organization_id=?').run('org');
  f.database.db
    .prepare('INSERT OR REPLACE INTO telegram_settings VALUES(?,?)')
    .run('org', f.database.seal({ enabled: true, events: [] }));
  f.database.db
    .prepare("UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?")
    .run('org', 'owner');
  f.reset();
  const next = f.read();
  assert.equal(next.manualConfirmedAt, 45);
  assert.equal(next.telegramConfirmedAt, null);
  assert.equal(next.deliveryStatus, 'disabled');
  assert.deepEqual(next.deliveryChannels, []);
  assert.deepEqual(f.counts, { settings: 1, legacy: 1, manual: 1, receipts: 1, selected: 1 });
  // Default describeMany callers carry no borrowed response context and retain fresh batch reads.
  f.reset();
  f.coordinator.describeMany('org', f.patients);
  assert.equal(f.counts.settings, 1);
  assert.equal(f.counts.legacy, 1);
  assert.equal(f.counts.manual, 1);
  assert.equal(f.counts.receipts, 2);
});

test('stale/rescheduled same IDs and a foreign organization never reuse mismatching response batches', (t) => {
  const f = fixture(t),
    stale = structuredClone(f.patients),
    old = stale[0].appointments[0];
  f.a.time = '13:00';
  f.a.roomId = 'changed-room';
  f.manual(f.a, 60);
  f.database.db
    .prepare('DELETE FROM notification_confirmations WHERE organization_id=?')
    .run('org');
  f.receipt(f.a, 70);
  f.database.db.prepare('DELETE FROM telegram_links WHERE organization_id=?').run('org');
  const expected = f.scalar(old);
  f.reset();
  const result = f.read(stale);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value);
  assert.equal(
    result.manualConfirmedAt,
    null,
    'the visible old identity cannot borrow a new manual stamp',
  );
  assert.equal(result.notificationConfirmedAt, undefined);
  assert.equal(
    result.deliveryStatus,
    null,
    'fresh policy sees the new receipt despite no available channels',
  );
  assert.equal(f.counts.settings, 1);
  assert.equal(f.counts.legacy, 2);
  assert.equal(f.counts.manual, 2);
  assert.equal(f.counts.receipts, 2);
  assert.equal(f.counts.selected, 1, 'the policy still rereads authoritative appointments');
  f.reset();
  const foreign = f.read(stale, 'other-org');
  assert.equal(foreign.telegramConfirmedAt, null);
  assert.equal(foreign.manualConfirmedAt, null);
  assert.equal(foreign.notificationConfirmedAt, undefined);
  assert.deepEqual(foreign.deliveryChannels, []);
  assert.equal(f.counts.legacy, 2, 'foreign same IDs do not match the policy tenant snapshot');
  assert.equal(f.counts.manual, 2);
  assert.equal(f.counts.receipts, 2);
});

test('fresh policy identity must match both borrowed confirmation identities and outer receipt identities', (t) => {
  const f = fixture(t);
  for (const table of [
    'appointment_manual_confirmations',
    'telegram_confirmations',
    'notification_confirmations',
    'telegram_links',
  ])
    f.database.db.prepare('DELETE FROM ' + table + ' WHERE organization_id=?').run('org');
  const fresh = structuredClone(f.patients),
    stale = structuredClone(f.patients);
  stale[0].appointments[0].time = '14:00';
  stale[0].appointments[0].roomId = 'stale-room';
  const rows = (patients) => appointmentRows(patients, f.zone, f.platform.appointmentConfirmations);
  const settings = f.platform.telegram.settings('org'),
    key = pairKey('p', f.a.id);
  const poison = {
    manual: new Map([[key, { manualConfirmedAt: 999, manualConfirmedBy: 'synthetic-poison' }]]),
    legacy: new Map([[key, 999]]),
  };
  for (const [label, outer, nested] of [
    ['fresh outer / stale borrowed maps', fresh, stale],
    ['stale outer receipts / fresh borrowed maps', stale, fresh],
  ]) {
    f.reset();
    const result = f.platform
      .withReadSnapshot(() =>
        f.coordinator.describeMany('org', outer, {
          zone: f.zone,
          entries: rows(outer),
          responseRead: {
            organizationId: 'org',
            zone: f.zone,
            settings,
            entries: rows(nested),
            ...poison,
          },
        }),
      )
      .get(key);
    assert.equal(result.deliveryStatus, 'blocked', label);
    assert.deepEqual(result.deliveryChannels, [], label);
    assert.equal(result.notificationConfirmedAt, undefined, label);
    assert.equal(JSON.stringify(result).includes('synthetic-poison'), false, label);
    assert.equal(f.counts.manual, 1, label);
    assert.equal(f.counts.legacy, 1, label);
    assert.equal(f.counts.receipts, 2, label);
    assert.equal(f.counts.selected, 1, label);
  }
});
