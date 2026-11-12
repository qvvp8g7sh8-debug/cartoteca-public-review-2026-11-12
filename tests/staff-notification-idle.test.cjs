const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const {
  createStaffNotificationInterest,
  resetStaffNotificationInterest,
} = require('../src/server/modules/notifications/staff-notification-interest.cjs');
const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
const {
  createStaffEventReplay,
} = require('../src/server/modules/notifications/staff-event-replay.cjs');
const {
  recordStaffAppointmentEvents,
  replayStaffAppointmentEvents,
} = require('../src/server/modules/notifications/staff-appointment-events.cjs');
const {
  createStaffTelegramRuntime,
} = require('../src/server/modules/notifications/staff-runtime.cjs');
const {
  createStaffMaxRuntime,
} = require('../src/server/modules/notifications/staff-max-runtime.cjs');
function fixture(t, initiallyEnabled = true) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,PRIMARY KEY(organization_id,account_id));
    INSERT INTO organizations VALUES('synthetic-org','active');
    INSERT INTO accounts VALUES('synthetic-owner','active');
    INSERT INTO memberships VALUES('synthetic-org','synthetic-owner','owner','active');`);
  for (const channel of ['telegram', 'max']) {
    const links = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links',
      jobs = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
    db.exec(`CREATE TABLE ${links}(organization_id TEXT,account_id TEXT,chat_hash TEXT,value BLOB,PRIMARY KEY(organization_id,account_id));
      CREATE TABLE ${jobs}(id TEXT PRIMARY KEY,organization_id TEXT,account_id TEXT,event_key TEXT,value BLOB,status TEXT,attempts INTEGER DEFAULT 0,next_at INTEGER,expires_at INTEGER,lease_until INTEGER DEFAULT 0,lease_id TEXT,UNIQUE(organization_id,account_id,event_key));
      CREATE INDEX ${jobs}_due ON ${jobs}(status,next_at);`);
  }
  let opens = 0,
    transactions = 0;
  const enabled = { telegram: initiallyEnabled, max: initiallyEnabled },
    versions = { telegram: '', max: '' };
  const c = {
    db,
    seal: (value) => Buffer.from(JSON.stringify(value)),
    open: (value) => {
      opens++;
      return JSON.parse(Buffer.from(value).toString());
    },
    notificationChannels: {
      enabled: (channel) => enabled[channel],
      version: (channel) => versions[channel],
    },
    transaction(fn) {
      if (db.isTransaction) return fn();
      transactions++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    id: randomUUID,
    limitKey: (_kind, key) => key,
    fail: (status, message) => Object.assign(Error(message), { status }),
    onlineBooking: {
      actor: () => ({ organizationId: 'synthetic-org', accountId: 'synthetic-owner' }),
    },
  };
  const interests = {},
    queues = {};
  for (const channel of ['telegram', 'max']) {
    const table = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links';
    const interest = (interests[channel] = createStaffNotificationInterest(c, channel));
    const links = {
      interest,
      allowed: () => true,
      member: () => ({ role: 'owner' }),
      link(org, account) {
        const row = db
          .prepare(`SELECT value FROM ${table} WHERE organization_id=? AND account_id=?`)
          .get(org, account);
        return row ? c.open(row.value) : null;
      },
    };
    queues[channel] = createStaffQueue(c, links, channel);
  }
  function link(channel, events, master = true) {
    const table = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links';
    const value = {
      enabled: master,
      events,
      chatId: channel === 'max' ? '123:456' : '123',
      bindingId: 'synthetic-binding',
    };
    c.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO ${table} VALUES(?,?,?,?)`).run(
        'synthetic-org',
        'synthetic-owner',
        'synthetic-chat',
        c.seal(value),
      );
      interests[channel].update('synthetic-org', 'synthetic-owner', value);
    });
    return value;
  }
  return {
    db,
    c,
    enabled,
    versions,
    interests,
    queues,
    link,
    stats: () => ({ opens, transactions }),
    reset: () => {
      opens = 0;
      transactions = 0;
    },
  };
}
for (const channel of ['telegram', 'max']) {
  test(
    channel +
      ' marker queries use no link decrypt and react immediately to preferences, master and active ACL',
    (t) => {
      const f = fixture(t),
        index = f.interests[channel];
      f.link(channel, ['new-request']);
      assert.deepEqual(index.organizations('', 5), []);
      f.link(channel, ['moved']);
      f.reset();
      assert.deepEqual(index.organizations('', 5), ['synthetic-org']);
      assert.equal(index.hasAppointments('synthetic-org'), true);
      assert.deepEqual(index.rows('synthetic-org', '', 'created'), []);
      assert.equal(f.stats().opens, 0);
      const secondWorker = createStaffNotificationInterest(f.c, channel);
      f.link(channel, []);
      assert.deepEqual(secondWorker.organizations('', 5), []);
      f.link(channel, ['moved'], false);
      assert.equal(index.hasAppointments('synthetic-org'), false);
      f.link(channel, ['moved']);
      for (const table of ['memberships', 'accounts', 'organizations']) {
        f.db.prepare(`UPDATE ${table} SET status='inactive'`).run();
        assert.deepEqual(index.organizations('', 5), []);
        assert.equal(index.hasAppointments('synthetic-org'), false);
        f.db.prepare(`UPDATE ${table} SET status='active'`).run();
      }
      assert.throws(
        () =>
          f.c.transaction(() => {
            index.update('synthetic-org', 'synthetic-owner', null);
            throw Error('Synthetic rollback');
          }),
        /Synthetic rollback/,
      );
      assert.equal(index.hasAppointments('synthetic-org'), true);
    },
  );
  test(channel + ' globally off skips bootstrap and later enabled bootstrap is cold only', (t) => {
    const f = fixture(t, false),
      table = channel === 'max' ? 'staff_max_links' : 'staff_telegram_links';
    f.db
      .prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`)
      .run(
        'synthetic-org',
        'synthetic-owner',
        'synthetic-chat',
        f.c.seal({ enabled: true, events: ['moved'] }),
      );
    f.reset();
    assert.deepEqual(f.interests[channel].organizations('', 5), []);
    assert.equal(f.stats().opens, 0);
    assert.equal(f.stats().transactions, 0);
    f.enabled[channel] = true;
    assert.deepEqual(f.interests[channel].organizations('', 5), ['synthetic-org']);
    assert.equal(f.stats().opens, 1);
    f.reset();
    for (let n = 0; n < 3; n++)
      assert.deepEqual(f.interests[channel].organizations('', 5), ['synthetic-org']);
    assert.deepEqual(f.stats(), { opens: 0, transactions: 0 });
  });
  test(
    channel +
      ' idle claim does not write or start transactions, while explicit own test works with all types off',
    (t) => {
      const f = fixture(t),
        queue = f.queues[channel];
      f.link(channel, []);
      f.reset();
      const before = f.db.prepare('SELECT total_changes() n').get().n;
      for (let n = 0; n < 5; n++) assert.equal(queue.claim(1000), null);
      assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
      assert.deepEqual(f.stats(), { opens: 0, transactions: 0 });
      queue.test('synthetic-session', { bindingId: 'synthetic-binding' }, 1000);
      const job = queue.claim(1000);
      assert.deepEqual(queue.valid(job, 1000), { kind: 'test' });
      f.enabled[channel] = false;
      f.reset();
      const paused = f.db.prepare('SELECT total_changes() n').get().n;
      assert.equal(queue.claim(1001), null);
      assert.equal(queue.valid(job, 1001), null);
      queue.enqueue('synthetic-org', {}, 'new-request', 1001);
      queue.enqueueAppointment('synthetic-org', '', 'moved', {}, 'synthetic-event', 1001);
      assert.equal(f.db.prepare('SELECT total_changes() n').get().n, paused);
      assert.deepEqual(f.stats(), { opens: 0, transactions: 0 });
      f.versions[channel] = 'after-off-on';
      f.enabled[channel] = true;
      assert.equal(queue.valid(job, 1001), null);
    },
  );
  test(
    channel + ' unavailable worker never pages organizations, claims or opens cabinets',
    async () => {
      let globallyEnabled = false;
      const forbidden = () => {
        throw Error('Disabled worker attempted work');
      };
      const store = { organizationPage: forbidden, claim: forbidden };
      const options = {
        platform: {
          notificationChannels: { enabled: () => globallyEnabled },
          staffNotifications: store,
        },
        store,
        identity: { botId: '123' },
        tenantStore: forbidden,
        bot: { send: forbidden },
        pacing: {},
      };
      const runtime =
        channel === 'max' ? createStaffMaxRuntime(options) : createStaffTelegramRuntime(options);
      await runtime.tick(undefined, () => true);
      globallyEnabled = true;
      await runtime.tick(undefined, () => false);
    },
  );
  test(
    channel + ' all types off does not invoke claim but an explicit indexed self-test still sends',
    async (t) => {
      const f = fixture(t),
        store = f.queues[channel];
      f.link(channel, ['new-request']);
      f.c.transaction(() =>
        store.enqueue(
          'synthetic-org',
          { id: 'synthetic-stale-event', revision: 0, staffId: 'synthetic-owner' },
          'new-request',
          999,
        ),
      );
      f.link(channel, []);
      let claims = 0,
        sent = 0;
      const claim = store.claim;
      store.claim = (...args) => {
        claims++;
        return claim(...args);
      };
      const platform = {
        notificationChannels: f.c.notificationChannels,
        staffNotifications: f.queues.telegram,
        staffMaxNotifications: f.queues.max,
        withWriteLock: f.c.transaction,
        organization: () => ({ name: 'Synthetic organization' }),
      };
      const options = {
        platform,
        store,
        identity: { botId: '123' },
        clock: () => 1000,
        tenantStore() {
          throw Error('All appointment types are off');
        },
        pacing: { acquire: async () => true },
        bot: {
          async send() {
            sent++;
          },
        },
      };
      const runtime =
        channel === 'max' ? createStaffMaxRuntime(options) : createStaffTelegramRuntime(options);
      f.reset();
      await runtime.tick(undefined, () => true);
      assert.equal(claims, 0);
      assert.deepEqual(f.stats(), { opens: 0, transactions: 0 });
      store.test('synthetic-session', { bindingId: 'synthetic-binding' }, 1000);
      await runtime.tick(undefined, () => true);
      assert.equal(sent, 1);
      const finishedClaims = claims;
      await runtime.tick(undefined, () => true);
      assert.equal(claims, finishedClaims);
      assert.equal(
        f.db
          .prepare('SELECT count(*) n FROM telegram_runtime WHERE key>=? AND key<?')
          .get(`staff-selftest-v1:${channel}:`, `staff-selftest-v1:${channel}:\uffff`).n,
        0,
      );
    },
  );
}
test('cold interest bootstrap joins an existing platform transaction without invoking another transaction wrapper', (t) => {
  const f = fixture(t);
  f.c.transaction(() => resetStaffNotificationInterest(f.db));
  f.db.exec('BEGIN IMMEDIATE');
  try {
    const index = createStaffNotificationInterest(
      {
        ...f.c,
        transaction() {
          throw Error('Nested transaction wrapper must not run');
        },
      },
      'telegram',
    );
    assert.deepEqual(index.organizations('', 5), []);
    f.db.exec('COMMIT');
  } catch (error) {
    f.db.exec('ROLLBACK');
    throw error;
  }
});
test('no selected appointment recipients avoids cabinet access even when an old organization page is supplied', () => {
  const replay = createStaffEventReplay({
    platform: { withWriteLock: (fn) => fn() },
    store: {
      organizationPage: () => ({ organizations: ['synthetic-org'], cursor: '' }),
      hasAppointmentRecipients: () => false,
    },
    tenantStore() {
      throw Error('No appointment interest must not open a cabinet');
    },
  });
  replay(undefined, () => true);
  assert.equal(replay.status().error, '');
});
test('selective restore drops only its organization markers and retains the completed bootstrap sentinel', (t) => {
  const f = fixture(t);
  for (const channel of ['telegram', 'max']) {
    f.link(channel, ['moved']);
    const index = f.interests[channel];
    f.c.transaction(() =>
      index.update('synthetic-other-org', 'synthetic-other-account', {
        enabled: true,
        events: ['moved'],
      }),
    );
  }
  const before = f.db
    .prepare('SELECT key FROM telegram_runtime WHERE key LIKE ? ORDER BY key')
    .all('%synthetic-other-org%');
  assert.equal(before.length, 6);
  f.c.transaction(() => resetStaffNotificationInterest(f.db, 'synthetic-org'));
  for (const index of Object.values(f.interests))
    assert.equal(index.hasAppointments('synthetic-org'), false);
  assert.deepEqual(
    f.db
      .prepare('SELECT key FROM telegram_runtime WHERE key LIKE ? ORDER BY key')
      .all('%synthetic-other-org%'),
    before,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM telegram_runtime WHERE key LIKE 'staff-interest-v1:%:ready'")
      .get().n,
    2,
  );
  f.c.transaction(() => resetStaffNotificationInterest(f.db));
  assert.equal(
    f.db
      .prepare("SELECT count(*) n FROM telegram_runtime WHERE key LIKE 'staff-interest-v1:%'")
      .get().n,
    0,
  );
});
test('disabled capture/replay never touches appointment data or the journal, and an active other channel still captures', () => {
  const forbidden = () => {
    throw Error('Disabled audience attempted work');
  };
  const platform = {
    notificationChannels: { enabled: () => false },
    organizationTimeZone: forbidden,
    staffNotifications: { appointmentRecipients: forbidden },
  };
  const storage = { get: forbidden, set: forbidden };
  assert.deepEqual(
    recordStaffAppointmentEvents(platform, 'synthetic-org', storage, null, null),
    [],
  );
  assert.deepEqual(replayStaffAppointmentEvents(platform, 'synthetic-org', storage), []);
  platform.notificationChannels.enabled = (channel) => channel === 'max';
  platform.notificationChannels.version = () => 'synthetic-enabled-epoch';
  platform.organizationTimeZone = () => 'UTC';
  platform.staffMaxNotifications = {
    hasAppointmentRecipients: () => true,
    appointmentRecipients: () => [{ accountId: 'synthetic-owner', bindingId: 'synthetic-binding' }],
  };
  const next = {
    revision: 1,
    patients: [
      {
        id: 'synthetic-patient',
        appointments: [
          {
            id: 'synthetic-appointment',
            staffId: 'synthetic-owner',
            date: '2030-01-01',
            time: '10:00',
            duration: 30,
          },
        ],
      },
    ],
  };
  let staged;
  const captured = recordStaffAppointmentEvents(
    platform,
    'synthetic-org',
    {
      get: () => [],
      set: (_key, value) => {
        staged = value;
      },
    },
    { patients: [] },
    next,
    1000,
  );
  assert.equal(captured.length, 1);
  assert.equal(staged[0].recipients.telegram, undefined);
  assert.equal(staged[0].recipients.max.length, 1);
  assert.deepEqual(staged[0].channelVersions, { max: 'synthetic-enabled-epoch' });
});
test('a configured off/on epoch change acknowledges an old intent without enqueueing it', () => {
  const old = {
    id: 'synthetic-intent',
    audience: 'staff',
    expiresAt: 2000,
    kind: 'moved',
    staffId: 'synthetic-owner',
    reference: {},
    recipients: { telegram: [{ accountId: 'synthetic-owner' }] },
    channelVersions: { telegram: 'before-off' },
  };
  const platform = {
    notificationChannels: {
      enabled: (channel) => channel === 'telegram',
      version: () => 'after-on',
    },
    staffNotifications: {
      hasAppointmentRecipients: () => true,
      enqueueAppointment() {
        throw Error('Old intent must not resurrect');
      },
    },
  };
  assert.deepEqual(
    replayStaffAppointmentEvents(platform, 'synthetic-org', { get: () => [old] }, 1000),
    ['synthetic-intent'],
  );
});
