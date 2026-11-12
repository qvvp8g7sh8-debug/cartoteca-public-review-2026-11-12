const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { maxFixture } = require('./max-fixture.cjs');
const { createStorage } = require('../storage.cjs');
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
  recordClientAppointmentChanges,
} = require('../src/server/modules/notifications/client-appointment-events.cjs');
const journal = require('../src/server/modules/notifications/appointment-event-journal.cjs');

// Temporary encrypted synthetic stores; no app data, bots, HTTP or provider credentials.
function fixture(t) {
  const cleanup = [],
    f = maxFixture({ after: (work) => cleanup.push(work) });
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  const storage = createStorage(path.join(f.dataDir, 'synthetic-cabinet'));
  t.after(() => {
    storage.close();
    for (const work of cleanup) work();
  });
  storage.write({
    revision: 0,
    patients: [
      {
        id: 'p',
        name: 'Secret synthetic client',
        phone: '+79990001234',
        createdBy: 'owner',
        notes: 'Secret synthetic clinical history',
        visits: [],
        appointments: [],
      },
    ],
    services: [],
  });
  const { db, seal } = f.database,
    store = createNotificationStore(f.database);
  let now = f.now;
  db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?)').run(
    'org',
    'p',
    f.database.limitKey('telegram-chat', '456'),
    seal({ chatId: '456', linkedAt: now, servicesConsent: true }),
  );
  const invitation = f.links.issue('org', 'p', 'owner', '123', () => {}, now);
  f.links.consume(invitation.token, '123', '789', () => {}, now);
  f.platform.maxLinks = f.links;
  const channelState = {
    telegram: { enabled: true, version: '' },
    max: { enabled: true, version: '' },
  };
  f.platform.notificationChannels = {
    enabled: (channel) => channelState[channel].enabled,
    version: (channel) => channelState[channel].version,
  };
  const sent = [],
    configured = { telegram: true, max: true },
    ready = { telegram: true, max: true },
    attempts = { telegram: 0, max: 0 };
  const providers = Object.fromEntries(
    ['telegram', 'max'].map((channel) => [
      channel,
      {
        status: () => ({
          configured: configured[channel],
          connected: ready[channel],
          botId: channel === 'max' ? '123' : '321',
        }),
        acquire: async () => true,
        send: async (message) => {
          attempts[channel]++;
          sent.push({ channel, ...message });
          return { message_id: 42, message: { body: { mid: 'synthetic-mid' } } };
        },
      },
    ]),
  );
  const coordinator = createNotificationCoordinator({
    platform: f.platform,
    tenantStore: () => storage,
    store,
    links: f.links,
    providers,
    clock: () => now,
  });
  const appointment = {
    id: 'a',
    date: '2099-04-08',
    time: '14:00',
    duration: 60,
    staffId: 'owner',
    status: 'scheduled',
    service: 'Synthetic private procedure',
  };
  const settings = () => f.platform.telegram.settings('org');
  const events = (selected) => {
    const before = settings();
    return f.platform.telegram.saveReminderPeriod('org', 'owner', {
      leadMinutes: before.leadMinutes,
      expectedLeadMinutes: before.leadMinutes,
      events: selected,
      expectedEvents: before.events,
    });
  };
  function write(work, { capture = true, cabinetFailure = false } = {}) {
    return storage.transaction(() => {
      const before = storage.read(),
        next = structuredClone(before);
      work(next.patients[0]);
      const saved = storage.write(next, { insideTransaction: true, preparedBefore: before });
      const entries = capture
        ? recordClientAppointmentChanges(
            f.platform,
            'org',
            storage,
            before,
            { ...next, revision: saved.revision },
            now,
          )
        : [];
      if (cabinetFailure) throw Error('Synthetic cabinet rollback');
      return entries;
    });
  }
  const commit = (work, options) => f.database.transaction(() => write(work, options));
  const jobs = () =>
    db
      .prepare("SELECT * FROM notification_channel_jobs WHERE organization_id='org'")
      .all()
      .map((row) => ({ ...row, decoded: f.database.open(row.value) }));
  return {
    ...f,
    storage,
    store,
    coordinator,
    sent,
    ready,
    configured,
    channelState,
    providers,
    appointment,
    settings,
    events,
    attempts,
    write,
    commit,
    jobs,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('client event settings preserve legacy defaults, compare-and-set, role ACL and canonical order', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.settings().events, ['reminder']);
  const old = f.settings();
  const saved = f.events(['cancelled', 'created', 'reminder', 'moved']);
  assert.deepEqual(saved.events, ['reminder', 'created', 'moved', 'cancelled']);
  assert.throws(
    () =>
      f.platform.telegram.saveReminderPeriod('org', 'owner', {
        leadMinutes: old.leadMinutes,
        expectedLeadMinutes: old.leadMinutes,
        events: ['created'],
        expectedEvents: old.events,
      }),
    { status: 409 },
  );
  assert.throws(
    () =>
      f.platform.telegram.saveReminderPeriod('org', 'owner', {
        leadMinutes: old.leadMinutes,
        expectedLeadMinutes: old.leadMinutes,
        events: ['created', 'unknown'],
        expectedEvents: saved.events,
      }),
    { status: 400 },
  );
  assert.throws(
    () =>
      f.platform.telegram.saveReminderPeriod('org', 'staff', {
        leadMinutes: old.leadMinutes,
        expectedLeadMinutes: old.leadMinutes,
        events: [],
        expectedEvents: saved.events,
      }),
    { status: 403 },
  );
  assert.deepEqual(f.platform.telegram.settings('other-org').events, ['reminder']);
  f.commit((p) => p.appointments.push({ ...f.appointment }), { capture: false });
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
});

