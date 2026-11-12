const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');

async function fixture(t, enabled) {
  const f = await bookingFixture({
    patients: 1,
    notificationSchema: 18,
    scheduledNotifications: enabled,
  });
  const database = createPlatformDatabase(path.join(f.dir, 'platform'), { notificationSchema: 18 });
  t.after(() => {
    database.db.close();
    f.close();
  });
  const db = database.db;
  db.prepare('DELETE FROM notification_schedule_dirty').run();
  const before = f.storage.readSelected(['synthetic-0']);
  const context = {
    ...f.context,
    current: f.platform.session(f.token),
    token: f.token,
    req: { headers: { 'x-cartoteca-operation': 'synthetic-notification-intent' } },
    assertCurrent() {
      assert.ok(f.platform.session(f.token));
    },
  };
  const body = {
    revision: before.revision,
    patients: [
      {
        id: 'synthetic-0',
        before: before.patients[0],
        after: { ...before.patients[0], notes: 'Synthetic update' },
      },
    ],
    services: [],
  };
  const counts = () => ({
    intents: db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n,
    dirty: db
      .prepare(
        "SELECT count(*) n FROM notification_schedule_dirty WHERE kind='client' AND organization_id=? AND subject=?",
      )
      .get(f.org, 'synthetic-0').n,
  });
  return { ...f, db, context, body, counts };
}

test('schema18 disabled scheduler keeps dirty invalidation without creating durable intents', async (t) => {
  const f = await fixture(t, false);
  let intents = 0;
  const original = f.platform.notificationSchedule.beginIntentAsync;
  f.platform.notificationSchedule.beginIntentAsync = (...args) => {
    intents++;
    return original(...args);
  };
  await saveMutation(f.context, f.body, { partial: true });
  assert.equal(intents, 0);
  assert.deepEqual(f.counts(), { intents: 0, dirty: 1 });
  assert.equal(f.storage.readSelected(['synthetic-0']).patients[0].notes, 'Synthetic update');
});

test('schema18 enabled mutation acknowledges durable intent after cabinet commit', async (t) => {
  const f = await fixture(t, true);
  let intents = 0;
  const original = f.platform.notificationSchedule.beginIntentAsync;
  f.platform.notificationSchedule.beginIntentAsync = (...args) => {
    intents++;
    return original(...args);
  };
  await saveMutation(f.context, f.body, { partial: true });
  assert.equal(intents, 1);
  assert.deepEqual(f.counts(), { intents: 0, dirty: 1 });
});

test('schema18 platform rollback after cabinet commit retains intent for recovery without repeating write', async (t) => {
  const f = await fixture(t, true);
  const s = f.platform.notificationSchedule,
    ack = s.ackIntent;
  s.ackIntent = () => {
    throw Error('Synthetic platform rollback after cabinet commit');
  };
  await assert.rejects(
    saveMutation(f.context, f.body, { partial: true }),
    /Synthetic platform rollback/,
  );
  s.ackIntent = ack;
  assert.deepEqual(f.counts(), { intents: 1, dirty: 0 });
  const revision = f.storage.get('revision');
  assert.equal(f.storage.readSelected(['synthetic-0']).patients[0].notes, 'Synthetic update');
  const result = await saveMutation(f.context, f.body, { partial: true });
  assert.equal(result.revision, revision);
  assert.equal(f.storage.get('revision'), revision);
  let reads = 0;
  s.recoverExpired((org) => {
    assert.equal(org, f.org);
    reads++;
    f.storage.readSelected(['synthetic-0']);
  }, Date.now() + 120001);
  assert.equal(reads, 1);
  assert.equal(f.counts().intents, 0);
  assert.ok(
    f.db
      .prepare(
        "SELECT 1 FROM notification_schedule_dirty WHERE kind='client' AND organization_id=? AND subject=''",
      )
      .get(f.org),
  );
});
