const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const rules = require('../src/server/modules/notifications/push-validation.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { connectFresh } = require('./helpers/staff-push-connect.cjs');
const changes = [
  'created',
  'moved',
  'cancelled',
  'completed',
  'no_show',
  'restored',
  'removed',
  'updated',
];
const events = ['new-request', 'confirmation', ...changes, 'reminder'];
function subscription(index) {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-preferences-' + index,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}
const preferences = (selected, leadMinutes = 120) => ({ events: selected, leadMinutes });
function queued(f) {
  return f.database.db
    .prepare('SELECT * FROM staff_push_jobs')
    .all()
    .map((job) => ({
      ...job,
      decoded: f.database.open(job.value),
    }));
}

test('Push preferences expand legacy change without adding periods or changing empty selections', () => {
  assert.deepEqual(rules.defaults().events, events);
  assert.deepEqual(rules.preferences(preferences(['new-request', 'change', 'reminder'])).events, [
    'new-request',
    ...changes,
    'reminder',
  ]);
  assert.deepEqual(rules.preferences(preferences(['change', 'moved'])).events, changes);
  assert.deepEqual(rules.preferences(preferences([])).events, []);
  assert.deepEqual(rules.storedPreferences({ events: ['change'], leadMinutes: 30 }), {
    events: changes,
    leadMinutes: 120,
    reminderMode: 'workday',
  });
  for (const selected of [['private'], ['moved', 'moved'], ['change', 'change']])
    assert.throws(() => rules.preferences(preferences(selected)), { status: 400 });
  assert.throws(() => rules.preferences(preferences(events, 90)), { status: 400 });
  assert.equal(rules.eventCategory('change', { removed: true }), 'removed');
  assert.equal(rules.eventCategory('change', {}), 'updated');
});

test('each Push category filters enqueue by actual notice while preserving the existing event payload', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0];
  const sub = subscription('categories');
  const device = connectFresh(store, user.token, sub).device;
  assert.deepEqual(device.preferences.events, events);
  let count = 0;
  for (const selected of events) {
    store.update(user.token, { deviceId: device.id, preferences: preferences([selected]) });
    f.platform.withWriteLock(() => {
      for (const category of events) {
        const event = changes.includes(category) ? 'change' : category;
        store.enqueue(
          user.organizationId,
          user.accountId,
          event,
          { kind: 'appointment', id: 'synthetic', notice: category },
          selected + ':' + category,
        );
      }
    });
    const rows = queued(f);
    assert.equal(rows.length, ++count, selected);
    const job = store.claim();
    assert.ok(job, selected);
    assert.equal(job.decoded.reference.notice, selected);
    assert.equal(job.decoded.event, changes.includes(selected) ? 'change' : selected);
    assert.ok(store.valid(job), selected);
    assert.equal(store.finish(job, 'sent'), 1);
  }
  assert.deepEqual(store.status(user.token, sub.endpoint).preferences.events, events);
});