test('created, moved and cancelled reach both channels once without confirmation receipts or private fields', async (t) => {
  const f = fixture(t);
  f.events(['reminder', 'created', 'moved', 'cancelled']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.replayAppointmentEvents('org');
  const a = f.storage.readAppointment('p', 'a');
  f.platform.appointmentConfirmations.set(
    'org',
    'p',
    a,
    f.platform.organizationTimeZone('org'),
    'owner',
    true,
  );
  await f.coordinator.tick();
  assert.equal(f.sent.length, 2, 'manual confirmation must not suppress creation notices');
  f.commit((p) => {
    p.appointments[0].time = '15:00';
  });
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  for (const message of f.sent.slice(2)) {
    assert.match(message.text, /Было: 08\.04\.2099 в 14:00/);
    assert.match(message.text, /Стало: 08\.04\.2099 в 15:00/);
  }
  f.commit((p) => {
    p.appointments[0].status = 'cancelled';
  });
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 6);
  assert.ok(f.sent.slice(4).every((message) => message.text.includes('Ваша запись отменена')));
  for (const message of f.sent) {
    assert.equal(message.confirmationToken, '');
    assert.doesNotMatch(
      message.text,
      /Secret synthetic|\+79990001234|Подтвердите|Ваша запись подтверждена/,
    );
  }
  const jobs = f.jobs();
  assert.deepEqual(jobs.map((job) => job.decoded.kind).sort(), [
    'cancelled',
    'cancelled',
    'created',
    'created',
    'moved',
    'moved',
  ]);
  assert.ok(
    jobs.every(
      (job) =>
        job.status === 'sent' &&
        job.decoded.messageId &&
        job.decoded.acceptedAt === f.now() &&
        job.decoded.createdAt === f.now(),
    ),
  );
  const created = jobs.find((job) => job.decoded.kind === 'created');
  assert.equal(
    f.coordinator.confirm('telegram', created.decoded.callback, { chatId: '456' }),
    null,
  );
  assert.equal(
    f.database.db.prepare('SELECT count(*) n FROM notification_confirmations').get().n,
    0,
  );
  assert.equal(f.storage.get('booking-classic-confirmations'), null);
});

test('disabling events cancels pending jobs and off/on cannot resurrect an older journal entry', async (t) => {
  const f = fixture(t);
  f.events(['reminder', 'created']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.replayAppointmentEvents('org');
  assert.equal(f.jobs().length, 2);
  f.events(['reminder']);
  assert.ok(f.jobs().every((job) => job.status === 'cancelled'));
  f.events(['reminder', 'created']);
  f.commit((p) => p.appointments.push({ ...f.appointment, id: 'b', time: '16:00' }));
  f.events(['reminder']);
  f.events(['reminder', 'created']);
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.jobs().length, 2);
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
});

