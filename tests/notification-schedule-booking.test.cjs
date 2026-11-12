const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { publicSubmit } = require('../src/server/modules/booking/public-service.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const { fail } = require('../src/shared/errors.cjs');

async function fixture(t) {
  const f = await bookingFixture({
    patients: 1,
    notificationSchema: 18,
    scheduledNotifications: true,
  });
  f.setMode('classic');
  const db = createPlatformDatabase(path.join(f.dir, 'platform'), { notificationSchema: 18 });
  t.after(() => {
    db.db.close();
    f.close();
  });
  const patient = f.storage.read().patients[0];
  const token = f.platform.telegram.issueLink(f.org, patient.id, f.owner.accountId);
  f.platform.telegram.consumeLink(token, '456', () => true);
  db.db.prepare('DELETE FROM notification_schedule_dirty').run();
  const input = () => f.input({ phone: patient.phone, lastName: patient.lastName });
  return { ...f, db: db.db, patient, input };
}

test('schema18 real public classic booking commits addressed dirty work and acknowledges durable intent', async (t) => {
  const f = await fixture(t);
  const input = f.input();
  assert.equal(publicSubmit(f.context, f.org, input, f.now).status, 'booked');
  assert.equal(f.db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n, 0);
  assert.ok(
    f.db
      .prepare(
        "SELECT 1 FROM notification_schedule_dirty WHERE kind='client' AND organization_id=? AND subject=?",
      )
      .get(f.org, f.patient.id),
  );
  assert.equal(publicSubmit(f.context, f.org, input, f.now + 1).status, 'booked');
  assert.equal(f.storage.read().patients[0].appointments.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n, 0);
});

test('schema18 classic cabinet-commit/platform-rollback retains intent and recovers due plan without rebooking', async (t) => {
  const f = await fixture(t),
    original = f.platform.bookingRequests.finish;
  const input = f.input();
  f.platform.bookingRequests.finish = () => {
    throw Error('synthetic platform commit gap');
  };
  assert.throws(
    () => publicSubmit(f.context, f.org, input, f.now),
    /synthetic platform commit gap/,
  );
  f.platform.bookingRequests.finish = original;
  assert.equal(f.storage.read().patients[0].appointments.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM notification_schedule_dirty').get().n, 0);
  const coordinator = createNotificationCoordinator({
    platform: f.platform,
    tenantStore: () => f.storage,
    store: f.platform.notificationStore,
    links: f.platform.maxLinks,
    clock: () => f.now,
    providers: {
      telegram: { status: () => ({ configured: true, connected: true, botId: '321' }) },
    },
  });
  coordinator.schedule();
  assert.equal(f.db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM notification_channel_jobs WHERE channel='telegram'").get()
      .n,
    1,
  );
  assert.equal(publicSubmit(f.context, f.org, input, f.now + 1).status, 'booked');
  assert.equal(f.storage.read().patients[0].appointments.length, 1);
});

test('schema18 expiry immediately before classic cabinet commit rolls back appointment and retains recovery hint', async (t) => {
  const f = await fixture(t),
    s = f.platform.notificationSchedule,
    original = s.assertIntent;
  let asserts = 0;
  s.assertIntent = (...args) => {
    if (++asserts === 3) throw fail(409, 'Synthetic expired intent');
    return original(...args);
  };
  const input = f.input();
  assert.throws(() => publicSubmit(f.context, f.org, input, f.now), /Synthetic expired intent/);
  s.assertIntent = original;
  assert.equal(f.storage.read().patients[0].appointments.length, 0);
  assert.equal(f.platform.bookingRequests.byKey(f.org, input.key, f.now), null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n, 1);
});
