const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const {
  createQueueCompatibilityMaintenance,
} = require('../src/server/modules/notifications/queue-compatibility-maintenance.cjs');
const { createPushQueue } = require('../src/server/modules/notifications/push-queue.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
const row = (f, table, id) => f.c.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);

test('compatibility cleanup has a physical 64-row page, closed identifiers, no payload reads and exact retention boundary', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false });
  const table = 'staff_push_jobs',
    now = f.clock();
  for (let n = 0; n < 130; n++)
    f.staff('push', 'expired-' + String(n).padStart(3, '0'), { expires: now });
  f.staff('push', 'old-terminal', { status: 'sent', expires: now - 7 * 86400000 - 1 });
  f.staff('push', 'retention-boundary', { status: 'sent', expires: now - 7 * 86400000 });
  f.c.db.prepare('UPDATE staff_push_jobs SET value=?').run(Buffer.from('not-a-payload'));
  const cleanup = createQueueCompatibilityMaintenance(f.c, table);
  assert.throws(() => cleanup.sweep(now), /transaction/);
  assert.deepEqual(
    f.c.transaction(() => cleanup.sweep(now)),
    { examined: 64, changed: 64 },
  );
  assert.equal(
    f.c.db.prepare("SELECT count(*) n FROM staff_push_jobs WHERE status='pending'").get().n,
    66,
  );
  f.c.transaction(() => cleanup.sweep(now));
  f.c.transaction(() => cleanup.sweep(now));
  assert.equal(row(f, table, 'old-terminal'), undefined);
  assert.equal(row(f, table, 'retention-boundary').status, 'sent');
  for (const invalid of ['accounts', 'constructor', 'staff_push_jobs; DROP TABLE accounts'])
    assert.throws(() => createQueueCompatibilityMaintenance(f.c, invalid), /Invalid/);
});

test('managed Push skips unswept expired rows, bounds cleanup and keeps the explicit manual cleanup contract', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
    now = f.clock();
  for (let n = 0; n < 130; n++)
    f.staff('push', 'expired-' + String(n).padStart(3, '0'), { expires: now, due: now - 1 });
  f.staff('push', 'z-live');
  const queue = createPushQueue(f.c, {
    runtimeAvailable: () => true,
    hasEnabledEvents: () => true,
  });
  assert.equal(queue.claimManaged(now).id, 'z-live');
  assert.equal(
    row(f, 'staff_push_jobs', 'expired-129').status,
    'pending',
    'one claim does not sweep every row',
  );
  assert.equal(queue.peekManaged(now), null, 'unswept expired rows are never a send candidate');
  f.staff('push', 'z-next');
  assert.equal(queue.claim(now).id, 'z-next');
  assert.equal(
    row(f, 'staff_push_jobs', 'expired-129').status,
    'cancelled',
    'manual API retains legacy bulk cleanup',
  );
});

test('bounded client recovery preserves channels, unknown sends, lease equality and earlier-reservation barrier', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
    now = f.clock();
  for (let n = 0; n < 12; n++)
    f.client('reserved-' + n, { status: 'reserved', lease: now, due: now - 1 });
  f.client('unknown', { status: 'sending', lease: now });
  f.client('other-channel', { status: 'sending', channel: 'max', lease: now });
  const cleanup = createQueueCompatibilityMaintenance(f.c, 'notification_channel_jobs', [
    'telegram',
  ]);
  assert.equal(f.c.transaction(() => cleanup.recover(now)).examined, 8);
  assert.equal(row(f, 'notification_channel_jobs', 'unknown').status, 'uncertain');
  assert.equal(row(f, 'notification_channel_jobs', 'other-channel').status, 'sending');
  assert.equal(cleanup.blocks(now, now), true);
  f.c.transaction(() => cleanup.recover(now));
  assert.equal(cleanup.blocks(now, now), false);
  assert.equal(
    f.c.db.prepare("SELECT count(*) n FROM notification_channel_jobs WHERE status='pending'").get()
      .n,
    12,
  );
  assert.equal(row(f, 'notification_channel_jobs', 'unknown').status, 'uncertain');
});

for (const channel of ['telegram', 'max'])
  test(`managed staff ${channel} keeps recovery safety and does not claim expired backlog`, async (t) => {
    const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
      now = f.clock();
    const table = channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs';
    for (let n = 0; n < 130; n++)
      f.staff(channel, 'expired-' + String(n).padStart(3, '0'), { expires: now, due: now - 1 });
    f.staff(channel, 'z-sending', { status: 'sending', lease: now });
    f.staff(channel, 'z-ready');
    const queue = createStaffQueue(
      f.c,
      { interest: { hasEnabledRecipients: () => true } },
      channel,
    );
    const job = queue.claimManaged(now);
    assert.equal(job.id, 'z-ready');
    assert.equal(row(f, table, 'expired-129').status, 'pending');
    if (channel === 'max') assert.equal(row(f, table, 'z-sending').status, 'uncertain');
    else assert.equal(queue.claimManaged(now).id, 'z-sending');
  });

test('managed client empty queue has no write transaction and expired backlog does not become a lease', async (t) => {
  const f = await maintenanceFixture(t, { enabled: false, prepared: false }),
    now = f.clock();
  const store = createNotificationStore(f.c),
    before = f.transactions();
  assert.equal(store.claimManaged(now, ['telegram']), null);
  assert.equal(f.transactions(), before);
  for (let n = 0; n < 130; n++)
    f.client('expired-' + String(n).padStart(3, '0'), { expires: now, due: now - 1 });
  f.client('z-ready');
  assert.equal(store.claimManaged(now, ['telegram']).id, 'z-ready');
  assert.equal(row(f, 'notification_channel_jobs', 'expired-129').status, 'pending');
  assert.equal(store.claimManaged(now, ['telegram']), null);
});
