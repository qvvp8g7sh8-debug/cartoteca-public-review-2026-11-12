const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
const { createPushQueue } = require('../src/server/modules/notifications/push-queue.cjs');
const {
  createQueueMaintenance,
} = require('../src/server/modules/notifications/queue-maintenance.cjs');
const owned = { canRun: () => true };
const row = (f, table, id) => f.c.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
const clientTable = 'notification_channel_jobs';
const tableFor = (channel) =>
  channel === 'push'
    ? 'staff_push_jobs'
    : channel === 'max'
      ? 'staff_max_jobs'
      : 'staff_notification_jobs';
const staffQueue = (f, channel) =>
  createStaffQueue(f.c, { interest: { hasEnabledRecipients: () => true } }, channel);
const pushQueue = (f) =>
  createPushQueue(f.c, { runtimeAvailable: () => true, hasEnabledEvents: () => true });
async function drain(f, count = 24) {
  for (let index = 0; index < count; index++) await f.maintenance.tick(owned);
}

test('default OFF has no timer, maintenance writes or component requirement; enabled fails closed', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false });
  f.client('expired', { expires: f.clock() });
  f.maintenance.start(() => true);
  assert.deepEqual(await f.maintenance.tick(owned), { examined: 0, changed: 0 });
  assert.equal(f.maintenance.stats().running, false);
  assert.equal(f.transactions(), 0);
  assert.throws(() => createQueueMaintenance(f.c, { enabled: true }), /component schema/);
  // The original one-shot contract remains usable without the new component.
  const store = createNotificationStore(f.c);
  f.client('live');
  assert.equal(store.claim(f.clock(), ['telegram']).id, 'live');
  assert.equal(row(f, clientTable, 'expired').status, 'cancelled');
});

test('independent maintenance bounds rows, yields and reaches all channels without a claim', async (t) => {
  const f = await maintenanceFixture(t);
  for (let index = 0; index < 180; index++)
    f.client('expired-' + index, { expires: f.clock() - 100 });
  for (const channel of ['telegram', 'max', 'push'])
    f.staff(channel, channel, { expires: f.clock() });
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const first = await f.maintenance.tick(owned);
  assert.equal(first.examined, 128);
  assert.equal(first.changed, 128);
  assert.equal(yielded, true);
  assert.equal(f.maintenance.stats().lagMs, 100);
  await drain(f);
  for (const channel of ['telegram', 'max', 'push'])
    assert.equal(row(f, tableFor(channel), channel).status, 'cancelled');
  assert.equal(
    f.c.db.prepare("SELECT count(*) n FROM notification_channel_jobs WHERE status='pending'").get()
      .n,
    0,
  );
  assert.equal(f.maintenance.stats().examined, 183);
  assert.equal(f.maintenance.stats().changed, 183);
  assert.equal(JSON.stringify(f.maintenance.stats()).includes(f.owner.organizationId), false);
});

test('cleanup is independent of provider waits and empty queues take no write lock', async (t) => {
  const f = await maintenanceFixture(t);
  await f.maintenance.tick(owned);
  assert.equal(f.transactions(), 0);
  const store = createNotificationStore(f.c);
  assert.equal(store.claim(f.clock()), null);
  assert.equal(f.transactions(), 0);
  f.client('pending-http', { status: 'sending', lease: f.clock() + 100 });
  f.staff('max', 'other-channel', { expires: f.clock() });
  await drain(f);
  assert.equal(row(f, clientTable, 'pending-http').status, 'sending');
  assert.equal(row(f, 'staff_max_jobs', 'other-channel').status, 'cancelled');
});

