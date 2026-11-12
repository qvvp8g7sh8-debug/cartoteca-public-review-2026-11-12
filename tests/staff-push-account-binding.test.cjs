const { connectFresh } = require('./helpers/staff-push-connect.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
const defaults = require('../src/server/modules/notifications/push-validation.cjs').defaults;

function subscription(index) {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-account-binding-' + index,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}
const jobs = (f, device) =>
  f.database.db.prepare('SELECT * FROM staff_push_jobs WHERE device_id=? ORDER BY id').all(device);
const deviceRow = (f, device) =>
  f.database.db.prepare('SELECT * FROM staff_push_devices WHERE id=?').get(device);
const markers = (f, device) =>
  f.database.db
    .prepare(
      "SELECT key,value FROM telegram_runtime WHERE key LIKE 'push-interest-v1:%' AND key LIKE ? ORDER BY key",
    )
    .all('%:' + device);
const emptyTenant = () => ({ indexes: { appointments: () => [] }, transaction: (fn) => fn() });

test('explicit same-browser connect transfers only that subscription with fresh identity and cancels old leased work', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    [a, b, other] = f.users,
    sub = subscription('shared');
  const old = connectFresh(store, a.token, sub).device;
  const untouched = connectFresh(store, other.token, subscription('other')).device;
  store.update(a.token, {
    deviceId: old.id,
    preferences: { events: ['created'], leadMinutes: 45, reminderMode: 'workday' },
  });
  store.test(a.token, old.id);
  const leased = store.claim();
  assert.ok(store.valid(leased));
  store.test(a.token, old.id, Date.now() + 30001);
  const otherRow = deviceRow(f, untouched.id),
    otherMarkers = markers(f, untouched.id);
  const result = connectFresh(store, b.token, sub);
  assert.notEqual(result.device.id, old.id);
  assert.equal(store.device(old.id), null);
  assert.equal(store.status(a.token, sub.endpoint).device, null);
  assert.deepEqual(result.device.preferences, defaults());
  assert.notEqual(store.device(result.device.id).decoded.bindingId, leased.decoded.bindingId);
  assert.equal(store.device(result.device.id).account_id, b.accountId);
  assert.equal(store.valid(leased), null);
  assert.equal(store.finish(leased, 'sent'), 0);
  assert.ok(
    jobs(f, old.id).every(
      (job) => job.status === 'cancelled' && !job.lease_id && job.lease_until === 0,
    ),
  );
  assert.deepEqual(markers(f, old.id), []);
  assert.ok(markers(f, result.device.id).length > 0);
  assert.deepEqual(deviceRow(f, untouched.id), otherRow);
  assert.deepEqual(markers(f, untouched.id), otherMarkers);
  for (const operation of [
    () => store.update(a.token, { deviceId: old.id }, true),
    () => store.update(a.token, { deviceId: old.id, preferences: defaults() }),
    () => store.test(a.token, old.id),
  ])
    assert.throws(operation, { status: 404 });
  const ownBinding = store.device(result.device.id).decoded.bindingId;
  assert.equal(connectFresh(store, b.token, sub).device.id, result.device.id);
  assert.notEqual(store.device(result.device.id).decoded.bindingId, ownBinding);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
});

test('knowing another endpoint without both exact subscription keys cannot transfer its binding', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    [a, b] = f.users,
    sub = subscription('capability');
  const old = connectFresh(store, a.token, sub).device;
  store.test(a.token, old.id);
  const before = deviceRow(f, old.id),
    beforeJobs = jobs(f, old.id);
  const keyExpectation = store.status(b.token, sub.endpoint).bindingExpectation;
  for (const key of ['p256dh', 'auth']) {
    const other = subscription('other-key');
    assert.throws(
      () =>
        store.connect(
          b.token,
          { ...sub, keys: { ...sub.keys, [key]: other.keys[key] } },
          keyExpectation,
        ),
      { status: 409 },
    );
    assert.deepEqual(deviceRow(f, old.id), before);
    assert.deepEqual(jobs(f, old.id), beforeJobs);
    assert.equal(store.status(b.token, sub.endpoint).device, null);
  }
});

