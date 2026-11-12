const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { connectFresh } = require('./helpers/staff-push-connect.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const { createPushSchedule } = require('../src/server/modules/notifications/push-events.cjs');

function subscription(index = 'storage') {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-' + index,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

test('queued booking delivers with real empty SQLite calendar, without an open application session', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const cabinet = createStorage(path.join(f.source, 'synthetic-tenant'));
  try {
    cabinet.write({ revision: 0, services: [], patients: [] });
    const store = f.platform.staffPush;
    connectFresh(store, f.users[0].token, subscription());
    const request = f.create();
    assert.ok(request.id);
    assert.equal(f.database.db.prepare('SELECT count(*) n FROM staff_push_jobs').get().n, 1);
    // Login expiry is not logout: a connected device remains a valid recipient.
    f.database.db.prepare('UPDATE platform_sessions SET expires_at=?').run(Date.now() - 1);
    const deliveries = [];
    const runtime = createPushRuntime({
      platform: f.platform,
      tenantStore: () => cabinet,
      origin: 'https://synthetic.test',
      enabled: true,
      send: async (sub, payload, options) => {
        // Build the real encrypted provider request, but never perform network I/O.
        const providerRequest = require('web-push').generateRequestDetails(sub, payload, options);
        assert.equal(providerRequest.headers.Topic, options.topic);
        assert.ok(providerRequest.body.length > 0);
        deliveries.push({ payload: JSON.parse(payload), options });
      },
    });
    runtime.start();
    try {
      await runtime.tick();
      await runtime.tick();
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].payload.data.event, 'new-request');
      assert.doesNotMatch(JSON.stringify(deliveries[0].payload), /PRIVATE|79990000000/);
      assert.equal(deliveries[0].options.vapidDetails.subject, 'https://synthetic.test');
      assert.match(deliveries[0].options.topic, /^[A-Za-z0-9_-]{1,32}$/);
      assert.deepEqual(
        { ...f.database.db.prepare('SELECT status,attempts FROM staff_push_jobs').get() },
        { status: 'sent', attempts: 1 },
      );
    } finally {
      runtime.stop();
    }
  } finally {
    cabinet.close();
  }
});

test('workday reminder crosses midnight without appointments and stays once per device/day', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const s = f.platform.staffPush,
    org = f.owner.organizationId;
  let now = Date.parse('2030-01-01T19:15:00Z') - 1; // Moscow 22:15, work starts tomorrow 00:15.
  const devices = f.users.map((user, index) => connectFresh(s, user.token, subscription(index)).device);
  const day = (staff, value) =>
    f.database.db
      .prepare('INSERT OR REPLACE INTO work_schedule_days VALUES(?,?,?,?)')
      .run(org, staff, '2030-01-02', f.database.seal(value));
  day(f.users[2].accountId, {
    status: 'working',
    intervals: [
      ['00:15', '02:00'],
      ['04:00', '06:00'],
    ],
  });
  day(f.users[0].accountId, { status: 'working', intervals: [['03:00', '06:00']] });
  day(f.users[3].accountId, { status: 'closed', intervals: [] });
  const schedule = createPushSchedule(
    f.platform,
    () => {
      throw Error('No clinical reads');
    },
    s,
    () => now,
  );
  schedule.schedule();
  assert.equal(s.claim(now), null);
  now++;
  schedule.schedule();
  schedule.schedule();
  const job = s.claim(now);
  assert.equal(job.account_id, f.users[2].accountId);
  assert.equal(job.device_id, devices[2].id);
  assert.equal(job.decoded.reference.kind, 'workday');
  assert.equal(schedule.current(job), true);
  s.finish(job, 'sent');
  day(f.users[2].accountId, { status: 'working', intervals: [['00:30', '02:00']] });
  now += 15 * 60000;
  assert.equal(schedule.current(job), false);
  schedule.schedule();
  s.update(f.users[2].token, {
    deviceId: devices[2].id,
    preferences: { events: ['reminder'], leadMinutes: 120 },
  });
  schedule.schedule();
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM staff_push_jobs').get().n, 1);
  assert.equal(f.database.db.prepare('SELECT status FROM staff_push_jobs').get().status, 'sent');
});