test('fresh claim bypasses expired backlog, keeps ready FIFO and leases only one job', async (t) => {
  const f = await maintenanceFixture(t);
  for (let index = 0; index < 150; index++)
    f.client('dead-' + index, { due: f.clock() - 100, expires: f.clock() });
  f.client('b');
  f.client('a');
  f.client('future', { due: f.clock() + 1 });
  const context = {
    ...f.c,
    db: {
      prepare(sql) {
        const statement = f.c.db.prepare(sql);
        if (sql.startsWith('SELECT * FROM notification_channel_jobs WHERE status='))
          return {
            get(...args) {
              assert.equal(
                f.c.db.isTransaction,
                true,
                'Only the fresh claim may read an encrypted payload; empty/ready probes use covering IDs',
              );
              return statement.get(...args);
            },
          };
        return statement;
      },
      get isTransaction() {
        return f.c.db.isTransaction;
      },
    },
  };
  const store = createNotificationStore(context);
  const first = store.claim(f.clock(), ['telegram']);
  assert.equal(first.id, 'a');
  assert.equal(first.attempt, 1);
  assert.equal(first.lease_until, f.clock() + 120000);
  assert.equal(
    f.c.db.prepare("SELECT count(*) n FROM notification_channel_jobs WHERE status='reserved'").get()
      .n,
    1,
  );
  assert.equal(row(f, clientTable, 'dead-0').status, 'pending', 'No global claim cleanup');
  assert.equal(store.claim(f.clock(), ['telegram']).id, 'b');
  assert.equal(store.transition(first, 'reserved', 'sending', 0, f.clock()), true);
  f.advance(120000);
  await drain(f);
  assert.equal(row(f, clientTable, 'a').status, 'uncertain');
  assert.equal(
    store.transition(first, 'sending', 'sent', 0, f.clock()),
    false,
    'Stale ACK cannot revive an expired lease',
  );
});

test('on-demand recovery at lease equality is bounded and unknown client sends are never retried', async (t) => {
  const f = await maintenanceFixture(t);
  for (let index = 0; index < 12; index++)
    f.client('unknown-' + index, { status: 'sending', lease: f.clock() });
  const store = createNotificationStore(f.c);
  assert.equal(store.claim(f.clock(), ['telegram']), null);
  assert.equal(
    f.c.db
      .prepare("SELECT count(*) n FROM notification_channel_jobs WHERE status='uncertain'")
      .get().n,
    8,
  );
  f.client('reserved', { status: 'reserved', lease: f.clock() });
  const job = store.claim(f.clock(), ['telegram']);
  assert.equal(job.id, 'reserved');
  assert.equal(job.attempt, 1);
  assert.equal(store.claim(f.clock(), []), null);
  assert.throws(() => store.claim(f.clock(), ['invalid']), /channels/);
});

for (const channel of ['telegram', 'max', 'push'])
  test(`${channel}: direct claim preserves sending recovery, expiry and stale ACK fencing`, async (t) => {
    const f = await maintenanceFixture(t);
    const table = f.staff(channel, 'sending', { status: 'sending', lease: f.clock(), attempts: 2 });
    f.staff(channel, 'expired', { due: f.clock() - 100, expires: f.clock() });
    f.staff(channel, 'ready', { due: f.clock() + 1 });
    const queue = channel === 'push' ? pushQueue(f) : staffQueue(f, channel);
    const job = queue.claim(f.clock());
    if (channel === 'max') {
      assert.equal(job, null);
      assert.equal(row(f, table, 'sending').status, 'uncertain');
    } else {
      assert.equal(job.id, 'sending');
      assert.equal(job.attempts, 3);
      assert.notEqual(job.lease_id, 'prior-lease');
      assert.equal(
        Boolean(queue.finish({ ...job, lease_id: 'prior-lease', lease_until: f.clock() }, 'sent')),
        false,
      );
    }
    assert.equal(row(f, table, 'expired').status, 'pending');
    await drain(f);
    assert.equal(row(f, table, 'expired').status, 'cancelled');
    assert.equal(row(f, table, 'sending').status, channel === 'max' ? 'uncertain' : 'sending');
  });

