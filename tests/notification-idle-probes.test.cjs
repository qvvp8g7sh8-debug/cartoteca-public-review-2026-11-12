const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createNotificationWorker,
} = require('../src/server/modules/notifications/notification-worker.cjs');
const {
  createStaffQueueWork,
} = require('../src/server/modules/notifications/staff-queue-work.cjs');
const {
  createStaffEventReplay,
} = require('../src/server/modules/notifications/staff-event-replay.cjs');
const { createMaxRuntime } = require('../src/server/modules/notifications/max-runtime.cjs');
const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function workerFixture() {
  let now = 100000,
    enabled = true,
    valid = true;
  const counts = { hints: 0, policy: 0, recipients: 0, claims: 0, sends: 0 };
  const activity = createQueueActivity({}, 'fixture');
  const jobs = [],
    gates = new Map();
  const providers = Object.fromEntries(
    ['telegram', 'max'].map((channel) => [
      channel,
      {
        status: () => ({ configured: true, connected: true }),
        acquire: async () => true,
        send: async () => {
          counts.sends++;
          if (gates.has(channel)) await gates.get(channel).promise;
          return {};
        },
      },
    ]),
  );
  const store = {
    subscribePending: activity.subscribe,
    transaction: (work) => work(),
    hasPendingWork(at, channels) {
      counts.hints++;
      return jobs.some(
        (j) => j.status === 'pending' && j.next_at <= at && channels.includes(j.decoded.channel),
      );
    },
    hasNotificationRecipients() {
      counts.recipients++;
      return true;
    },
    claim(at, channels) {
      counts.claims++;
      const job = jobs.find(
        (j) => j.status === 'pending' && j.next_at <= at && channels.includes(j.decoded.channel),
      );
      if (job) job.status = 'reserved';
      return job || null;
    },
    transition(job, from, to, nextAt = 0) {
      if (job.status !== from) return false;
      job.status = to;
      job.next_at = nextAt;
      return true;
    },
  };
  const worker = createNotificationWorker({
    platform: {
      telegram: {
        link: () => null,
        messageIdentity: () => ({ organization: { name: 'Synthetic' } }),
      },
      organization: () => ({ phone: '' }),
    },
    tenantStore: () => ({ transaction: (work) => work() }),
    store,
    providers,
    clock: () => now,
    policy: {
      readyChannels() {
        counts.policy++;
        return enabled ? ['telegram', 'max'] : [];
      },
      valid: () =>
        valid
          ? {
              a: { date: '2099-01-01', time: '10:00', duration: 60 },
              settings: { showServices: false },
            }
          : null,
    },
  });
  function add(channel = 'telegram', nextAt = now) {
    const job = {
      id: String(jobs.length),
      organization_id: 'synthetic',
      patient_id: 'p',
      status: 'pending',
      next_at: nextAt,
      lease_until: now + 120000,
      decoded: { channel, kind: 'reminder', callback: 'synthetic', recipient: {} },
    };
    jobs.push(job);
    activity.notify();
    return job;
  }
  return {
    worker,
    store,
    providers,
    counts,
    add,
    gates,
    advance: (ms) => {
      now += ms;
    },
    enabled: (value) => {
      enabled = value;
    },
    valid: (value) => {
      valid = value;
    },
  };
}
test('fresh empty/future hints avoid authority work; a newly due job starts on the next unchanged tick', async () => {
  const f = workerFixture();
  for (let n = 0; n < 40; n++) await f.worker.tick();
  assert.deepEqual(f.counts, { hints: 40, policy: 0, recipients: 0, claims: 0, sends: 0 });
  const job = f.add('telegram', 101000);
  await f.worker.tickManaged();
  assert.equal(f.counts.policy, 0);
  f.advance(1000);
  await f.worker.tickManaged();
  assert.equal(job.status, 'sent');
  assert.equal(f.counts.sends, 1);
});
test('a positive hint never authorizes disabled channels, revoked access or an uncertain send replay', async () => {
  const f = workerFixture(),
    job = f.add();
  f.enabled(false);
  await f.worker.tickManaged();
  assert.equal(job.status, 'pending');
  assert.equal(f.counts.claims, 0);
  f.enabled(true);
  f.advance(5000);
  f.valid(false);
  await f.worker.tickManaged();
  assert.equal(job.status, 'cancelled');
  assert.equal(f.counts.sends, 0);
  const uncertain = f.add();
  f.advance(5000);
  f.valid(true);
  f.providers.telegram.send = async () => {
    f.counts.sends++;
    throw Error('Synthetic provider outcome unknown');
  };
  await f.worker.tickManaged();
  assert.equal(uncertain.status, 'uncertain');
  await f.worker.tickManaged();
  assert.equal(f.counts.sends, 1);
});
test('authorization is reread after pacing even with a previously positive hint', async () => {
  const f = workerFixture(),
    gate = deferred(),
    job = f.add();
  f.providers.telegram.acquire = () => gate.promise;
  const pending = f.worker.tickManaged();
  await turn();
  f.valid(false);
  gate.resolve(true);
  await pending;
  assert.equal(job.status, 'cancelled');
  assert.equal(f.counts.sends, 0);
});
test('occupied provider lanes cause no further discovery SQL and do not block a free sibling', async () => {
  const f = workerFixture();
  f.add('telegram');
  f.add('max');
  for (const channel of ['telegram', 'max']) f.gates.set(channel, deferred());
  const pending = f.worker.tickManaged();
  await turn();
  const before = { ...f.counts };
  for (let n = 0; n < 40; n++) await f.worker.tickManaged();
  assert.deepEqual(f.counts, before);
  f.gates.get('max').resolve();
  await turn();
  f.add('max');
  await turn();
  await f.worker.tickManaged();
  assert.equal(f.counts.sends, 3);
  f.gates.get('telegram').resolve();
  await pending;
});
test('staff empty heads use one indexed read without channel epochs/recipient probes, but positives remain fresh', (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(
    'CREATE TABLE staff_notification_jobs(id TEXT,status TEXT,next_at INTEGER,lease_until INTEGER,expires_at INTEGER); CREATE INDEX due ON staff_notification_jobs(status,next_at); CREATE TABLE telegram_runtime(key TEXT,value BLOB);',
  );
  let reads = 0,
    epochs = 0,
    recipients = 0,
    enabled = true;
  const c = {
    db: {
      isTransaction: false,
      prepare(sql) {
        const s = raw.prepare(sql);
        return {
          get(...a) {
            reads++;
            return s.get(...a);
          },
        };
      },
    },
    notificationChannels: {
      enabled() {
        epochs++;
        return enabled;
      },
    },
  };
  const work = createStaffQueueWork(
    c,
    {
      interest: {
        hasEnabledRecipients() {
          recipients++;
          return true;
        },
      },
    },
    'telegram',
  );
  for (let n = 0; n < 40; n++) assert.equal(work.hasPendingWork(1000), false);
  assert.deepEqual({ reads, epochs, recipients }, { reads: 40, epochs: 0, recipients: 0 });
  raw
    .prepare('INSERT INTO staff_notification_jobs VALUES(?,?,?,?,?)')
    .run('future', 'pending', 2000, 0, 3000);
  assert.equal(work.hasPendingWork(1999), false);
  assert.equal(epochs, 0);
  enabled = false;
  assert.equal(work.hasPendingWork(2000), false);
  enabled = true;
  assert.equal(work.hasPendingWork(2000), true);
  raw.exec("UPDATE staff_notification_jobs SET status='sending',lease_until=2100");
  assert.equal(work.hasPendingWork(2099), false);
  assert.equal(work.hasPendingWork(2100), true);
});
test('staff replay interval gates authority reads while the durable fallback remains every 15 seconds', async () => {
  let now = 1000,
    epochs = 0,
    discoveries = 0;
  const replay = createStaffEventReplay({
    platform: {
      notificationChannels: {
        enabled() {
          epochs++;
          return true;
        },
      },
      withWriteLock() {},
    },
    tenantStore() {
      assert.fail('empty discovery has no cabinet');
    },
    store: {
      organizationPage() {
        discoveries++;
        return { cursor: '', organizations: [] };
      },
    },
    clock: () => now,
  });
  await replay.batched();
  const before = epochs;
  for (let n = 0; n < 40; n++) {
    now += 250;
    await replay.batched();
  }
  assert.equal(epochs, before);
  assert.equal(discoveries, 1);
  now = 16000;
  await replay.batched();
  assert.equal(discoveries, 2);
});
test('MAX empty inbox avoids durable lease reads; positive stale hints still verify ownership', async () => {
  let due = false,
    current = true,
    reads = 0,
    hints = 0,
    claims = 0,
    now = 1000;
  const inbox = {
    acquire: () => true,
    renew: () => true,
    release() {},
    isCurrent() {
      reads++;
      return current;
    },
    hasPendingWork() {
      hints++;
      return due;
    },
    claim() {
      claims++;
      return null;
    },
  };
  const runtime = createMaxRuntime({
    inbox,
    events: { process() {} },
    bot: {},
    identity: { botId: '123' },
    clock: () => now,
    monotonicClock: () => now,
  });
  for (let n = 0; n < 40; n++) {
    await runtime.tick();
    now += 500;
  }
  assert.equal(hints, 40);
  assert.equal(reads, 0);
  assert.equal(claims, 0);
  due = true;
  current = false;
  await runtime.tick();
  assert.equal(reads, 1);
  assert.equal(claims, 0);
  runtime.stop();
});

