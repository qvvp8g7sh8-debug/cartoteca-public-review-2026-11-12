const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { connectFresh } = require('./helpers/staff-push-connect.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const {
  createPushActivity,
  resetPushNotificationInterest,
} = require('../src/server/modules/notifications/push-activity.cjs');
const { createPushQueue } = require('../src/server/modules/notifications/push-queue.cjs');
const { createWorkdayPush } = require('../src/server/modules/notifications/push-workday.cjs');
const { pushAppointmentChanges } = require('../src/server/modules/notifications/push-events.cjs');
function subscription(label) {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-disabled-' + label,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}
const preferences = (events) => ({ events, leadMinutes: 120 });
const forbidden = () =>
  assert.fail('Inactive Push must not scan organizations, workdays or cabinets');
function runtimeFixture(t, options = {}) {
  const state = {
    available: true,
    interest: false,
    tests: false,
    claims: 0,
    sent: 0,
    finished: [],
    jobs: [],
  };
  const sub = subscription('runtime');
  const store = {
    setRuntimeAvailable(value) {
      state.available = value;
    },
    runtimeAvailable: () => state.available,
    hasEnabledEvents: (_org, kind) => state.interest && kind !== 'reminder',
    hasPendingTests: () => state.tests,
    organizationPage: forbidden,
    organizations: forbidden,
    claim() {
      state.claims++;
      return state.jobs.shift() || null;
    },
    valid: () => ({ decoded: { subscription: sub } }),
    finish: (job, status) => state.finished.push([job.id, status]),
    keys: () => ({ publicKey: 'synthetic', privateKey: 'synthetic' }),
  };
  const runtime = createPushRuntime({
    platform: { staffPush: store, workSchedules: { publicDays: forbidden, futureDays: forbidden } },
    tenantStore: forbidden,
    origin: 'https://synthetic.test',
    enabled: true,
    send: async () => {
      state.sent++;
    },
    ...options,
  });
  t.after(() => runtime.stop());
  const queueTest = () =>
    state.jobs.push({
      id: 'synthetic-probe',
      organization_id: 'synthetic-org',
      event_key: 'synthetic-probe',
      expires_at: Date.now() + 60000,
      attempts: 1,
      decoded: { event: 'test', reference: {} },
    });
  return { state, store, runtime, queueTest };
}
test('disabled or unprepared Push does not claim jobs or start reminder planning', async (t) => {
  for (const options of [{ enabled: false }, { origin: 'http://synthetic.test' }]) {
    const f = runtimeFixture(t, options);
    f.runtime.start();
    await f.runtime.tick();
    assert.equal(f.state.available, false);
    assert.equal(f.runtime.available, false);
    assert.equal(f.state.claims, 0);
    assert.equal(f.state.sent, 0);
  }
});
test('empty Push interests skip claims but an explicit probe still sends without reminder reads', async (t) => {
  const f = runtimeFixture(t);
  f.runtime.start();
  await f.runtime.tick();
  assert.equal(f.state.claims, 0);
  f.state.tests = true;
  f.queueTest();
  await f.runtime.tick();
  assert.equal(f.state.sent, 1);
  assert.deepEqual(f.state.finished, [['synthetic-probe', 'sent']]);
  f.state.tests = false;
  f.state.interest = true;
  await f.runtime.tick();
  assert.ok(f.state.claims > 0, 'an active non-reminder category may drain its queue');
});
test('global off during a provider acknowledgement still records that one accepted send', async (t) => {
  let accept, sending;
  const entered = new Promise((resolve) => {
    sending = resolve;
  });
  const gate = new Promise((resolve) => {
    accept = resolve;
  });
  const f = runtimeFixture(t, {
    send: async () => {
      sending();
      await gate;
    },
  });
  f.state.tests = true;
  f.queueTest();
  f.runtime.start();
  const tick = f.runtime.tick();
  await entered;
  f.state.available = false;
  accept();
  await tick;
  assert.deepEqual(f.state.finished, [['synthetic-probe', 'sent']]);
  assert.equal(f.state.claims, 1, 'global off fences the following claim');
});
test('Push interest markers survive unrelated writes without collection decrypts and reset per organization', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0];
  const first = connectFresh(store, user.token, subscription('marker-one')).device;
  const second = connectFresh(store, user.token, subscription('marker-two')).device;
  let decrypts = 0;
  const activity = createPushActivity({
    ...f.database,
    open(value) {
      decrypts++;
      return f.database.open(value);
    },
  });
  assert.equal(activity.hasEnabledEvents(), true);
  assert.equal(activity.hasEnabledEvents(user.organizationId, 'moved'), true);
  assert.deepEqual(activity.reminderOrganizationPage().organizations, [user.organizationId]);
  assert.equal(decrypts, 0, 'a ready index does not decrypt the device collection');
  store.update(user.token, { deviceId: first.id, preferences: preferences([]) });
  assert.equal(activity.hasEnabledEvents(), true, 'a second enabled device remains active');
  store.update(user.token, { deviceId: second.id, preferences: preferences(['created']) });
  assert.equal(activity.hasEnabledEvents('', 'reminder'), false);
  assert.equal(activity.hasEnabledEvents('', 'change'), true);
  for (let i = 0; i < 4; i++) {
    f.database.db
      .prepare('INSERT OR REPLACE INTO telegram_runtime VALUES(?,?)')
      .run('synthetic-unrelated', f.database.seal({ counter: i }));
    assert.equal(activity.hasEnabledEvents(user.organizationId, 'created'), true);
    assert.equal(activity.hasEnabledEvents('', 'reminder'), false);
  }
  assert.equal(decrypts, 0, 'other queue writes do not invalidate the derived index');
  f.database.transaction(() => resetPushNotificationInterest(f.database.db, user.organizationId));
  assert.equal(
    activity.hasEnabledEvents(),
    false,
    'scoped restore must not recreate discarded interests',
  );
  store.update(user.token, { deviceId: second.id, preferences: preferences(['moved']) });
  assert.equal(activity.hasEnabledEvents('', 'moved'), true);
  assert.throws(
    () =>
      f.database.transaction(() => {
        activity.updateDeviceInterest(user.organizationId, second.id, null);
        throw Error('synthetic rollback');
      }),
    /synthetic rollback/,
  );
  assert.equal(
    activity.hasEnabledEvents('', 'moved'),
    true,
    'interest changes roll back atomically',
  );
  assert.equal(decrypts, 0);
  f.database.transaction(() => resetPushNotificationInterest(f.database.db));
  store.setRuntimeAvailable(false);
  store.update(user.token, { deviceId: first.id, preferences: preferences([]) });
  assert.equal(
    f.database.db
      .prepare('SELECT 1 FROM telegram_runtime WHERE key=?')
      .get('push-interest-v1:ready'),
    undefined,
    'a preference mutation while globally unavailable must not bootstrap every device',
  );
  assert.equal(activity.hasEnabledEvents('', 'moved'), true);
  assert.equal(decrypts, 2, 'the first active read bootstraps current devices once');
  activity.hasEnabledEvents();
  assert.equal(decrypts, 2);
});
test('off Push creates no jobs and skips appointment traversal while leaving device settings editable', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0];
  const device = connectFresh(store, user.token, subscription('off-producers')).device;
  store.setRuntimeAvailable(false);
  const unread = new Proxy({}, { get: forbidden });
  f.platform.withWriteLock(() => {
    store.enqueue(user.organizationId, user.accountId, 'change', unread, 'synthetic-off');
    store.booking(user.organizationId, unread, 'new-request');
    store.confirmation(user.organizationId, 'synthetic-patient', unread);
    pushAppointmentChanges(
      { staffPush: store, organizationTimeZone: forbidden },
      user.organizationId,
      unread,
      unread,
    );
  });
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM staff_push_jobs').get().n, 0);
  assert.equal(store.claim(), null);
  assert.throws(() => store.test(user.token, device.id), { status: 503 });
  store.update(user.token, { deviceId: device.id, preferences: preferences([]) });
  assert.deepEqual(store.device(device.id).decoded.preferences.events, []);
});
test('Push off/on rejects both captured and legacy historical epochs without changing an in-flight result', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0];
  connectFresh(store, user.token, subscription('epochs'));
  let epoch = '',
    available = true;
  const queue = createPushQueue(
    { ...f.database, fail: (status, message) => Object.assign(Error(message), { status }) },
    { ...store, runtimeAvailable: () => available, channelVersion: () => epoch },
  );
  const enqueue = (key) =>
    f.database.transaction(() =>
      queue.enqueue(
        user.organizationId,
        user.accountId,
        'change',
        { kind: 'appointment', id: 'synthetic', notice: 'created' },
        key,
      ),
    );
  enqueue('synthetic-before-off');
  const old = queue.claim();
  assert.ok(queue.valid(old));
  assert.equal(old.decoded.channelVersion, '');
  available = false;
  enqueue('synthetic-disabled');
  assert.equal(queue.claim(), null);
  assert.equal(queue.valid(old), null);
  assert.equal(queue.finish(old, 'sent'), 1, 'an actual in-flight acknowledgement is retained');
  available = true;
  epoch = 'synthetic-next-epoch';
  enqueue('synthetic-current');
  const fresh = queue.claim();
  assert.ok(queue.valid(fresh));
  assert.equal(fresh.decoded.channelVersion, epoch);
  assert.equal(queue.finish(fresh, 'sent'), 1);
  enqueue('synthetic-legacy');
  const row = f.database.db.prepare("SELECT * FROM staff_push_jobs WHERE status='pending'").get();
  const decoded = f.database.open(row.value);
  delete decoded.channelVersion;
  f.database.db
    .prepare('UPDATE staff_push_jobs SET value=? WHERE id=?')
    .run(f.database.seal(decoded), row.id);
  const legacy = queue.claim();
  assert.equal(
    Object.hasOwn(legacy.decoded, 'channelVersion'),
    false,
    'claim must not adopt the fresh epoch',
  );
  assert.equal(queue.valid(legacy), null);
  assert.equal(queue.finish(legacy, 'cancelled'), 1);
});
test('disabled workday reminders do not enumerate organizations or read a cabinet', () => {
  const planner = createWorkdayPush(
    {
      organizationTimeZone: forbidden,
      withWriteLock: forbidden,
      workSchedules: { publicDays: forbidden, futureDays: forbidden },
    },
    {
      hasEnabledEvents: () => false,
      organizations: forbidden,
      organizationPage: forbidden,
      device: forbidden,
    },
  );
  planner.schedule();
  assert.deepEqual(planner.scheduleBatch(), { cursor: '' });
  assert.equal(planner.current({ organization_id: 'synthetic-org' }), false);
});

