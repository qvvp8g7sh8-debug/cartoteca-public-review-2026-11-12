const test = require('node:test');
const assert = require('node:assert/strict');
const {
  migrateNotificationChannels,
  rollbackEmptyNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');
const { maxFixture } = require('./max-fixture.cjs');
const {
  migrateNotificationQueue,
  rollbackEmptyNotificationQueue,
} = require('../src/server/migrations/013-notification-queue.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const { createMaxConnections } = require('../src/server/modules/notifications/max-connections.cjs');
const { createMaxEvents } = require('../src/server/modules/notifications/max-events.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');

// Only temporary encrypted synthetic stores and in-memory providers. No real tokens or HTTP.
function fixture(t) {
  const f = maxFixture(t);
  const migration = migrateNotificationQueue(f.database, f.directory);
  const channelMigration = migrateNotificationChannels(f.database, f.directory);
  const store = createNotificationStore(f.database),
    sent = [];
  let now = f.now;
  const a = {
    id: 'a',
    date: '2099-04-08',
    time: '14:00',
    duration: 60,
    service: 'Synthetic private procedure',
    staffId: 'owner',
  };
  f.patients[0].appointments.push(a);
  const values = new Map();
  const tenantStore = (org) => ({
    ...f.tenantStore(org),
    get: (key) => values.get(org + '\0' + key),
    set: (key, value) => values.set(org + '\0' + key, value),
    transaction: (work) => work(),
    indexes: { appointments: () => (org === 'org' ? [{ ...a, patientId: 'p' }] : []) },
  });
  f.platform.telegram.saveSettings('org', 'owner', {
    enabled: true,
    leadMinutes: 1440,
    timeZone: f.platform.organizationTimeZone('org'),
    showServices: true,
  });
  f.database.db
    .prepare('INSERT INTO telegram_links VALUES(?,?,?,?)')
    .run(
      'org',
      'p',
      f.database.limitKey('telegram-chat', '456'),
      f.database.seal({ chatId: '456', linkedAt: now, servicesConsent: true }),
    );
  const issued = f.links.issue('org', 'p', 'owner', '123', () => {}, now);
  f.links.consume(issued.token, '123', '789', () => {}, now);
  const providers = Object.fromEntries(
    ['telegram', 'max'].map((channel) => [
      channel,
      {
        status: () => ({
          configured: true,
          connected: true,
          botId: channel === 'max' ? '123' : '321',
        }),
        acquire: async () => true,
        send: async (value) => {
          sent.push({ channel, ...value });
          return {};
        },
      },
    ]),
  );
  const coordinator = createNotificationCoordinator({
    platform: f.platform,
    tenantStore,
    store,
    preferences: f.preferences,
    links: f.links,
    providers,
    clock: () => now,
  });
  const choose = (preference, appointment = '') =>
    f.preferences.save(
      {
        org: 'org',
        patient: 'p',
        appointment,
        preference,
        expectedRevision: f.preferences.read('org', 'p', appointment).revision,
        stamp: appointment
          ? f.platform.appointmentConfirmations.stamp(a, f.platform.organizationTimeZone('org'))
          : '',
        actor: 'owner',
      },
      () => {},
      now,
      () => {},
    );
  return {
    ...f,
    a,
    store,
    sent,
    coordinator,
    providers,
    tenantStore,
    migration,
    channelMigration,
    choose,
    advance: (ms) => {
      now += ms;
    },
  };
}

const recipient = (channel) =>
  channel === 'max' ? { userId: '789', botId: '123' } : { chatId: '456' };
const jobs = (f) =>
  f.store.list(
    'org',
    'p',
    'a',
    f.platform.appointmentConfirmations.stamp(f.a, f.platform.organizationTimeZone('org')),
  );

test('common scheduler yields within a large organization and honors cancellation without overlapping passes', async (t) => {
  const f = fixture(t),
    zone = f.platform.organizationTimeZone('org');
  const instant = new Date(f.now + 3 * 3600000);
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(instant);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  f.patients[0].appointments = Array.from({ length: 250 }, (_, i) => ({
    ...f.a,
    id: 'batch-' + i,
    date,
    time,
  }));
  const tenantStore = (org) => ({
    ...f.tenantStore(org),
    indexes: {
      appointments: () =>
        org === 'org' ? f.patients[0].appointments.map((a) => ({ ...a, patientId: 'p' })) : [],
    },
  });
  const coordinator = createNotificationCoordinator({
    platform: f.platform,
    store: f.store,
    links: f.links,
    providers: f.providers,
    tenantStore,
    clock: () => f.now,
  });
  let notifyEnqueued;
  const firstEnqueued = new Promise((resolve) => {
    notifyEnqueued = resolve;
  });
  const enqueue = f.store.enqueue;
  f.store.enqueue = (...args) => {
    const job = enqueue(...args);
    if (job) notifyEnqueued();
    return job;
  };
  let heartbeat = false;
  const heartbeatHandle = setImmediate(() => {
    heartbeat = true;
  });
  t.after(() => clearImmediate(heartbeatHandle));
  let active = true;
  const pending = coordinator.scheduleBatched({ canRun: () => active });
  assert.equal(coordinator.schedule(), false);
  // A time-limited slice may yield before its first enqueue on a slower host.
  await Promise.race([firstEnqueued, pending]);
  assert.equal(coordinator.schedule(), false);
  active = false;
  assert.equal(await pending, false);
  assert.equal(heartbeat, true, 'the partial pass actually yielded to the event loop');
  const count = () =>
    f.database.db.prepare('SELECT count(*) n FROM notification_channel_jobs').get().n;
  assert.ok(count() > 0 && count() <= 200);
  assert.equal(f.sent.length, 0, 'scheduling performs no provider delivery');
  active = true;
  assert.equal(await coordinator.scheduleBatched({ canRun: () => active }), true);
  assert.equal(count(), 500, 'each channel has exactly one job after the resumed full pass');
});

test('losing background ownership while awaiting provider capacity defers reserved work without sending', async (t) => {
  const f = fixture(t);
  let active = true;
  f.providers.telegram.status = () => ({ configured: true, connected: false, botId: '321' });
  f.providers.max.acquire = async () => {
    active = false;
    return true;
  };
  f.coordinator.remind('org', 'p', 'a', () => {});
  await f.coordinator.tick(undefined, () => active);
  assert.equal(f.sent.length, 0);
  assert.equal(jobs(f)[0].status, 'pending');
  active = true;
  f.advance(1001);
  f.providers.max.acquire = async () => true;
  await f.coordinator.tick(undefined, () => active);
  assert.equal(f.sent.length, 1);
  assert.equal(jobs(f)[0].status, 'sent');
});

test('web-only background guard leaves bot identity and explicit reminder/manual confirmation available', async (t) => {
  const f = fixture(t);
  const runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: f.tenantStore,
    coordinator: f.coordinator,
    canRun: () => false,
    clock: () => f.now,
    bot: {
      initialize: async () => ({ username: 'Synthetic_bot', botId: '321' }),
      send: async () => assert.fail('web-only process cannot send'),
    },
  });
  assert.equal((await runtime.initialize()).connected, true);
  assert.equal(runtime.schedule(), false);
  assert.equal(await runtime.scheduleBatched(), false);
  await runtime.tick();
  assert.equal(jobs(f).length, 0);
  const requested = f.coordinator.remind('org', 'p', 'a', () => {});
  assert.ok(requested.stamp);
  assert.equal(
    jobs(f).length,
    2,
    'explicit HTTP-side operation can enqueue for the background role',
  );
  const zone = f.platform.organizationTimeZone('org');
  const receipt = f.platform.appointmentConfirmations.set('org', 'p', f.a, zone, 'owner', true);
  assert.ok(receipt.manualConfirmedAt);
  f.coordinator.cancelPending('org', 'p', 'a');
  assert.ok(jobs(f).every((job) => job.status === 'cancelled'));
  assert.equal(f.sent.length, 0);
});