test('target ten-device cap rejects a transfer without touching the previous binding, jobs or interest', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    [a, b] = f.users,
    sub = subscription('capped');
  const old = connectFresh(store, a.token, sub).device;
  store.test(a.token, old.id);
  const leased = store.claim();
  for (let i = 0; i < 10; i++) connectFresh(store, b.token, subscription('cap-' + i));
  const before = deviceRow(f, old.id),
    beforeJobs = jobs(f, old.id),
    beforeMarkers = markers(f, old.id);
  assert.throws(() => connectFresh(store, b.token, sub), { status: 409 });
  assert.deepEqual(deviceRow(f, old.id), before);
  assert.deepEqual(jobs(f, old.id), beforeJobs);
  assert.deepEqual(markers(f, old.id), beforeMarkers);
  assert.ok(store.valid(leased));
  assert.equal(
    f.database.db
      .prepare('SELECT count(*) n FROM staff_push_devices WHERE account_id=? AND organization_id=?')
      .get(b.accountId, b.organizationId).n,
    10,
  );
});

test('cross-organization transfer removes old organization interest and never inherits its preferences', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    a = f.users[0],
    sub = subscription('cross-org');
  const old = connectFresh(store, a.token, sub).device;
  store.update(a.token, {
    deviceId: old.id,
    preferences: { events: [], leadMinutes: 15, reminderMode: 'workday' },
  });
  const owner = await f.platform.registerOwner({
    email: 'other-owner@push-account.test',
    password: 'Synthetic-cross-org-password',
    displayName: 'Synthetic other owner',
    organizationName: 'Synthetic other organization',
  });
  f.platform.verifyEmail(owner.verificationToken);
  const login = await f.platform.login(
    'other-owner@push-account.test',
    'Synthetic-cross-org-password',
  );
  assert.notEqual(owner.organizationId, a.organizationId);
  const result = connectFresh(store, login.token, sub);
  assert.equal(store.device(old.id), null);
  assert.equal(store.device(result.device.id).organization_id, owner.organizationId);
  assert.equal(store.device(result.device.id).account_id, owner.accountId);
  assert.deepEqual(result.device.preferences, defaults());
  assert.equal(store.hasEnabledEvents(a.organizationId), false);
  assert.equal(store.hasEnabledEvents(owner.organizationId), true);
  assert.deepEqual(markers(f, old.id), []);
});

test('failed target insert rolls back cancellation, old device deletion and interest updates atomically', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    [a, b] = f.users,
    sub = subscription('rollback');
  const old = connectFresh(store, a.token, sub).device;
  store.test(a.token, old.id);
  const leased = store.claim();
  const before = deviceRow(f, old.id),
    beforeJobs = jobs(f, old.id),
    beforeMarkers = markers(f, old.id);
  assert.match(b.accountId, /^[a-f0-9-]+$/);
  f.database.db.exec(
    "CREATE TRIGGER reject_synthetic_transfer BEFORE INSERT ON staff_push_devices WHEN NEW.account_id='" +
      b.accountId +
      "' BEGIN SELECT RAISE(ABORT,'Synthetic transfer rejected'); END;",
  );
  assert.throws(() => connectFresh(store, b.token, sub), /Synthetic transfer rejected/);
  assert.deepEqual(deviceRow(f, old.id), before);
  assert.deepEqual(jobs(f, old.id), beforeJobs);
  assert.deepEqual(markers(f, old.id), beforeMarkers);
  assert.ok(store.valid(leased));
  assert.equal(store.status(b.token, sub.endpoint).device, null);
});

test('late old-provider completions cannot expire, finish or retry a freshly transferred binding', async (t) => {
  for (const outcome of ['success', 410, 503])
    await t.test(String(outcome), async (t) => {
      const f = await staffMaxFixture(t, { schema: 17 });
      const store = f.platform.staffPush,
        [a, b] = f.users,
        sub = subscription('inflight-' + outcome);
      const old = connectFresh(store, a.token, sub).device;
      store.test(a.token, old.id);
      const transferExpectation = store.status(b.token, sub.endpoint).bindingExpectation;
      let complete, began;
      const started = new Promise((resolve) => (began = resolve)),
        sent = [];
      const runtime = createPushRuntime({
        platform: f.platform,
        tenantStore: emptyTenant,
        origin: 'https://synthetic.test',
        enabled: true,
        send: (subscription, payload) => {
          sent.push(JSON.parse(payload));
          if (sent.length > 1) return Promise.resolve();
          began();
          return new Promise((resolve, reject) => {
            complete = () => (outcome === 'success' ? resolve() : reject({ statusCode: outcome }));
          });
        },
      });
      t.after(() => runtime.stop());
      runtime.start();
      const pending = runtime.tick();
      await started;
      let next;
      try {
        next = store.connect(b.token, sub, transferExpectation).device;
        store.test(b.token, next.id);
      } finally {
        complete();
        await pending;
      }
      assert.equal(store.device(next.id).account_id, b.accountId);
      assert.equal(store.device(old.id), null);
      assert.ok(jobs(f, old.id).every((job) => job.status === 'cancelled'));
      await runtime.tick();
      assert.equal(sent.length, 2, 'only the already-started A send and the new B send occur');
      assert.deepEqual(
        sent.map((payload) => payload.data.accountId),
        [a.accountId, b.accountId],
      );
      for (const [i, user] of [a, b].entries()) {
        const target = JSON.parse(
          decodeURIComponent(sent[i].data.url.slice('/#staff-push='.length)),
        );
        assert.equal(target.accountId, user.accountId);
        assert.equal(target.organizationId, user.organizationId);
        assert.ok(!/PRIVATE|phone|patientName|firstName/.test(JSON.stringify(sent[i])));
      }
      assert.equal(jobs(f, next.id)[0].status, 'sent');
    });
});