test('explicit restore resume rotates unchanged event preferences and rejects restored journal and queued notices', async (t) => {
  const f = fixture(t);
  f.events(['reminder', 'created', 'moved', 'cancelled']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.replayAppointmentEvents('org');
  f.commit((p) => p.appointments.push({ ...f.appointment, id: 'b', time: '15:00' }));
  const before = f.settings();
  f.database.db
    .prepare("UPDATE telegram_settings SET value=? WHERE organization_id='org'")
    .run(f.database.seal({ ...before, restoredPaused: true }));
  const saved = f.platform.telegram.saveReminderPeriod('org', 'owner', {
    leadMinutes: before.leadMinutes,
    expectedLeadMinutes: before.leadMinutes,
    events: before.events,
    expectedEvents: before.events,
    resumeRestored: true,
  });
  assert.deepEqual(saved.events, before.events);
  assert.equal(saved.restoredPaused, false);
  for (const kind of before.events)
    assert.notEqual(saved.eventVersions[kind], before.eventVersions[kind]);
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
  assert.ok(f.jobs().every((job) => job.status === 'cancelled'));
  f.commit((p) => p.appointments.push({ ...f.appointment, id: 'c', time: '16:00' }));
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 2, 'new changes after explicit resume remain deliverable');
});
test('stale source and revoked staff access cancel queued notices before provider delivery', async (t) => {
  for (const reason of ['moved-again', 'revoked-member']) {
    const f = fixture(t);
    f.events(['created']);
    f.commit((p) => p.appointments.push({ ...f.appointment }));
    f.coordinator.replayAppointmentEvents('org');
    if (reason === 'moved-again')
      f.commit(
        (p) => {
          p.appointments[0].time = '17:00';
        },
        { capture: false },
      );
    else
      f.database.db
        .prepare(
          "UPDATE memberships SET status='inactive' WHERE organization_id='org' AND account_id='owner'",
        )
        .run();
    await f.coordinator.tick();
    assert.equal(f.sent.length, 0);
    assert.ok(f.jobs().every((job) => job.status === 'cancelled'));
  }
});

test('a new binding is never opted into an old event and Telegram rebind suppresses only that recipient', async (t) => {
  const f = fixture(t);
  f.events(['created']);
  const max = f.links.link('org', 'p');
  f.database.db
    .prepare("DELETE FROM max_client_links WHERE organization_id='org' AND patient_id='p'")
    .run();
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.database.db
    .prepare('INSERT INTO max_client_links VALUES(?,?,?,?)')
    .run('org', 'p', 'synthetic-new-binding', f.database.seal(max));
  f.coordinator.replayAppointmentEvents('org');
  assert.deepEqual(
    f.jobs().map((job) => job.channel),
    ['telegram'],
  );
  f.database.db
    .prepare("UPDATE telegram_links SET value=? WHERE organization_id='org' AND patient_id='p'")
    .run(f.database.seal({ chatId: '456', linkedAt: f.now() + 1, servicesConsent: true }));
  await f.coordinator.tick();
  assert.equal(f.sent.length, 0);
});

test('cabinet rollback drops journal, platform rollback after cabinet commit preserves replay, nested replay cannot retire early', async (t) => {
  const f = fixture(t);
  f.events(['created']);
  assert.throws(
    () =>
      f.commit((p) => p.appointments.push({ ...f.appointment }), {
        cabinetFailure: true,
      }),
    /Synthetic cabinet rollback/,
  );
  assert.equal(f.storage.readAppointment('p', 'a'), null);
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
  assert.throws(
    () =>
      f.database.transaction(() => {
        f.write((p) => p.appointments.push({ ...f.appointment }));
        throw Error('Synthetic platform rollback after cabinet COMMIT');
      }),
    /Synthetic platform rollback/,
  );
  assert.ok(f.storage.readAppointment('p', 'a'));
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 1);
  assert.throws(
    () =>
      f.database.transaction(() => {
        f.coordinator.replayAppointmentEvents('org');
        assert.equal(journal.pending(f.storage, f.now(), 'client').length, 1);
        throw Error('Synthetic queue rollback');
      }),
    /Synthetic queue rollback/,
  );
  assert.equal(f.jobs().length, 0);
  f.coordinator.replayAppointmentEvents('org');
  assert.equal(f.jobs().length, 2);
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  await f.coordinator.tick();
  assert.equal(f.sent.length, 2);
});

test('temporarily unavailable MAX remains journaled without repeating an accepted Telegram notice', async (t) => {
  const f = fixture(t);
  f.events(['created']);
  f.ready.max = false;
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.deepEqual(
    f.sent.map((message) => message.channel),
    ['telegram'],
  );
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 1);
  f.ready.max = true;
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.deepEqual(f.sent.map((message) => message.channel).sort(), ['max', 'telegram']);
  assert.equal(f.attempts.telegram, 1);
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
});