test('workday settings, closures, moved start and expired login are rechecked without duplicates', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    s = f.platform.staffPush;
  const user = f.users[2],
    date = '2030-01-02';
  const device = connectFresh(s, user.token, subscription()).device;
  assert.equal(device.preferences.leadMinutes, 120);
  s.update(user.token, {
    deviceId: device.id,
    preferences: { events: ['reminder'], leadMinutes: 45 },
  });
  let now = Date.parse('2030-01-02T05:00:00Z'); // 08:00 Moscow, work starts 10:00.
  const day = (staff, value) =>
    f.database.db
      .prepare('INSERT OR REPLACE INTO work_schedule_days VALUES(?,?,?,?)')
      .run(user.organizationId, staff, date, f.database.seal(value));
  day(user.accountId, { status: 'working', intervals: [['10:00', '12:00']] });
  const schedule = createPushSchedule(
    f.platform,
    () => {
      throw Error('No clinical reads');
    },
    s,
    () => now,
  );
  schedule.schedule();
  assert.equal(s.claim(now), null);
  now += 75 * 60000;
  f.database.db.prepare('UPDATE platform_sessions SET expires_at=?').run(Date.now() - 1);
  schedule.schedule();
  const job = s.claim(now);
  assert.ok(s.valid(job, now));
  assert.equal(schedule.current(job), true);
  day('organization', { status: 'closed', intervals: [] });
  assert.equal(schedule.current(job), false);
  s.finish(job, 'cancelled');
  schedule.schedule();
  assert.equal(s.claim(now), null);
  day('organization', { status: 'reset', intervals: [] });
  day(user.accountId, { status: 'working', intervals: [['10:15', '12:00']] });
  now += 15 * 60000;
  schedule.schedule();
  const moved = s.claim(now);
  assert.equal(moved.id, job.id);
  assert.equal(schedule.current(moved), true);
  s.finish(moved, 'pending', now + 30000);
  schedule.schedule(); // Polling must preserve delivery backoff.
  assert.equal(s.claim(now), null);
  day(user.accountId, { status: 'working', intervals: [['10:10', '12:00']] });
  schedule.schedule();
  const refreshed = s.claim(now);
  assert.equal(refreshed.id, job.id);
  assert.equal(schedule.current(refreshed), true);
  now = refreshed.expires_at;
  assert.equal(schedule.current(refreshed), false);
  assert.equal(
    schedule.current({
      ...refreshed,
      decoded: { event: 'reminder', reference: { kind: 'appointment' } },
    }),
    false,
  );
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM staff_push_jobs').get().n, 1);
});

test('legacy appointment intervals become the two-hour workday default without overwriting stored data', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 }),
    s = f.platform.staffPush;
  const user = f.users[0],
    sub = subscription();
  const device = connectFresh(s, user.token, sub).device;
  const row = f.database.db
    .prepare('SELECT value FROM staff_push_devices WHERE id=?')
    .get(device.id);
  const value = f.database.open(row.value);
  value.preferences = { events: ['change', 'reminder'], leadMinutes: 30 };
  f.database.db
    .prepare('UPDATE staff_push_devices SET value=? WHERE id=?')
    .run(f.database.seal(value), device.id);
  assert.equal(s.status(user.token, sub.endpoint).device.preferences.leadMinutes, 120);
  assert.equal(s.device(device.id).decoded.preferences.reminderMode, 'workday');
  assert.equal(
    f.database.open(
      f.database.db.prepare('SELECT value FROM staff_push_devices WHERE id=?').get(device.id).value,
    ).preferences.leadMinutes,
    30,
  );
  s.update(user.token, {
    deviceId: device.id,
    preferences: { events: ['reminder'], leadMinutes: 60 },
  });
  assert.equal(s.device(device.id).decoded.preferences.leadMinutes, 60);
  assert.deepEqual(s.device(device.id).decoded.preferences.events, ['reminder']);
});
