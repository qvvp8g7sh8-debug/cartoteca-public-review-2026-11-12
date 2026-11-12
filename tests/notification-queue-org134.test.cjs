const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createOrganizationClaims,
} = require('../src/server/modules/notifications/queue-org134.cjs');
const { createPushActivity } = require('../src/server/modules/notifications/push-activity.cjs');
const busy = () =>
  Object.assign(Error('Synthetic clean admission contention'), {
    code: 'ERR_SQLITE_ERROR',
    postgresCode: 'POSTGRES_BUSY',
    retryableBeforeBegin: true,
    transactionOpen: false,
    outcomeUnknown: false,
    channelPoisoned: false,
  });
const rows = Array.from({ length: 9 }, (_, index) => ({
  organization_id: 'org-' + index,
  id: 'job-' + index,
  next_at: index + 1,
}));
function select(omitted, cursor) {
  return rows.find(
    (row) =>
      !omitted.includes(row.organization_id) &&
      (row.next_at > cursor.nextAt || (row.next_at === cursor.nextAt && row.id > cursor.id)),
  );
}
test('eight contended organization heads cannot starve the ninth across bounded claim turns', () => {
  const admitted = [],
    callbacks = [];
  const c = {
    db: { isTransaction: false },
    organizationQueueTransaction(work, scope) {
      admitted.push(scope.organizationId);
      if (scope.organizationId !== 'org-8') throw busy();
      return work();
    },
  };
  const claim = createOrganizationClaims(c, 'push');
  const take = (org) => {
    callbacks.push(org);
    return { organization_id: org };
  };
  assert.equal(claim(select, take), null);
  assert.equal(admitted.length, 8);
  assert.deepEqual(callbacks, []);
  assert.deepEqual(claim(select, take), { organization_id: 'org-8' });
  assert.deepEqual(callbacks, ['org-8']);
  assert.equal(admitted.at(-1), 'org-8');
});
test('a callback failure cannot be disguised as clean admission or skip to another organization', () => {
  let entered = 0,
    selected = 0;
  const c = { db: { isTransaction: false }, organizationQueueTransaction: (work) => work() };
  const claim = createOrganizationClaims(c, 'telegram');
  assert.throws(() =>
    claim(
      (...args) => {
        selected++;
        return select(...args);
      },
      () => {
        entered++;
        throw busy();
      },
    ),
  );
  assert.equal(entered, 1);
  assert.equal(selected, 1);
});
test('an unknown commit never retries its callback or admits a second organization', () => {
  let entered = 0,
    admitted = 0;
  const c = {
    db: { isTransaction: false },
    organizationQueueTransaction(work) {
      admitted++;
      work();
      throw Object.assign(Error('Synthetic unknown commit'), { outcomeUnknown: true });
    },
  };
  const claim = createOrganizationClaims(c, 'client');
  assert.throws(
    () =>
      claim(select, () => {
        entered++;
        return null;
      }),
    (error) => error.outcomeUnknown === true,
  );
  assert.equal(entered, 1);
  assert.equal(admitted, 1);
});
test('first queue-owned Push interest lookup reads current organization devices without global marker writes', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB);
    CREATE TABLE staff_push_devices(id TEXT PRIMARY KEY,organization_id TEXT,account_id TEXT,value BLOB);
    CREATE TABLE staff_push_jobs(status TEXT,next_at INTEGER,lease_until INTEGER,expires_at INTEGER,event_key TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,status TEXT,role TEXT);
    CREATE TABLE accounts(id TEXT PRIMARY KEY,status TEXT);`);
  db.prepare('INSERT INTO organizations VALUES(?,?)').run('org', 'active');
  db.prepare('INSERT INTO accounts VALUES(?,?)').run('account', 'active');
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('org', 'account', 'active', 'owner');
  const seal = (value) => Buffer.from(JSON.stringify(value));
  db.prepare('INSERT INTO staff_push_devices VALUES(?,?,?,?)').run(
    'device',
    'org',
    'account',
    seal({ enabled: true, preferences: { events: ['created'] } }),
  );
  let writes = 0,
    transactions = 0;
  const observed = new Proxy(db, {
    get(target, name) {
      if (name === 'dialect') return 'postgres';
      if (name === 'revisionProfile') return 3;
      if (name === 'transactionIntent') return 'QUEUEORG';
      if (name === 'snapshotVersion') return () => '1:2:';
      if (name === 'localMutationClock') return 0;
      if (name === 'prepare')
        return (sql) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(inner, field) {
              const value = Reflect.get(inner, field, inner);
              if (field === 'run')
                return (...args) => {
                  writes++;
                  return value.apply(inner, args);
                };
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const activity = createPushActivity({
    db: observed,
    seal,
    open: (value) => JSON.parse(Buffer.from(value).toString('utf8')),
    transaction() {
      transactions++;
      throw Error('A queue lookup must not build global interest markers');
    },
    notificationChannels: { enabled: () => true, version: () => 'synthetic' },
  });
  assert.equal(activity.hasEnabledEvents('org', 'change'), true);
  assert.equal(activity.hasEnabledEvents('foreign', 'change'), false);
  db.prepare("UPDATE memberships SET status='revoked' WHERE organization_id='org'").run();
  assert.equal(activity.hasEnabledEvents('org', 'change'), false);
  assert.equal(db.prepare('SELECT count(*) n FROM telegram_runtime').get().n, 0);
  assert.equal(writes, 0);
  assert.equal(transactions, 0);
});

const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const {
  createStaffTelegramRuntime,
} = require('../src/server/modules/notifications/staff-runtime.cjs');
const {
  createStaffMaxRuntime,
} = require('../src/server/modules/notifications/staff-max-runtime.cjs');
const {
  createNotificationWorker,
} = require('../src/server/modules/notifications/notification-worker.cjs');
for (const flag of ['outcomeUnknown', 'channelPoisoned']) {
  test(`Push does not start a provider or refund a lease after ${flag} during delivery commit`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const error = Object.assign(Error('Synthetic uncertain delivery commit'), { [flag]: true });
    let claims = 0,
      sends = 0,
      settlements = 0,
      callbacks = 0;
    const store = {
      hasEnabledEvents: () => false,
      hasPendingTests: () => true,
      claim: () =>
        claims++
          ? null
          : {
              id: 'job',
              organization_id: 'org',
              account_id: 'account',
              event_key: 'test',
              expires_at: 100000,
              decoded: { event: 'test', reference: {} },
            },
      valid: () => ({ decoded: { subscription: {} } }),
      deliveryFor(_job, work) {
        callbacks++;
        work();
        throw error;
      },
      finish() {
        settlements++;
      },
      deferUnstarted() {
        settlements++;
      },
    };
    const runtime = createPushRuntime({
      platform: { staffPush: store },
      tenantStore: () => assert.fail('No cabinet needed'),
      origin: 'https://synthetic.invalid',
      enabled: true,
      clock: () => 1000,
      send() {
        sends++;
      },
    });
    runtime.start();
    try {
      await assert.rejects(runtime.tick(1), (value) => value === error);
    } finally {
      runtime.stop();
    }
    assert.equal(callbacks, 1);
    assert.equal(sends, 0);
    assert.equal(settlements, 0);
  });
  for (const channel of ['telegram', 'max'])
    test(`staff ${channel} never retries/refunds an unknown ${flag} pre-send transaction`, async () => {
      const error = Object.assign(Error('Synthetic uncertain staff commit'), { [flag]: true });
      let sends = 0,
        settlements = 0,
        callbacks = 0;
      const store = {
        claim: () => ({ id: 'job', organization_id: 'org', decoded: { chatId: '123:456' } }),
        valid: () => true,
        deliveryFor(_job, work) {
          callbacks++;
          work();
          throw error;
        },
        finish() {
          settlements++;
        },
      };
      const platform = { staffNotifications: store, notificationChannels: { enabled: () => true } };
      const common = {
        platform,
        tenantStore: () => assert.fail('No cabinet needed'),
        store,
        bot: {
          send() {
            sends++;
          },
        },
        identity: { botId: '123' },
        pacing: {},
      };
      const runtime =
        channel === 'telegram' ? createStaffTelegramRuntime(common) : createStaffMaxRuntime(common);
      await assert.rejects(
        runtime.tickManaged(null, () => true, 1),
        (value) => value === error,
      );
      assert.equal(callbacks, 1);
      assert.equal(sends, 0);
      assert.equal(settlements, 0);
    });
  test(`client ${flag} after reserved-to-sending prevents provider start and further transitions`, async () => {
    const error = Object.assign(Error('Synthetic uncertain client transition commit'), {
      [flag]: true,
    });
    let callbacks = 0,
      sends = 0,
      released = 0;
    const transitions = [];
    const store = {
      claim: () => ({
        id: 'job',
        organization_id: 'org',
        lease_until: 10000,
        decoded: { channel: 'telegram', recipient: {} },
      }),
      deliveryFor(_job, work) {
        const result = work();
        if (++callbacks === 2) throw error;
        return result;
      },
      transition(_job, from, to) {
        transitions.push([from, to]);
        return true;
      },
    };
    const worker = createNotificationWorker({
      platform: {
        telegram: {
          link: () => ({}),
          messageIdentity: () => ({ organization: { name: 'Synthetic' } }),
        },
        organization: () => ({ phone: '' }),
      },
      tenantStore: () => ({ transaction: (work) => work() }),
      store,
      policy: {
        readyChannels: () => ['telegram'],
        valid: () => ({
          a: { date: '2030-01-01', time: '15:00', duration: 30 },
          settings: { showServices: false },
        }),
      },
      providers: {
        telegram: {
          status: () => ({ configured: true, connected: true }),
          acquire: async () => true,
          release() {
            released++;
          },
          send() {
            sends++;
          },
        },
      },
      clock: () => 1000,
    });
    await assert.rejects(worker.tick(null), (value) => value === error);
    assert.equal(callbacks, 2);
    assert.equal(sends, 0);
    assert.equal(released, 1);
    assert.deepEqual(transitions, [['reserved', 'sending']]);
  });
}

const {
  createClientNotificationInterest,
} = require('../src/server/modules/notifications/client-notification-interest.cjs');
for (const intent of ['COMPOUND', 'QUEUEORG'])
  test(`${intent} client interest without a sentinel uses current own settings/bindings without global writes`, (t) => {
    const native = new DatabaseSync(':memory:');
    t.after(() => native.close());
    native.exec(`CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB);
      CREATE TABLE telegram_settings(organization_id TEXT PRIMARY KEY,value BLOB);
      CREATE TABLE telegram_links(organization_id TEXT,patient_id TEXT);
      CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);`);
    const seal = (value) => Buffer.from(JSON.stringify(value));
    native.prepare('INSERT INTO organizations VALUES(?,?)').run('org', 'active');
    native
      .prepare('INSERT INTO telegram_settings VALUES(?,?)')
      .run('org', seal({ events: ['reminder'] }));
    native.prepare('INSERT INTO telegram_links VALUES(?,?)').run('org', 'patient');
    let writes = 0,
      transactions = 0,
      channel = true;
    const db = new Proxy(native, {
      get(target, field) {
        if (field === 'transactionIntent') return intent;
        if (field === 'isTransaction') return true;
        if (field === 'prepare')
          return (sql) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(inner, key) {
                const value = Reflect.get(inner, key, inner);
                if (key === 'run')
                  return (...args) => {
                    writes++;
                    return value.apply(inner, args);
                  };
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          };
        const value = Reflect.get(target, field, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const interest = createClientNotificationInterest({
      db,
      seal,
      open: (value) => JSON.parse(Buffer.from(value).toString()),
      transaction() {
        transactions++;
        assert.fail('Owned lookup must not build the global projection');
      },
      notificationChannels: { enabled: () => channel },
    });
    assert.equal(interest.has('org'), true);
    assert.equal(interest.has('foreign'), false);
    assert.equal(interest.has('org', ['telegram'], 'lifecycle'), false);
    native.prepare('UPDATE telegram_settings SET value=?').run(seal({ restoredPaused: true }));
    assert.equal(interest.has('org'), false);
    native.prepare('UPDATE telegram_settings SET value=?').run(seal({ events: ['reminder'] }));
    native.prepare('DELETE FROM telegram_links').run();
    assert.equal(interest.has('org'), false);
    native.prepare('INSERT INTO telegram_links VALUES(?,?)').run('org', 'patient');
    native.prepare("UPDATE organizations SET status='suspended'").run();
    assert.equal(interest.has('org'), false);
    native.prepare("UPDATE organizations SET status='active'").run();
    channel = false;
    assert.equal(interest.has('org'), false);
    assert.equal(native.prepare('SELECT count(*) n FROM telegram_runtime').get().n, 0);
    assert.equal(writes, 0);
    assert.equal(transactions, 0);
  });
function clientPayloadFixture({ failure = '', stopAfterCommit = false } = {}) {
  const state = {
    status: 'reserved',
    inside: 0,
    deliveries: 0,
    sends: 0,
    active: true,
    transitions: [],
    reads: [],
  };
  const syntheticError = Error('Synthetic ' + failure + ' payload failure');
  const owned = (work) => {
    const before = state.status;
    state.inside++;
    try {
      return work();
    } catch (error) {
      state.status = before;
      throw error;
    } finally {
      state.inside--;
    }
  };
  const read = (kind) => {
    assert.ok(state.inside > 0, kind + ' must stay in owned delivery snapshot');
    state.reads.push(kind);
  };
  const appointment = { date: '2030-01-01', time: '15:00', duration: 30, staffId: 'staff' };
  if (failure === 'formatter')
    Object.defineProperty(appointment, 'date', {
      get() {
        throw syntheticError;
      },
    });
  let claimed = false;
  const job = {
    id: 'job',
    organization_id: 'org',
    patient_id: 'patient',
    lease_until: 10000,
    decoded: {
      channel: 'telegram',
      kind: 'reminder',
      recipient: { chatId: 'chat' },
      callback: 'callback',
    },
  };
  const store = {
    deliveryReadMode: 'DEFERRED',
    claim: () => {
      if (claimed) return null;
      claimed = true;
      return job;
    },
    deliveryFor(_job, work) {
      const result = owned(work);
      if (++state.deliveries === 2 && stopAfterCommit) state.active = false;
      return result;
    },
    transition(_job, from, to) {
      const change = () => {
        assert.ok(state.inside > 0);
        if (state.status !== from) return false;
        state.transitions.push([from, to]);
        state.status = to;
        return true;
      };
      return state.inside ? change() : owned(change);
    },
  };
  const platform = {
    telegram: {
      link() {
        read('link');
        if (failure === 'read') throw syntheticError;
        return { servicesConsent: true };
      },
      messageIdentity() {
        read('identity');
        return { organization: { name: 'Synthetic clinic' } };
      },
    },
    organization() {
      read('organization');
      return { phone: '89181111111' };
    },
  };
  const worker = createNotificationWorker({
    platform,
    store,
    tenantStore: () => ({
      transaction(work, mode) {
        assert.equal(mode, 'DEFERRED');
        assert.ok(state.inside > 0);
        return work();
      },
    }),
    policy: {
      readyChannels: () => ['telegram'],
      valid: () => ({ a: appointment, settings: { showServices: true } }),
    },
    providers: {
      telegram: {
        status: () => ({ configured: true, connected: true }),
        acquire: async () => true,
        send(payload) {
          assert.equal(state.inside, 0, 'provider must start after commit');
          assert.equal(state.status, 'sending');
          assert.match(payload.text, /15:00/);
          assert.equal(payload.contactUrl, 'https://wa.me/79181111111');
          state.sends++;
          return Promise.resolve({ message_id: 1 });
        },
      },
    },
    clock: () => 1000,
  });
  return { worker, state };
}
for (const failure of ['read', 'formatter'])
  test(`client ${failure} preparation failure commits no sending state or POST and restores pending`, async () => {
    const { worker, state } = clientPayloadFixture({ failure });
    await worker.tick(null);
    assert.equal(state.sends, 0);
    assert.equal(state.status, 'pending');
    assert.deepEqual(state.transitions, [['reserved', 'pending']]);
    assert.equal(state.inside, 0);
  });
test('client known committed sending lease is returned to pending when ownership stops before POST', async () => {
  const { worker, state } = clientPayloadFixture({ stopAfterCommit: true });
  await worker.tick(null, () => state.active);
  assert.equal(state.sends, 0);
  assert.equal(state.status, 'pending');
  assert.deepEqual(state.transitions, [
    ['reserved', 'sending'],
    ['sending', 'pending'],
  ]);
});
test('client payload reads/formatting stay owned and the injected provider starts after sending commit', async () => {
  const { worker, state } = clientPayloadFixture();
  await worker.tick(null);
  assert.equal(state.sends, 1);
  assert.equal(state.status, 'sent');
  assert.deepEqual(state.reads, ['link', 'identity', 'organization']);
  assert.deepEqual(state.transitions, [
    ['reserved', 'sending'],
    ['sending', 'sent'],
  ]);
});