const {
  createQueueIdleProbe,
  createQueueNextDue,
} = require('../src/server/modules/notifications/queue-idle-probe.cjs');
const { createQueueActivity } = require('../src/server/modules/notifications/queue-activity.cjs');
test('outbound idle probes back off to five seconds, known due alarms shorten waits, clock rollback resets', () => {
  let now = 1000,
    probes = 0,
    lastProbe = null;
  const idle = createQueueIdleProbe({ clock: () => now });
  for (let n = 0; n < 80; n++, now += 250) {
    if (!idle.ready()) continue;
    if (lastProbe !== null) assert.ok(now - lastProbe <= 5000);
    lastProbe = now;
    probes++;
    idle.empty();
  }
  assert.ok(probes <= 9, 'eighty former idle ticks must not make eighty SQL probes');
  now += 1;
  idle.ready();
  idle.empty(now + 500);
  assert.equal(idle.ready(), false);
  now += 500;
  assert.equal(idle.ready(), true);
  idle.empty();
  now -= 10000;
  assert.equal(idle.ready(), true);
  idle.close();
});
test('local wakes coalesce after commit/rollback, cannot throw, and cannot cross unsubscribe/reopen generations', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs(id TEXT)');
  const activity = createQueueActivity(db, 'test');
  let now = 1000,
    wakes = 0;
  const observations = [];
  const idle = createQueueIdleProbe({ clock: () => now, subscribe: activity.subscribe });
  idle.ready();
  idle.empty();
  assert.equal(idle.ready(), false);
  const detach = activity.subscribe(() => {
    wakes++;
    observations.push(db.prepare('SELECT count(*) n FROM jobs').get().n);
  });
  activity.subscribe(() => {
    throw Error('Advisory listener failure');
  });
  db.exec('BEGIN');
  db.prepare('INSERT INTO jobs VALUES(?)').run('committed');
  for (let n = 0; n < 40; n++) activity.notify();
  assert.equal(wakes, 0);
  assert.equal(idle.ready(), false);
  db.exec('COMMIT');
  await turn();
  assert.equal(wakes, 1);
  assert.deepEqual(observations, [1]);
  assert.equal(idle.ready(), true);
  idle.empty();
  db.exec('BEGIN');
  db.prepare('INSERT INTO jobs VALUES(?)').run('rolled-back');
  activity.notify();
  db.exec('ROLLBACK');
  await turn();
  assert.deepEqual(observations, [1, 1]);
  assert.equal(idle.ready(), true, 'rollback only causes a fresh negative probe');
  idle.empty();
  activity.notify();
  idle.close();
  detach();
  idle.ready();
  idle.empty();
  await turn();
  assert.equal(idle.ready(), false, 'old queued wake cannot reopen the next generation');
  idle.close();
});
test('next-due scheduling cannot hide an earlier reserved/sending recovery behind a future pending row', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE notification_channel_jobs(status TEXT,next_at INTEGER,lease_until INTEGER);CREATE INDEX due ON notification_channel_jobs(status,next_at)',
  );
  const insert = db.prepare('INSERT INTO notification_channel_jobs VALUES(?,?,?)');
  insert.run('pending', 9000, 0);
  insert.run('reserved', 0, 3000);
  insert.run('sending', 0, 2000);
  const next = createQueueNextDue(db, 'notification_channel_jobs');
  assert.equal(next(1000), 2000);
  assert.equal(next(2000), 3000);
  assert.equal(next(3000), 9000);
  assert.equal(next(9000), null);
});