test('empty Push claim is read-only, probe-only claim skips stale normal work and expired leases recover', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0];
  const device = connectFresh(store, user.token, subscription('claim-guard')).device;
  let writes = 0,
    hasEvents = true;
  const queue = createPushQueue(
    {
      ...f.database,
      transaction(callback) {
        writes++;
        return f.database.transaction(callback);
      },
      fail: (status, message) => Object.assign(Error(message), { status }),
    },
    { ...store, hasEnabledEvents: () => hasEvents, hasPendingTests: () => true },
  );
  assert.equal(queue.claim(), null);
  assert.equal(writes, 0, 'an empty due index does not acquire a write transaction');
  const now = Date.now();
  queue.test(user.token, device.id, now);
  f.database.transaction(() =>
    queue.enqueue(
      user.organizationId,
      user.accountId,
      'change',
      { kind: 'appointment', id: 'synthetic', notice: 'created' },
      'synthetic-stale-normal',
    ),
  );
  f.database.db
    .prepare("UPDATE staff_push_jobs SET next_at=? WHERE event_key LIKE 'staff-push-event:%'")
    .run(now - 100);
  hasEvents = false;
  const probe = queue.claim(now + 1);
  assert.equal(probe.decoded.event, 'test');
  assert.equal(
    f.database.db
      .prepare("SELECT status FROM staff_push_jobs WHERE event_key LIKE 'staff-push-event:%'")
      .get().status,
    'pending',
  );
  queue.finish(probe, 'sent');
  const normal = f.database.db
    .prepare("SELECT id FROM staff_push_jobs WHERE event_key LIKE 'staff-push-event:%'")
    .get();
  f.database.db
    .prepare(
      "UPDATE staff_push_jobs SET status='sending',lease_id='synthetic-expired',lease_until=? WHERE id=?",
    )
    .run(now - 1, normal.id);
  hasEvents = true;
  const recovered = queue.claim(now + 1);
  assert.equal(recovered.id, normal.id);
  assert.notEqual(recovered.lease_id, 'synthetic-expired');
  assert.ok(queue.valid(recovered, now + 1));
});
