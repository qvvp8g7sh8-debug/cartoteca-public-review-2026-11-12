const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  seed,
  readManifest,
  queueSnapshot,
  populateProfile,
  validateManifest,
} = require('../scripts/benchmark-notifications-fixture.cjs');
const {
  createFakeNotificationAdapters,
} = require('../scripts/benchmark-notifications-adapters.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { createStorage } = require('../storage.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const root = path.resolve(__dirname, '..');

function manifest() {
  return {
    profile: 'notifications-v1',
    schema: 17,
    clients: [
      { organization: 'synthetic-org', telegram: '940000000', max: '950000000', bot: '930000001' },
    ],
    devices: [
      {
        organization: 'synthetic-org',
        account: 'synthetic-account',
        endpoint: 'https://fcm.googleapis.com/fcm/send/cartoteca-synthetic-0',
      },
    ],
    expected: { clientTelegram: 1, clientMax: 1, pushChange: 1 },
    excluded: [],
  };
}
const markup = { inline_keyboard: [[{ callback_data: 'confirm_synthetic-capability' }]] };
const payload = JSON.stringify({
  tag: 'synthetic-event',
  data: { organizationId: 'synthetic-org', event: 'change' },
});

test('notification seed and snapshots reject any unmarked/nonstand path before reading or opening data', () => {
  for (const directory of ['/opt/cartoteca-v2', '/app/runtime', '.', '/tmp/other']) {
    assert.throws(() => seed('/not-an-app', directory));
    assert.throws(() => readManifest(directory));
    assert.throws(() => queueSnapshot(directory));
  }
  assert.throws(() => validateManifest({ ...manifest(), clients: [] }));
  const altered = manifest();
  altered.clients[0].telegram = '123';
  assert.throws(() => createFakeNotificationAdapters(altered));
});

test('fake providers acknowledge real-shaped replies, reject foreign recipients, and count duplicates without serializing content', async () => {
  const m = manifest(),
    f = createFakeNotificationAdapters(m, { latencyMs: 0 });
  const tg = () =>
    f.options.telegramBot.send(m.clients[0].telegram, 'PRIVATE synthetic text', markup);
  assert.equal((await tg()).message_id, 1);
  await tg();
  await f.options.maxBot.send({
    recipient: { botId: '930000001', userId: '950000000' },
    text: 'PRIVATE synthetic text',
    confirmationToken: 'synthetic-max-capability',
  });
  await f.options.pushSend({ endpoint: m.devices[0].endpoint }, payload);
  await assert.rejects(f.options.telegramBot.send('123', 'not allowed', markup), { status: 400 });
  await assert.rejects(
    f.options.maxBot.send({
      recipient: { botId: '999', userId: '950000000' },
      text: 'not allowed',
      confirmationToken: 'bad',
    }),
    { status: 400 },
  );
  await assert.rejects(
    f.options.pushSend({ endpoint: 'https://fcm.googleapis.com/unknown' }, payload),
    { statusCode: 400 },
  );
  const result = f.snapshot();
  assert.equal(result.counters.telegram.acknowledged, 2);
  assert.equal(result.counters.telegram.duplicates, 1);
  assert.equal(result.counters.telegram.unknownRecipients, 1);
  assert.equal(result.counters.max.acknowledged, 1);
  assert.equal(result.counters.max.failures, 1);
  assert.equal(result.counters.push.acknowledged, 1);
  assert.equal(result.counters.push.unknownRecipients, 1);
  assert.equal(result.deliveryKeys.length, 3);
  assert.ok(result.deliveryKeys.every((key) => /^[a-f0-9]{64}$/.test(key)));
  assert.ok(!/PRIVATE|capability|fcm.googleapis|vapid|cookie/.test(JSON.stringify(result)));
  assert.equal(result.deliveredOrganizations, 1);
  assert.equal(result.deliveredAccounts, 1);
  assert.equal(result.inFlight, 0);
});

test('fake long polling and deliveries honor stop signals without pretending failures are successful sends', async () => {
  const f = createFakeNotificationAdapters(manifest(), { latencyMs: 100 });
  const controller = new AbortController();
  const delivery = f.options.telegramBot.send('940000000', 'synthetic', markup, controller.signal);
  const polling = f.options.telegramBot.updates(0, controller.signal);
  controller.abort();
  await assert.rejects(delivery, { name: 'AbortError' });
  await assert.rejects(polling, { name: 'AbortError' });
  await f.settle();
  assert.equal(f.snapshot().counters.telegram.aborted, 1);
  assert.equal(f.snapshot().counters.telegram.acknowledged, 0);
  assert.equal(f.snapshot().counters.telegram.failures, 0);
  assert.equal(f.snapshot().inFlight, 0);
});

test('same delivered event has the same non-secret digest in different fake workers', async () => {
  const first = createFakeNotificationAdapters(manifest(), { latencyMs: 0 });
  const second = createFakeNotificationAdapters(manifest(), { latencyMs: 0 });
  for (const f of [first, second])
    await f.options.telegramBot.send('940000000', 'Synthetic', markup);
  assert.deepEqual(first.snapshot().deliveryKeys, second.snapshot().deliveryKeys);
  assert.notEqual(
    first.snapshot().deliveryKeys[0],
    createHash('sha256').update('Synthetic').digest('hex'),
  );
});

test('nonempty synthetic profile traverses real common and Push queues with fresh eligibility and durable acknowledgements', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  const first = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const actors = f.users.map((user, index) => ({
    id: user.accountId,
    org: f.owner.organizationId,
    index: 0,
    role: ['owner', 'salon_admin', 'cosmetologist', 'cosmetologist'][index],
    patient: 'p-0-' + index,
    cookie: 'cartoteca_v2_session=' + user.token,
  }));
  const fixture = {
    version: 2,
    schema: 17,
    first,
    cards: 10,
    visits: 0,
    organizations: [f.owner.organizationId],
    actors,
  };
  const directory = path.join(f.source, 'tenants', f.owner.organizationId);
  const store = createStorage(directory);
  store.write({
    revision: 0,
    services: [],
    patients: actors.map((actor, index) => ({
      id: actor.patient,
      name: 'Synthetic Client',
      createdBy: actor.id,
      visits: [],
      appointments: [
        {
          id: 'a-' + index,
          date: first,
          time: '10:00',
          duration: 30,
          service: 'Synthetic service',
          status: 'scheduled',
          staffId: index === 1 ? actors[0].id : actor.id,
        },
      ],
    })),
  });
  store.close();
  const value = populateProfile({
    root,
    platform: f.platform,
    database: f.database,
    fixture,
    tenantStore: () => createStorage(directory),
  });
  assert.deepEqual(value.expected, { clientTelegram: 1, clientMax: 1, pushChange: 4 });
  assert.equal(
    f.database.db.prepare('SELECT count(*) n FROM notification_channel_jobs').get().n,
    0,
  );
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM staff_push_jobs').get().n, 4);
  assert.throws(
    () =>
      populateProfile({
        root,
        platform: f.platform,
        database: f.database,
        fixture,
        tenantStore: () => createStorage(directory),
      }),
    /Fresh profile only/,
  );
  const adapters = createFakeNotificationAdapters(value, { latencyMs: 0 });
  const server = createMultiServer({
    ...adapters.options,
    dataDir: f.source,
    origin: 'https://synthetic.test',
    notificationSchema: 17,
    processRole: 'combined',
    metricsEnabled: false,
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await server.telegramRuntime.initialize();
    await server.telegramRuntime.tick();
    server.staffPushRuntime.start();
    await server.staffPushRuntime.tick();
    await server.telegramRuntime.tick();
    await server.staffPushRuntime.tick();
    const measured = adapters.snapshot();
    assert.deepEqual(
      ['telegram', 'max', 'push'].map((key) => measured.counters[key].acknowledged),
      [1, 1, 4],
    );
    assert.ok(
      Object.values(measured.counters).every(
        (counter) => !counter.duplicates && !counter.failures && !counter.unknownRecipients,
      ),
    );
    assert.equal(
      f.database.db
        .prepare("SELECT count(*) n FROM notification_channel_jobs WHERE status='sent'")
        .get().n,
      2,
    );
    assert.equal(
      f.database.db.prepare("SELECT count(*) n FROM staff_push_jobs WHERE status='sent'").get().n,
      4,
    );
    assert.equal(measured.deliveredAccounts, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
