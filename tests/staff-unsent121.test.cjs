const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
const {
  createStaffTelegramRuntime,
} = require('../src/server/modules/notifications/staff-runtime.cjs');
const {
  createStaffMaxRuntime,
} = require('../src/server/modules/notifications/staff-max-runtime.cjs');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(
  t,
  channel,
  { stage = 0, failure = '', send = '', payloadError = false, refundError = false } = {},
) {
  const db = new DatabaseSync(':memory:'),
    table = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs',
    controller = new AbortController(),
    paused = deferred(),
    resume = deferred(),
    providerEntered = deferred(),
    provider = deferred(),
    finishes = [];
  db.exec(`CREATE TABLE ${table}(
    id TEXT PRIMARY KEY, organization_id TEXT, account_id TEXT, event_key TEXT,
    value TEXT, status TEXT, next_at INTEGER, expires_at INTEGER,
    lease_id TEXT, lease_until INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0
  ); CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value TEXT)`);
  let now = 100000,
    active = true,
    units = 0,
    sends = 0,
    releases = 0,
    outcome;
  const c = {
    db,
    open: JSON.parse,
    seal: JSON.stringify,
    id: randomUUID,
    notificationChannels: { enabled: () => true },
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  db.prepare(
    `INSERT INTO ${table}(id,organization_id,account_id,event_key,value,status,next_at,expires_at)
    VALUES('job','org','account','event',?,'pending',?,?)`,
  ).run(
    JSON.stringify({ kind: 'test', event: 'test', chatId: channel === 'max' ? '123:456' : '456' }),
    now,
    now + 600000,
  );
  const queue = createStaffQueue(c, { interest: { hasEnabledRecipients: () => true } }, channel);
  const store = {
    hasPendingWork: () => true,
    claimManaged: queue.claimManaged,
    // Clinical/member checks have separate integration coverage. These tests
    // isolate the real leased queue/CAS and managed external-start boundary.
    valid: () => ({ kind: 'test' }),
    finish(job, status, nextAt, refund) {
      finishes.push({ status, refund: Boolean(refund) });
      if (refund && refundError) throw Error('synthetic refund I/O failure');
      return queue.finish(job, status, nextAt, refund);
    },
  };
  const options = {
    platform: {
      staffNotifications: store,
      organization: () => {
        if (payloadError) throw Error('synthetic payload preparation failure');
        return { name: 'Synthetic' };
      },
    },
    store,
    identity: { botId: '123' },
    clock: () => now,
    pacing: {
      acquire: async () => true,
      releaseDelivery: () => {
        releases++;
      },
    },
    bot: {
      send: () => {
        sends++;
        providerEntered.resolve();
        if (send === 'sync-throw') {
          controller.abort();
          throw Error('synthetic provider attempt interrupted synchronously');
        }
        return send === 'pending' ? provider.promise : Promise.resolve({});
      },
    },
    async runBackgroundWork(callback) {
      if (++units === stage) {
        paused.resolve();
        await resume.promise;
        if (failure === '499' || failure === '503')
          throw Object.assign(Error('synthetic admission ' + failure), { status: Number(failure) });
        if (failure === 'null') return null;
      }
      return callback();
    },
  };
  const runtime =
    channel === 'max' ? createStaffMaxRuntime(options) : createStaffTelegramRuntime(options);
  const start = () => {
    outcome = Promise.allSettled([runtime.tickManaged(controller.signal, () => active, 1)]);
    return outcome;
  };
  t.after(async () => {
    controller.abort();
    resume.resolve();
    provider.resolve({});
    if (outcome) await outcome;
    db.close();
  });
  return {
    db,
    table,
    queue,
    controller,
    paused,
    resume,
    providerEntered,
    provider,
    finishes,
    start,
    stop: () => {
      active = false;
    },
    advance: (ms) => {
      now += ms;
    },
    clock: () => now,
    row: () => db.prepare(`SELECT * FROM ${table} WHERE id='job'`).get(),
    stats: () => ({ sends, releases }),
  };
}

for (const channel of ['telegram', 'max']) {
  for (const stage of [2, 3])
    for (const failure of ['499', '503', 'null'])
      test(
        `${channel}: queued ${stage === 2 ? 'validation' : 'prepare'} ${failure} refunds known unsent lease`,
        { timeout: 3000 },
        async (t) => {
          const f = fixture(t, channel, { stage, failure }),
            running = f.start();
          await f.paused.promise;
          assert.equal(f.row().status, 'sending');
          assert.equal(f.row().attempts, 1);
          if (failure === '499') f.controller.abort();
          if (failure === 'null') f.stop();
          f.resume.resolve();
          await running;
          const row = f.row();
          assert.equal(row.status, 'pending');
          assert.equal(row.attempts, 0);
          assert.equal(row.lease_id, null);
          assert.equal(row.lease_until, 0);
          assert.equal(row.next_at, f.clock() + 1000);
          assert.equal(f.stats().sends, 0);
          assert.equal(f.stats().releases, stage === 3 ? 1 : 0);
        },
      );

  for (const replacement of ['lease', 'cancel'])
    test(
      `${channel}: unsent cleanup cannot revive a ${replacement === 'lease' ? 'reclaimed lease' : 'cancelled job'}`,
      { timeout: 3000 },
      async (t) => {
        const f = fixture(t, channel, { stage: 3, failure: '499' }),
          running = f.start();
        await f.paused.promise;
        if (replacement === 'lease')
          f.db
            .prepare(
              `UPDATE ${f.table} SET lease_id='new-owner',lease_until=lease_until+120000,attempts=2 WHERE id='job'`,
            )
            .run();
        else
          f.db
            .prepare(
              `UPDATE ${f.table} SET status='cancelled',lease_id=NULL,lease_until=0 WHERE id='job'`,
            )
            .run();
        f.controller.abort();
        f.resume.resolve();
        await running;
        const row = f.row();
        assert.equal(row.status, replacement === 'lease' ? 'sending' : 'cancelled');
        assert.equal(row.lease_id, replacement === 'lease' ? 'new-owner' : null);
        assert.equal(row.attempts, replacement === 'lease' ? 2 : 1);
        assert.equal(f.stats().sends, 0);
        assert.equal(f.stats().releases, 1);
      },
    );

  test(
    `${channel}: synchronous provider throw is an attempted send, never an unsent refund`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t, channel, { send: 'sync-throw' });
      await f.start();
      assert.equal(f.stats().sends, 1);
      assert.equal(f.stats().releases, 1);
      assert.equal(f.row().status, 'sending');
      assert.equal(f.row().attempts, 1);
      assert.equal(
        f.finishes.some((entry) => entry.refund),
        false,
      );
      if (channel === 'max') {
        f.advance(120001);
        assert.equal(f.queue.claimManaged(f.clock()), null);
        assert.equal(f.row().status, 'uncertain');
      }
    },
  );

  test(
    `${channel}: stopping a real pending provider retains uncertainty instead of refunding`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t, channel, { send: 'pending' }),
        running = f.start();
      await f.providerEntered.promise;
      f.controller.abort();
      f.provider.reject(Error('synthetic response lost after dispatch'));
      await running;
      assert.equal(f.row().status, 'sending');
      assert.equal(f.row().attempts, 1);
      assert.equal(f.stats().sends, 1);
      assert.equal(f.stats().releases, 1);
      assert.equal(
        f.finishes.some((entry) => entry.refund),
        false,
      );
    },
  );

  test(
    `${channel}: known ACK after stop is committed by the original lease`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t, channel, { send: 'pending' }),
        running = f.start();
      await f.providerEntered.promise;
      f.controller.abort();
      f.provider.resolve({});
      await running;
      assert.equal(f.row().status, 'sent');
      assert.equal(f.row().attempts, 1);
      assert.equal(f.stats().releases, 1);
      assert.equal(
        f.finishes.some((entry) => entry.refund),
        false,
      );
    },
  );

  test(
    `${channel}: payload preparation fails before any provider attempt and refunds the lease`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t, channel, { payloadError: true });
      const [result] = await f.start();
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /payload preparation/);
      assert.equal(f.row().status, 'pending');
      assert.equal(f.row().attempts, 0);
      assert.equal(f.stats().sends, 0);
      assert.equal(f.stats().releases, 1);
    },
  );

  test(
    `${channel}: a failed unsent-refund SQL write still releases the acquired provider slot`,
    { timeout: 3000 },
    async (t) => {
      const f = fixture(t, channel, { stage: 3, failure: '499', refundError: true }),
        running = f.start();
      await f.paused.promise;
      f.controller.abort();
      f.resume.resolve();
      const [result] = await running;
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.message, /refund I\/O/);
      assert.equal(f.row().status, 'sending', 'failed persistence remains unresolved');
      assert.equal(f.stats().sends, 0);
      assert.equal(f.stats().releases, 1);
    },
  );
}