test('both connected channels receive once; either confirmation wins and all later replies preserve it', async (t) => {
  for (const firstChannel of ['telegram', 'max']) {
    const f = fixture(t);
    f.choose('manual'); // Retired stored preferences must not disable either connected channel.
    f.coordinator.remind('org', 'p', 'a');
    f.coordinator.remind('org', 'p', 'a');
    assert.equal(jobs(f).length, 2);
    for (const row of f.database.db.prepare('SELECT value FROM notification_channel_jobs').all())
      assert.equal(Buffer.from(row.value).includes(Buffer.from('456')), false);
    await f.coordinator.tick();
    assert.deepEqual(f.sent.map((row) => row.channel).sort(), ['max', 'telegram']);
    const sent = jobs(f),
      first = sent.find((row) => row.decoded.channel === firstChannel);
    const second = sent.find((row) => row.decoded.channel !== firstChannel);
    const receipt = f.coordinator.confirm(
      firstChannel,
      first.decoded.callback,
      recipient(firstChannel),
    );
    assert.equal(receipt.first, true);
    assert.equal(receipt.notificationConfirmedChannel, firstChannel);
    f.advance(1000);
    for (const row of [second, first, second]) {
      const repeated = f.coordinator.confirm(
        row.decoded.channel,
        row.decoded.callback,
        recipient(row.decoded.channel),
      );
      assert.equal(repeated.first, false);
      assert.equal(repeated.notificationConfirmedAt, receipt.notificationConfirmedAt);
      assert.equal(repeated.notificationConfirmedChannel, firstChannel);
    }
    assert.equal(
      f.database.db.prepare('SELECT COUNT(*) n FROM notification_confirmations').get().n,
      1,
    );
    assert.throws(() => f.coordinator.remind('org', 'p', 'a'), { status: 409 });
    await f.coordinator.tick();
    assert.equal(f.sent.length, 2);
    assert.equal(
      f.sent.find((row) => row.channel === 'max').text.includes('Synthetic private procedure'),
      true,
    );
  }
});

