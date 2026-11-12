const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNotificationCoordinator,
} = require('../src/server/modules/notifications/notification-coordinator.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const { maxFixture } = require('./max-fixture.cjs');
const { migrateNotificationQueue } = require('../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../src/server/migrations/014-notification-channels.cjs');

function fixture({ preselect = true, connected = true, beforeLock = () => {} } = {}) {
  const now = Date.parse('2030-01-01T08:00Z');
  const patients = Array.from({ length: 120 }, (_, n) => ({
    id: 'p' + n,
    appointments: [{ id: 'a' + n, date: '2030-01-01', time: '10:00', duration: 15 }],
  }));
  const state = {
    reads: 0,
    platformLocks: 0,
    tenantLocks: 0,
    active: true,
    connected,
    selected: ['p0'],
    jobs: [],
  };
  const store = {
    organizations: () => ['org'],
    confirmed: () => null,
    transaction(work) {
      state.platformLocks++;
      beforeLock(state);
      return work();
    },
    enqueue(job) {
      state.jobs.push(job);
      return job;
    },
    ...(preselect ? { linkedPatients: () => new Set(state.selected) } : {}),
  };
  const storage = {
    indexes: {
      appointments: () => patients.map((p) => ({ ...p.appointments[0], patientId: p.id })),
    },
    readSelected(ids) {
      state.reads++;
      return { patients: patients.filter((p) => ids.includes(p.id)) };
    },
    transaction(work) {
      state.tenantLocks++;
      return work();
    },
  };
  const coordinator = createNotificationCoordinator({
    platform: {
      organization: () => ({ status: state.active ? 'active' : 'inactive' }),
      subscription: () => ({ status: 'active', limits: { automaticNotifications: true } }),
      telegram: {
        settings: () => ({ enabled: true, timeZone: 'UTC', leadMinutes: 1440 }),
        link: (_, id) => (state.connected && id === 'p0' ? { chatId: '123', linkedAt: 1 } : null),
        delivery: () => null,
        confirmed: () => null,
      },
      appointmentConfirmations: { stamp: (a) => a.id, read: () => null },
    },
    tenantStore: () => storage,
    store,
    links: { link: () => null },
    providers: {
      telegram: { status: () => ({ configured: true, connected: true, botId: '321' }) },
    },
    clock: () => now,
  });
  return { coordinator, state, store };
}

test('one linked client among120 candidates needs two fresh reads and only one enqueue transaction', () => {
  const f = fixture();
  assert.equal(f.coordinator.schedule(), true);
  assert.equal(f.state.reads, 2, 'preselection must not decrypt119 unlinked full patient cards');
  assert.equal(f.state.platformLocks, 1);
  assert.equal(f.state.tenantLocks, 1);
  assert.deepEqual(
    f.state.jobs.map((job) => [job.patient, job.channel]),
    [['p0', 'telegram']],
  );
});

test('no available channel skips platform/cabinet write locks even without optional preselection', () => {
  const f = fixture({ preselect: false, connected: false });
  f.coordinator.schedule();
  assert.equal(f.state.reads, 120, 'compatibility fallback still checks each candidate once');
  assert.equal(f.state.platformLocks, 0);
  assert.equal(f.state.tenantLocks, 0);
});

test('candidate snapshot is not permission: unlink and revoked organization block enqueue', () => {
  const unlinked = fixture({ connected: false });
  unlinked.coordinator.schedule();
  assert.equal(unlinked.state.reads, 1);
  assert.equal(unlinked.state.platformLocks, 0);
  assert.equal(unlinked.state.jobs.length, 0);
  const revoked = fixture({
    beforeLock: (state) => {
      state.active = false;
    },
  });
  revoked.coordinator.schedule();
  assert.equal(
    revoked.state.platformLocks,
    1,
    'fresh authorization is still inside platform/cabinet locks',
  );
  assert.equal(revoked.state.jobs.length, 0);
});

test('newly linked candidate enters next pass; manual reminder does not use scan preselection', () => {
  const f = fixture();
  f.state.selected = [];
  f.coordinator.schedule();
  assert.equal(f.state.reads, 0);
  f.coordinator.remind('org', 'p0', 'a0');
  assert.equal(f.state.jobs.length, 1);
  f.state.selected = ['p0'];
  f.coordinator.schedule();
  assert.equal(f.state.jobs.length, 2);
});

test('linked candidate query is bounded, organization-scoped, reuses SQL, and reads no encrypted binding', (t) => {
  const f = maxFixture(t);
  migrateNotificationQueue(f.database, f.directory);
  migrateNotificationChannels(f.database, f.directory);
  const { db, seal } = f.database;
  for (const [table, org, patient] of [
    ['telegram_links', 'org', 'p0'],
    ['max_client_links', 'org', 'p449'],
    ['telegram_links', 'other-org', 'p1'],
    ['max_client_links', 'org', 'p0'],
  ])
    db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`).run(
      org,
      patient,
      table + org + patient,
      seal({ synthetic: true }),
    );
  let calls = 0,
    prepares = 0;
  const original = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql) => {
    const statement = original(sql);
    if (sql.includes('request_scope') && sql.includes('telegram_links')) {
      prepares++;
      return {
        all(...args) {
          calls++;
          assert.ok(JSON.parse(args[1]).length <= 200);
          return statement.all(...args);
        },
      };
    }
    return statement;
  });
  const store = createNotificationStore({
    ...f.database,
    open: () => assert.fail('Preselection must not decrypt bindings'),
  });
  const ids = Array.from({ length: 450 }, (_, n) => 'p' + n);
  assert.deepEqual([...store.linkedPatients('org', [...ids, ...ids])].sort(), ['p0', 'p449']);
  assert.equal(calls, 3);
  assert.deepEqual([...store.linkedPatients('other-org', ids)], ['p1']);
  assert.equal(calls, 6);
  assert.equal(prepares, 1);
  assert.equal(store.linkedPatients('org', []).size, 0);
  assert.equal(calls, 6);
});

test('one cold bootstrap of 1000 disabled organizations leaves repeated interest checks without settings decryption', (t) => {
  const f = maxFixture(t),
    {
      createClientNotificationInterest,
    } = require('../src/server/modules/notifications/client-notification-interest.cjs'),
    { db, seal } = f.database;
  f.database.transaction(() => {
    const organization = db.prepare(
        'INSERT INTO organizations(id,value,slug,status,created_at) VALUES(?,?,?,?,?)',
      ),
      settings = db.prepare('INSERT INTO telegram_settings VALUES(?,?)'),
      link = db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?)');
    for (let index = 0; index < 1000; index++) {
      const org = 'synthetic-off-' + String(index).padStart(4, '0');
      organization.run(org, seal({ name: 'Synthetic' }), org, 'active', f.now);
      settings.run(org, seal({ events: [] }));
      link.run(org, 'p', org, seal({ chatId: '456', linkedAt: 1 }));
    }
  });
  let opens = 0;
  const interest = createClientNotificationInterest({
    ...f.database,
    open(value) {
      opens++;
      return f.database.open(value);
    },
  });
  assert.equal(interest.has('', ['telegram'], 'all'), false);
  assert.equal(opens, 1000);
  for (let pass = 0; pass < 5; pass++) {
    assert.equal(interest.has('', ['telegram'], 'reminder'), false);
    assert.deepEqual(interest.batch('', 25, ['telegram'], 'all'), []);
  }
  assert.equal(opens, 1000, 'queue polling must not decrypt the disabled organizations again');
  f.database.transaction(() => {
    db.prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?').run(
      seal({ events: ['created'] }),
      'synthetic-off-0007',
    );
    interest.touch('synthetic-off-0007');
  });
  assert.deepEqual(interest.organizations(['telegram'], 'lifecycle'), ['synthetic-off-0007']);
  assert.equal(interest.has('', ['telegram'], 'reminder'), false);
});

test('managed global-off skips even interest bootstrap and default first TG/MAX bindings become indexed after it', (t) => {
  const f = maxFixture(t),
    {
      createClientNotificationInterest,
    } = require('../src/server/modules/notifications/client-notification-interest.cjs');
  let enabled = false;
  const interest = createClientNotificationInterest({
    ...f.database,
    notificationChannels: { enabled: () => enabled },
    open: () => assert.fail('No settings exist; no encrypted reads are needed'),
  });
  assert.equal(interest.has('', ['telegram', 'max'], 'all'), false);
  assert.equal(
    f.database.db
      .prepare("SELECT 1 FROM telegram_runtime WHERE key='client-interest-v1:ready'")
      .get(),
    undefined,
  );
  enabled = true;
  assert.deepEqual(interest.organizations(['telegram', 'max']), []);
  const telegram = f.platform.telegram.issueLink('org', 'p', 'owner', f.now);
  f.platform.telegram.consumeLink(telegram, '456', () => true, f.now);
  assert.deepEqual(interest.organizations(['telegram'], 'reminder'), ['org']);
  f.platform.telegram.unlink('org', 'p');
  const max = f.links.issue('other-org', 'p', 'outsider', '123', () => {}, f.now);
  f.links.consume(max.token, '123', '789', () => {}, f.now);
  assert.deepEqual(interest.organizations(['max'], 'reminder'), ['other-org']);
});