test('reminders have independent dedup and confirming one does not cancel pending lifecycle notices', async (t) => {
  const f = fixture(t);
  f.events(['reminder', 'created']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  f.coordinator.replayAppointmentEvents('org');
  const reminder = f
    .jobs()
    .find((job) => job.channel === 'telegram' && job.decoded.kind === 'reminder');
  assert.equal(
    f.coordinator.confirm('telegram', reminder.decoded.callback, { chatId: '456' }).first,
    true,
  );
  assert.equal(
    f.jobs().filter((job) => job.decoded.kind === 'created' && job.status === 'pending').length,
    2,
  );
  await f.coordinator.tick();
  assert.equal(f.sent.length, 4);
});

test('removed appointments notify only while their original patient still exists; service opt-out covers both channels', async (t) => {
  const f = fixture(t);
  f.events(['cancelled']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.platform.telegram.serviceConsent(
    f.platform.telegram.consentToken('org', 'p'),
    '456',
    false,
    () => true,
    f.now(),
  );
  f.commit((p) => {
    p.appointments = [];
  });
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 2);
  for (const message of f.sent)
    assert.doesNotMatch(message.text, /Synthetic private procedure|Услуги:/);
});

test('turning reminder delivery off keeps an already sent current button valid in both common channels', async (t) => {
  const f = fixture(t);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.remind('org', 'p', 'a');
  await f.coordinator.tick();
  const sent = f.jobs();
  f.events([]);
  const telegram = sent.find((job) => job.channel === 'telegram');
  const max = sent.find((job) => job.channel === 'max');
  const receipt = f.coordinator.confirm('telegram', telegram.decoded.callback, { chatId: '456' });
  assert.equal(receipt.first, true);
  assert.equal(
    f.coordinator.confirm('max', max.decoded.callback, { userId: '789', botId: '123' }).first,
    false,
  );
  assert.throws(() => f.coordinator.remind('org', 'p', 'a'), { status: 409 });
  f.commit(
    (p) => {
      p.appointments[0].time = '15:00';
    },
    { capture: false },
  );
  assert.equal(
    f.coordinator.confirm('telegram', telegram.decoded.callback, { chatId: '456' }),
    null,
  );
});

test('legacy Telegram keeps a sent button valid after reminder opt-out but still rejects restore pause', async (t) => {
  const f = fixture(t);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  const {
    createTelegramRuntime,
  } = require('../src/server/modules/notifications/telegram-runtime.cjs');
  const { fingerprint, startsAt } = require('../src/server/modules/notifications/appointments.cjs');
  const answers = [],
    bot = {
      initialize: async () => ({ username: 'synthetic_bot', botId: '321' }),
      send: async () => ({ message_id: 42 }),
      answer: async (_, text) => answers.push(text),
      clearButtons: async () => {},
    };
  const runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: () => f.storage,
    bot,
    clock: f.now,
  });
  await runtime.initialize();
  const a = f.storage.readAppointment('p', 'a'),
    zone = f.settings().timeZone;
  f.platform.telegram.enqueue(
    'org',
    'p',
    a,
    fingerprint(a, zone),
    f.platform.telegram.link('org', 'p'),
    startsAt(a, zone),
    f.now(),
  );
  await runtime.tick();
  const row = f.database.db
    .prepare("SELECT * FROM telegram_jobs WHERE organization_id='org' AND patient_id='p'")
    .get();
  assert.equal(row.status, 'sent');
  const callback = f.database.open(row.value).callback;
  f.events([]);
  const update = {
    callback_query: {
      id: 'synthetic-callback',
      data: 'confirm_' + callback,
      from: { id: '456' },
      message: { message_id: 42, chat: { id: '456', type: 'private' } },
    },
  };
  await runtime.handleUpdate(update);
  assert.match(answers.at(-1), /Спасибо/);
  f.database.db
    .prepare("UPDATE telegram_settings SET value=? WHERE organization_id='org'")
    .run(f.database.seal({ ...f.settings(), restoredPaused: true }));
  await runtime.handleUpdate(update);
  assert.match(answers.at(-1), /больше не действует/);
});

test('all globally disabled channels skip capture, scheduler SQL, cabinet reads and queue claim', async (t) => {
  const f = fixture(t);
  f.events(['created']);
  for (const channel of ['telegram', 'max']) f.channelState[channel].enabled = false;
  t.mock.method(f.platform.telegram, 'settings', () =>
    assert.fail('disabled capture must skip settings'),
  );
  t.mock.method(f.store, 'organizationBatch', () =>
    assert.fail('disabled scheduler must skip SQL'),
  );
  t.mock.method(f.store, 'claim', () => assert.fail('disabled worker must not touch the queue'));
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
  assert.equal(f.coordinator.schedule(), true);
  await f.coordinator.tick();
  assert.equal(f.jobs().length, 0);
});