test('common visibility only changes service names and rejects an obsolete setting', async (t) => {
  const f = fixture(t),
    before = f.platform.telegram.settings('org');
  f.platform.telegram.saveServiceVisibility('org', 'owner', {
    showServices: false,
    expectedShowServices: true,
  });
  assert.deepEqual(f.platform.telegram.settings('org'), { ...before, showServices: false });
  assert.throws(
    () =>
      f.platform.telegram.saveServiceVisibility('org', 'owner', {
        showServices: true,
        expectedShowServices: true,
      }),
    { status: 409 },
  );
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 2);
  for (const message of f.sent)
    assert.doesNotMatch(message.text, /Synthetic private procedure|Услуги:/);
});

test('a linked client opting out of service names is respected in both channels', async (t) => {
  const f = fixture(t),
    token = f.platform.telegram.consentToken('org', 'p');
  f.platform.telegram.serviceConsent(token, '456', false, () => true, f.now);
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 2);
  for (const message of f.sent)
    assert.doesNotMatch(message.text, /Synthetic private procedure|Услуги:/);
});

test('first confirmation during delivery cancels the still-pending sibling', async (t) => {
  const f = fixture(t);
  for (const channel of ['telegram', 'max'])
    f.providers[channel].send = async (value) => {
      f.sent.push({ channel, ...value });
      assert.equal(
        f.coordinator.confirm(channel, value.confirmationToken, recipient(channel)).first,
        true,
      );
    };
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(jobs(f).filter((row) => row.status === 'cancelled').length, 1);
});

test('uncertain or rate-limited MAX does not block Telegram or cause a duplicate retry', async (t) => {
  for (const failure of ['uncertain', 'rate']) {
    const f = fixture(t);
    let attempts = 0;
    f.providers.max.send = async () => {
      attempts++;
      throw Object.assign(
        Error('synthetic failure'),
        failure === 'rate'
          ? { status: 429, retryAfter: 1, deliveryUncertain: false }
          : { deliveryUncertain: true },
      );
    };
    f.coordinator.remind('org', 'p', 'a');
    await f.coordinator.tick();
    assert.deepEqual(
      f.sent.map((row) => row.channel),
      ['telegram'],
    );
    const max = jobs(f).find((row) => row.decoded.channel === 'max');
    assert.equal(max.status, failure === 'rate' ? 'pending' : 'uncertain');
    const telegram = jobs(f).find((row) => row.decoded.channel === 'telegram');
    const receipt = f.coordinator.confirm(
      'telegram',
      telegram.decoded.callback,
      recipient('telegram'),
    );
    assert.equal(receipt.first, true);
    f.advance(120001);
    await f.coordinator.tick();
    assert.equal(attempts, 1);
    assert.equal(f.sent.length, 1);
  }
});

test('unknown and expired sending leases never authorize resend in that channel', async (t) => {
  const f = fixture(t);
  f.providers.telegram.status = () => ({ configured: false, connected: false });
  f.providers.max.send = async () => {
    throw Object.assign(Error('synthetic loss'), { deliveryUncertain: true });
  };
  const job = f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  assert.equal(f.store.read('org', 'p', 'a', job.stamp, 'max').status, 'uncertain');
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 0);
  f.a.time = '15:00';
  const next = f.coordinator.remind('org', 'p', 'a'),
    claimed = f.store.claim(f.now);
  f.store.transition(claimed, 'reserved', 'sending');
  f.advance(120001);
  await f.coordinator.tick();
  assert.equal(f.store.read('org', 'p', 'a', next.stamp, 'max').status, 'uncertain');
});