test('disabling one Push category cancels only its pending and leased work on that device', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0],
    employee = f.users[2];
  const first = connectFresh(store, user.token, subscription('first')).device;
  const second = connectFresh(store, user.token, subscription('second')).device;
  const third = connectFresh(store, employee.token, subscription('third')).device;
  const binding = store.device(first.id).decoded.bindingId;
  const enqueue = (notice, key, onlyDevice = '') =>
    f.platform.withWriteLock(() => {
      store.enqueue(
        user.organizationId,
        employee.accountId,
        'change',
        { kind: 'appointment', id: 'synthetic', notice },
        key,
        Date.now() + 86400000,
        onlyDevice,
      );
    });
  enqueue('created', 'leased-created', first.id);
  const kept = store.claim();
  enqueue('moved', 'leased-moved', first.id);
  const removed = store.claim();
  enqueue('moved', 'pending-moved');
  f.platform.withWriteLock(() => {
    store.enqueue(
      user.organizationId,
      employee.accountId,
      'confirmation',
      { kind: 'appointment', id: 'synthetic' },
      'pending-confirmation',
    );
    store.enqueue(
      user.organizationId,
      user.accountId,
      'reminder',
      { kind: 'workday' },
      'pending-reminder',
    );
  });
  const untouched = queued(f)
    .filter((job) => job.device_id !== first.id)
    .map((job) => [job.id, job.status]);
  const selected = events.filter((event) => event !== 'moved');
  store.update(user.token, { deviceId: first.id, preferences: preferences(selected) });
  assert.equal(store.device(first.id).decoded.bindingId, binding);
  assert.ok(store.valid(kept));
  assert.equal(store.valid(removed), null);
  assert.equal(store.finish(removed, 'sent'), 0);
  let rows = queued(f);
  assert.deepEqual(
    rows.filter((job) => job.device_id !== first.id).map((job) => [job.id, job.status]),
    untouched,
  );
  assert.ok(rows.some((job) => job.device_id === second.id && job.status === 'pending'));
  assert.ok(rows.some((job) => job.device_id === third.id && job.status === 'pending'));
  for (const job of rows.filter((job) => job.device_id === first.id))
    assert.equal(
      job.status,
      job.decoded.reference.notice === 'moved'
        ? 'cancelled'
        : job.id === kept.id
          ? 'sending'
          : 'pending',
    );
  store.update(user.token, { deviceId: first.id, preferences: preferences(selected, 60) });
  rows = queued(f);
  assert.equal(
    rows.find((job) => job.device_id === first.id && job.decoded.event === 'reminder').status,
    'cancelled',
  );
  assert.equal(
    rows.find((job) => job.device_id === second.id && job.decoded.event === 'reminder').status,
    'pending',
  );
  assert.ok(store.valid(kept), 'a reminder period change must preserve another leased category');
});

test('delivery rechecks granular preferences and reads legacy stored change without rewriting storage', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0],
    sub = subscription('legacy');
  const device = connectFresh(store, user.token, sub).device;
  f.platform.withWriteLock(() =>
    store.enqueue(
      user.organizationId,
      user.accountId,
      'change',
      { kind: 'appointment', id: 'synthetic', notice: 'moved' },
      'leased-legacy',
    ),
  );
  const job = store.claim();
  const setStored = (selected) => {
    const value = store.device(device.id).decoded;
    value.preferences = preferences(selected);
    f.database.db
      .prepare('UPDATE staff_push_devices SET value=? WHERE id=?')
      .run(f.database.seal(value), device.id);
  };
  setStored(['created']);
  assert.equal(
    store.valid(job),
    null,
    'a leased moved notice must not bypass its disabled category',
  );
  setStored(['moved']);
  assert.ok(store.valid(job));
  setStored(['change']);
  assert.ok(store.valid(job));
  assert.deepEqual(store.status(user.token, sub.endpoint).device.preferences.events, changes);
  const raw = f.database.open(
    f.database.db.prepare('SELECT value FROM staff_push_devices WHERE id=?').get(device.id).value,
  );
  assert.deepEqual(raw.preferences.events, ['change']);
  store.update(user.token, { deviceId: device.id, preferences: preferences(['change']) });
  assert.ok(store.valid(job), 'saving the legacy API umbrella keeps enabled categories alive');
  assert.deepEqual(store.device(device.id).decoded.preferences.events, changes);
});

test('Push event switches leave Telegram and MAX bindings and queued deliveries untouched', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const store = f.platform.staffPush,
    user = f.users[0];
  const device = connectFresh(store, user.token, subscription('channels')).device;
  f.connectTelegram(user, 0);
  f.connect(user, 0);
  f.create('synthetic-independent-push-preferences');
  const max = f.jobs('max'),
    telegram = f.jobs('telegram');
  assert.equal(max.length, 1);
  assert.equal(telegram.length, 1);
  store.update(user.token, { deviceId: device.id, preferences: preferences([]) });
  assert.deepEqual(f.jobs('max'), max);
  assert.deepEqual(f.jobs('telegram'), telegram);
  assert.ok(queued(f).every((job) => job.status === 'cancelled'));
  f.create('synthetic-after-push-disabled');
  assert.equal(f.jobs('max').length, 2);
  assert.equal(f.jobs('telegram').length, 2);
  assert.equal(queued(f).length, 1);
});