test('globally disabled channel is absent from new lifecycle snapshots and is not backfilled after on', async (t) => {
  const f = fixture(t);
  f.events(['created']);
  f.channelState.telegram.enabled = false;
  f.channelState.telegram.version = 'synthetic-telegram-off';
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  assert.deepEqual(Object.keys(journal.pending(f.storage, f.now(), 'client')[0].recipients), [
    'max',
  ]);
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.deepEqual(
    f.sent.map((message) => message.channel),
    ['max'],
  );
  f.channelState.telegram.enabled = true;
  f.channelState.telegram.version = 'synthetic-telegram-resumed';
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 1);
  f.commit((p) => p.appointments.push({ ...f.appointment, id: 'fresh', time: '16:00' }));
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.equal(f.sent.length, 3);
});

test('global off-on invalidates older captured and queued channel versions while ready sibling proceeds', async (t) => {
  const f = fixture(t);
  f.events(['created']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.replayAppointmentEvents('org');
  f.commit((p) => p.appointments.push({ ...f.appointment, id: 'journal', time: '16:00' }));
  f.channelState.telegram.enabled = false;
  f.channelState.telegram.version = 'synthetic-off';
  f.channelState.telegram.enabled = true;
  f.channelState.telegram.version = 'synthetic-on';
  f.coordinator.replayAppointmentEvents('org');
  await f.coordinator.tick();
  assert.deepEqual(
    f.sent.map((message) => message.channel),
    ['max', 'max'],
  );
  assert.equal(f.jobs().filter((job) => job.channel === 'telegram').length, 1);
  assert.equal(f.jobs().find((job) => job.channel === 'telegram').status, 'cancelled');
  assert.equal(journal.pending(f.storage, f.now(), 'client').length, 0);
});

test('temporarily disconnected channel remains byte-for-byte untouched while ready sibling sends', async (t) => {
  const f = fixture(t);
  f.events(['created']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.replayAppointmentEvents('org');
  f.ready.telegram = false;
  const before = f.database.db
    .prepare("SELECT * FROM notification_channel_jobs WHERE channel='telegram'")
    .get();
  for (let pass = 0; pass < 3; pass++) {
    await f.coordinator.tick();
    f.advance(31000);
    assert.deepEqual(
      f.database.db
        .prepare("SELECT * FROM notification_channel_jobs WHERE channel='telegram'")
        .get(),
      before,
    );
  }
  assert.deepEqual(
    f.sent.map((message) => message.channel),
    ['max'],
  );
  f.ready.telegram = true;
  await f.coordinator.tick();
  assert.deepEqual(
    f.sent.map((message) => message.channel),
    ['max', 'telegram'],
  );
});

test('all client types off skips the queue claim and appointment scan while providers are ready', async (t) => {
  const f = fixture(t);
  f.events([]);
  t.mock.method(f.store, 'claim', () => assert.fail('all types off must skip queue claim'));
  t.mock.method(f.storage.indexes, 'appointments', () =>
    assert.fail('reminder off must skip calendar scan'),
  );
  t.mock.method(f.storage, 'readAppointment', () =>
    assert.fail('all types off must skip appointment reads'),
  );
  assert.equal(f.coordinator.schedule(), true);
  await f.coordinator.tick();
  assert.equal(f.sent.length, 0);
});

test('an empty or unavailable channel claim does not start a platform transaction; expired sending lease still recovers', (t) => {
  const f = fixture(t);
  let transactions = 0;
  const store = createNotificationStore({
    ...f.database,
    transaction(work) {
      transactions++;
      return f.database.transaction(work);
    },
  });
  assert.equal(store.claim(f.now(), []), null);
  assert.equal(store.claim(f.now(), ['telegram']), null);
  assert.equal(transactions, 0);
  f.events(['created']);
  f.commit((p) => p.appointments.push({ ...f.appointment }));
  f.coordinator.replayAppointmentEvents('org');
  const telegram = store.claim(f.now(), ['telegram']);
  assert.equal(telegram.channel, 'telegram');
  assert.equal(store.transition(telegram, 'reserved', 'sending'), true);
  const untouched = f.database.db
    .prepare("SELECT * FROM notification_channel_jobs WHERE channel='telegram'")
    .get();
  const max = store.claim(f.now() + 120001, ['max']);
  assert.equal(max.channel, 'max');
  assert.deepEqual(
    f.database.db.prepare("SELECT * FROM notification_channel_jobs WHERE channel='telegram'").get(),
    untouched,
  );
  assert.equal(store.claim(f.now() + 120001, ['telegram']), null);
  assert.equal(f.jobs().find((job) => job.channel === 'telegram').status, 'uncertain');
});