test('cancelled, edited, unlinked and foreign-recipient buttons cannot confirm', async (t) => {
  const f = fixture(t);
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  const max = jobs(f).find((row) => row.decoded.channel === 'max');
  assert.equal(
    f.coordinator.confirm('max', max.decoded.callback, { userId: '888', botId: '123' }),
    null,
  );
  assert.equal(
    f.coordinator.confirm('telegram', max.decoded.callback, recipient('telegram')),
    null,
  );
  f.a.status = 'cancelled';
  assert.equal(f.coordinator.confirm('max', max.decoded.callback, recipient('max')), null);
  f.a.status = 'scheduled';
  f.a.roomId = 'other';
  assert.equal(f.coordinator.confirm('max', max.decoded.callback, recipient('max')), null);
  delete f.a.roomId;
  f.links.stop('123', '789', f.now + 1, f.now + 1);
  assert.equal(f.coordinator.confirm('max', max.decoded.callback, recipient('max')), null);
});

test('staff confirmation cancels automatic delivery and late client reply cannot replace it', async (t) => {
  const f = fixture(t);
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  const max = jobs(f).find((row) => row.decoded.channel === 'max');
  const zone = f.platform.organizationTimeZone('org');
  const saved = f.platform.appointmentConfirmations.set('org', 'p', f.a, zone, 'owner', true);
  f.coordinator.cancelPending('org', 'p', 'a');
  f.advance(1000);
  const repeated = f.coordinator.confirm('max', max.decoded.callback, recipient('max'));
  assert.equal(repeated.first, false);
  assert.equal(repeated.manualConfirmedAt, saved.manualConfirmedAt);
  assert.equal(f.store.confirmed('org', 'p', 'a', max.stamp), null);
});

test('legacy Telegram sends suppress only Telegram duplication; legacy and MAX share the first receipt', async (t) => {
  for (const firstChannel of ['telegram', 'max']) {
    const f = fixture(t),
      zone = f.platform.organizationTimeZone('org');
    const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
    f.platform.telegram.enqueue(
      'org',
      'p',
      f.a,
      fingerprint(f.a, zone),
      f.platform.telegram.link('org', 'p'),
      Date.parse('2099-04-08'),
      f.now,
    );
    const legacy = f.platform.telegram.claim(f.now);
    f.platform.telegram.finish(legacy, 'sent');
    f.coordinator.remind('org', 'p', 'a');
    await f.coordinator.tick();
    assert.deepEqual(
      f.sent.map((row) => row.channel),
      ['max'],
    );
    const max = jobs(f)[0];
    const confirmTelegram = () => f.coordinator.confirmLegacy(legacy, '456');
    const confirmMax = () => f.coordinator.confirm('max', max.decoded.callback, recipient('max'));
    const receipt = firstChannel === 'telegram' ? confirmTelegram() : confirmMax();
    assert.equal(receipt.first, true);
    f.advance(1000);
    const repeated = firstChannel === 'telegram' ? confirmMax() : confirmTelegram();
    assert.equal(repeated.first, false);
    assert.equal(repeated.notificationConfirmedAt, receipt.notificationConfirmedAt);
    assert.equal(repeated.notificationConfirmedChannel, firstChannel);
  }
});

test('obsolete preference HTTP commands refuse mutations, authenticated MAX events still confirm', async (t) => {
  const f = fixture(t),
    service = createMaxConnections({
      platform: f.platform,
      tenantStore: f.tenantStore,
      links: f.links,
      botIdentity: f.identity,
      enabled: true,
      coordinator: f.coordinator,
      clock: () => f.now,
    });
  assert.equal(service.status(f.owner, 'p').canChooseDelivery, false);
  for (const method of ['savePreference', 'saveAppointmentPreference'])
    assert.throws(
      () => service[method](f.owner, { patientId: 'p', preference: 'manual' }, () => {}),
      { status: 410 },
    );
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  const max = jobs(f).find((row) => row.decoded.channel === 'max');
  const secret = 's'.repeat(32),
    events = createMaxEvents({
      connections: service,
      coordinator: f.coordinator,
      botId: '123',
      enabled: true,
      secret,
      clock: () => f.now,
    });
  const event = {
    update_type: 'message_callback',
    timestamp: f.now,
    callback: {
      callback_id: 'synthetic',
      payload: 'confirm_' + max.decoded.callback,
      user: { is_bot: false, user_id: '789' },
    },
    message: { recipient: { chat_type: 'dialog', user_id: '789' } },
  };
  assert.throws(() => events.receive('wrong', event), { status: 403 });
  assert.equal(events.receive(secret, event).confirmed, true);
  assert.equal(events.receive(secret, event).confirmed, true);
});

test('candidate 014 snapshots schema 13, preserves history, and empty rollback refuses populated delivery', (t) => {
  const f = fixture(t);
  assert.ok(f.channelMigration.snapshotDirectory);
  rollbackEmptyNotificationChannels(f.database);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 13);
  rollbackEmptyNotificationQueue(f.database);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 12);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  f.coordinator.remind('org', 'p', 'a');
  assert.throws(() => rollbackEmptyNotificationChannels(f.database), /full verified backup/);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 14);
});