test('fresh binding check after event validation prevents a revoked A job from starting external delivery', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    [a, b] = f.users,
    sub = subscription('preflight');
  const old = connectFresh(store, a.token, sub).device;
  const appointment = {
    id: 'synthetic-a',
    staffId: a.accountId,
    date: '2035-01-01',
    time: '10:00',
    duration: 30,
  };
  const reference = {
    kind: 'appointment',
    patientId: 'synthetic-p',
    id: appointment.id,
    stamp: fingerprint(appointment, f.platform.organizationTimeZone(a.organizationId)),
  };
  f.platform.withWriteLock(() =>
    store.enqueue(a.organizationId, a.accountId, 'change', reference, 'synthetic-preflight'),
  );
  let transferred = null,
    sends = 0;
  const transferExpectation = store.status(b.token, sub.endpoint).bindingExpectation;
  const runtime = createPushRuntime({
    platform: f.platform,
    origin: 'https://synthetic.test',
    enabled: true,
    tenantStore: () => {
      transferred ||= store.connect(b.token, sub, transferExpectation).device;
      return {
        readSelected: () => ({
          patients: [{ id: reference.patientId, appointments: [appointment] }],
        }),
      };
    },
    send: async () => {
      sends++;
    },
  });
  t.after(() => runtime.stop());
  runtime.start();
  await runtime.tick();
  assert.ok(transferred);
  assert.equal(sends, 0);
  assert.equal(store.device(old.id), null);
  assert.equal(jobs(f, old.id)[0].status, 'cancelled');
  store.test(b.token, transferred.id);
  await runtime.tick();
  assert.equal(sends, 1);
});

test('schema18 transfer immediately removes only the old durable workday subject and its interest', (t) => {
  const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');
  const { createStaffPush } = require('../src/server/modules/notifications/push-store.cjs');
  const f = scheduleFixture(t),
    schedule = f.platform.notificationSchedule;
  const actors = {
    a: { accountId: 'owner', organizationId: 'org', role: 'owner' },
    b: { accountId: 'outsider', organizationId: 'other-org', role: 'owner' },
  };
  const store = createStaffPush({
    ...f.context,
    notificationSchedule: schedule,
    onlineBooking: { actor: (token) => actors[token] },
  });
  const sub = subscription('durable-shared');
  const old = connectFresh(store, 'a', sub).device;
  const other = connectFresh(store, 'a', subscription('durable-other')).device;
  const task = (entity) => ({
    entity,
    dueAt: f.clock() + 60000,
    expiresAt: f.clock() + 120000,
    value: { synthetic: true },
  });
  f.database.transaction(() => {
    schedule.replaceTasks('workday', 'org', old.id, [task('old-day')]);
    schedule.replaceTasks('workday', 'org', other.id, [task('other-day')]);
  });
  const tasks = (device) =>
    f.database.db
      .prepare(
        "SELECT * FROM notification_schedule WHERE kind='workday' AND subject=? ORDER BY entity",
      )
      .all(device);
  const otherTasks = tasks(other.id),
    otherMarkers = markers(f, other.id);
  assert.equal(tasks(old.id).length, 1);
  const next = connectFresh(store, 'b', sub).device;
  assert.deepEqual(
    tasks(old.id),
    [],
    'old subject is cancelled in the connect transaction, before a scheduler pass',
  );
  assert.deepEqual(markers(f, old.id), []);
  assert.deepEqual(tasks(other.id), otherTasks);
  assert.deepEqual(markers(f, other.id), otherMarkers);
  assert.equal(store.device(old.id), null);
  assert.equal(store.device(next.id).organization_id, 'other-org');
  assert.equal(store.hasEnabledEvents('other-org'), true);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 18);
  assert.equal(f.metrics.profileReads + f.metrics.appointmentReads, 0);
});