test('MAX expired sends become uncertain before expiry; TG and Push expired sends cancel', async (t) => {
  const f = await maintenanceFixture(t);
  for (const channel of ['telegram', 'max', 'push']) {
    f.staff(channel, 'equal', { status: 'sending', lease: f.clock(), expires: f.clock() });
    f.staff(channel, 'future-lease', {
      status: 'sending',
      lease: f.clock() + 1,
      expires: f.clock(),
    });
  }
  f.client('client-unknown', { status: 'sending', lease: f.clock(), expires: f.clock() });
  f.client('client-reserved', { status: 'reserved', lease: f.clock(), expires: f.clock() });
  await drain(f);
  for (const channel of ['telegram', 'max', 'push']) {
    assert.equal(
      row(f, tableFor(channel), 'equal').status,
      channel === 'max' ? 'uncertain' : 'cancelled',
    );
    assert.equal(row(f, tableFor(channel), 'future-lease').status, 'cancelled');
  }
  assert.equal(row(f, clientTable, 'client-unknown').status, 'uncertain');
  assert.equal(row(f, clientTable, 'client-reserved').status, 'cancelled');
});

test('seven-day retention is strict and uncertainty differs by channel; clients retain history', async (t) => {
  const f = await maintenanceFixture(t),
    cutoff = f.clock() - 7 * 86400000;
  for (const channel of ['telegram', 'max', 'push']) {
    for (const status of [
      'sent',
      'failed',
      'cancelled',
      ...(channel === 'max' ? ['uncertain'] : []),
    ]) {
      f.staff(channel, status + '-old', { status, expires: cutoff - 1 });
      f.staff(channel, status + '-equal', { status, expires: cutoff });
    }
  }
  f.client('client-sent', { status: 'sent', expires: cutoff - 1 });
  f.client('client-uncertain', { status: 'uncertain', expires: cutoff - 1 });
  await drain(f);
  for (const channel of ['telegram', 'max', 'push']) {
    assert.equal(row(f, tableFor(channel), 'sent-old'), undefined);
    assert.equal(row(f, tableFor(channel), 'sent-equal').status, 'sent');
  }
  assert.equal(row(f, 'staff_max_jobs', 'uncertain-old'), undefined);
  assert.equal(row(f, clientTable, 'client-sent').status, 'sent');
  assert.equal(row(f, clientTable, 'client-uncertain').status, 'uncertain');
});

test('ownership, abort, disabled channel and stop fence a queued writer before mutation', async (t) => {
  const f = await maintenanceFixture(t);
  f.client('expired', { expires: f.clock() });
  await f.maintenance.tick({ canRun: () => false });
  const aborted = new AbortController();
  aborted.abort();
  await f.maintenance.tick({ ...owned, signal: aborted.signal });
  f.c.notificationChannels.enabled = () => false;
  await f.maintenance.tick(owned);
  assert.equal(f.transactions(), 0);
  f.c.notificationChannels.enabled = () => true;
  let release;
  f.c.asyncTransaction = (work) =>
    new Promise((resolve) => {
      release = () => resolve(f.c.transaction(work));
    });
  const pending = f.maintenance.tick(owned);
  assert.equal(f.maintenance.tick(owned), pending, 'No overlapping one-shot maintenance');
  f.maintenance.stop();
  release();
  await pending;
  assert.equal(row(f, clientTable, 'expired').status, 'pending');
  assert.equal(f.maintenance.stats().busy, false);
});

test('self-test marker pruning scans bounded pages and retains live tests', async (t) => {
  const f = await maintenanceFixture(t, { rowLimit: 16 });
  for (let index = 0; index < 44; index++) {
    const id = 'test-' + String(index).padStart(2, '0');
    f.staff('telegram', id);
    f.c.db
      .prepare('INSERT INTO telegram_runtime VALUES(?,?)')
      .run('staff-selftest-v1:telegram:' + id, f.c.seal({ active: true }));
  }
  f.c.db
    .prepare('INSERT INTO telegram_runtime VALUES(?,?)')
    .run('staff-selftest-v1:telegram:zz-orphan', f.c.seal({ active: true }));
  const before = f.maintenance.stats().examined;
  const first = await f.maintenance.tick(owned);
  assert.equal(first.examined, 16);
  assert.equal(f.maintenance.stats().examined - before, 16);
  await drain(f);
  assert.equal(
    f.c.db
      .prepare(
        "SELECT count(*) n FROM telegram_runtime WHERE key LIKE 'staff-selftest-v1:telegram:%'",
      )
      .get().n,
    44,
  );
});