test('an enqueue wake during queued admission cannot be overwritten by that stale empty result', async () => {
  const activity = createQueueActivity({}, 'queued-admission'),
    admission = deferred();
  let now = 1000;
  const idle = createQueueIdleProbe({ clock: () => now, subscribe: activity.subscribe });
  assert.equal(idle.ready(), true);
  const oldProbe = admission.promise.then(() => idle.empty());
  activity.notify();
  await turn();
  admission.resolve();
  await oldProbe;
  assert.equal(idle.ready(), true, 'wake survives the earlier claim returning empty');
  idle.empty();
  assert.equal(idle.ready(), false);
  now += 250;
  assert.equal(idle.ready(), true);
  idle.close();
});

test('late empty completion from a closed generation cannot delay or reopen the restarted probe', async () => {
  const gate = deferred();
  let now = 1000;
  const idle = createQueueIdleProbe({ clock: () => now });
  idle.ready();
  const old = idle.capture();
  const completion = gate.promise.then(() => idle.empty(null, old));
  idle.close();
  assert.equal(idle.ready(), true);
  gate.resolve();
  await completion;
  assert.equal(idle.ready(), true);
  idle.close();
});

for (const channel of ['telegram', 'max'])
  test(`stopped ${channel} replay continuation cannot resubscribe or query a queue`, async () => {
    const pending = deferred(),
      controller = new AbortController();
    let heads = 0,
      subscriptions = 0;
    const store = {
      organizationPage: () => ({ cursor: '', organizations: [] }),
      hasPendingWork() {
        heads++;
        return false;
      },
      subscribePending() {
        subscriptions++;
        return () => {};
      },
    };
    const platform = {
      staffNotifications: store,
      notificationChannels: { enabled: () => true },
      withWriteLock() {},
    };
    const tenantStore = () => assert.fail('empty replay cannot open clinical state');
    const options = {
      platform,
      tenantStore,
      store,
      bot: {},
      identity: { botId: '123' },
      clock: () => 1000,
      runBackgroundWork: () => pending.promise,
    };
    const runtime =
      channel === 'telegram'
        ? require('../src/server/modules/notifications/staff-runtime.cjs').createStaffTelegramRuntime(
            options,
          )
        : require('../src/server/modules/notifications/staff-max-runtime.cjs').createStaffMaxRuntime(
            options,
          );
    const task = runtime.tickManaged(controller.signal, () => true);
    await turn();
    controller.abort();
    runtime.close();
    pending.resolve({ cursor: '', organizations: [] });
    await task;
    assert.equal(heads, 0);
    assert.equal(subscriptions, 0);
  });

test('a disabled replay channel also backs off and reenables within the five-second fallback', async () => {
  let now = 1000,
    enabled = false,
    authority = 0,
    discoveries = 0;
  const replay = createStaffEventReplay({
    platform: {
      notificationChannels: {
        enabled() {
          authority++;
          return enabled;
        },
      },
      withWriteLock() {},
    },
    tenantStore() {
      assert.fail('no tenant needed');
    },
    store: {
      organizationPage() {
        discoveries++;
        return { cursor: '', organizations: [] };
      },
    },
    clock: () => now,
  });
  for (let n = 0; n < 40; n++, now += 250) await replay.batched();
  assert.equal(authority, 2);
  assert.equal(discoveries, 0);
  enabled = true;
  now = 11000;
  await replay.batched();
  assert.equal(discoveries, 1);
});