test('personal events OFF still permits only explicit TG/MAX/Push self-tests', async (t) => {
  const f = await maintenanceFixture(t);
  for (const channel of ['telegram', 'max']) {
    f.staff(channel, 'ordinary-' + channel, { due: f.clock() - 100 });
    f.staff(channel, 'test-' + channel);
    f.c.db
      .prepare('INSERT INTO telegram_runtime VALUES(?,?)')
      .run('staff-selftest-v1:' + channel + ':test-' + channel, f.c.seal({ active: true }));
    const queue = createStaffQueue(
      f.c,
      { interest: { hasEnabledRecipients: () => false } },
      channel,
    );
    assert.equal(queue.claim(f.clock()).id, 'test-' + channel);
    assert.equal(queue.claim(f.clock()), null);
    assert.equal(row(f, tableFor(channel), 'ordinary-' + channel).status, 'pending');
  }
  f.staff('push', 'ordinary-push', { due: f.clock() - 100 });
  f.c.db
    .prepare(
      "UPDATE staff_push_jobs SET event_key='staff-push-event:synthetic' WHERE id='ordinary-push'",
    )
    .run();
  f.staff('push', 'test-push');
  const queue = createPushQueue(f.c, {
    runtimeAvailable: () => true,
    hasEnabledEvents: () => false,
    hasPendingTests: () => true,
  });
  assert.equal(queue.claim(f.clock()).id, 'test-push');
  assert.equal(queue.claim(f.clock()), null);
  assert.equal(row(f, 'staff_push_jobs', 'ordinary-push').status, 'pending');
});

test('bounded MAX expiry classifies unknown sends correctly before a full reclaim pass', async (t) => {
  const f = await maintenanceFixture(t, { rowLimit: 1 });
  for (let index = 0; index < 20; index++)
    f.staff('max', 'expired-unknown-' + index, {
      status: 'sending',
      lease: f.clock(),
      expires: f.clock(),
    });
  f.staff('max', 'expired-pending', { expires: f.clock() });
  for (let index = 0; index < 70; index++) {
    const result = await f.maintenance.tick(owned);
    assert.ok(result.examined <= 1);
  }
  assert.equal(
    f.c.db.prepare("SELECT count(*) n FROM staff_max_jobs WHERE status='uncertain'").get().n,
    20,
  );
  assert.equal(row(f, 'staff_max_jobs', 'expired-pending').status, 'cancelled');
});

test('soft time budget defers remaining phases and a failed slice can recover without overlap', async (t) => {
  const f = await maintenanceFixture(t, {
    monotonic: (() => {
      let now = 0;
      return () => (now += 3);
    })(),
  });
  f.client('expired', { expires: f.clock() });
  const result = await f.maintenance.tick(owned);
  assert.equal(
    result.examined,
    0,
    'Time spent probing empty phases counts toward the slice budget',
  );
  const original = f.c.asyncTransaction;
  f.c.asyncTransaction = async () => {
    throw Error('Synthetic writer failure');
  };
  // Resume the round-robin cursor until the due phase is reached.
  await assert.rejects(async () => {
    for (let index = 0; index < 16; index++) await f.maintenance.tick(owned);
  }, /Synthetic writer/);
  assert.equal(f.maintenance.stats().errors, 1);
  assert.equal(f.maintenance.stats().busy, false);
  f.c.asyncTransaction = original;
  await drain(f, 32);
  assert.equal(row(f, clientTable, 'expired').status, 'cancelled');
});
