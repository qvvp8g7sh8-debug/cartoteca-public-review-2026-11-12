const { staffMaxFixture } = require('./staff-max-fixture.cjs');
const {
  migrateNotificationSchedule,
} = require('../../src/server/migrations/018-notification-schedule.cjs');
const { migratePaidServices } = require('../../src/server/migrations/019-paid-services.cjs');
const { schema } = require('../../src/server/infrastructure/notification-maintenance-schema.cjs');
const {
  createQueueMaintenance,
} = require('../../src/server/modules/notifications/queue-maintenance.cjs');
async function maintenanceFixture(t, { enabled = true, prepared = true, ...options } = {}) {
  const f = await staffMaxFixture(t, { schema: 17 });
  migrateNotificationSchedule(f.database, f.platformDirectory);
  migratePaidServices(f.database, f.platformDirectory);
  if (prepared) f.database.db.exec(schema);
  let transactions = 0;
  const c = {
    ...f.database,
    transaction: (work) => {
      transactions++;
      return f.database.transaction(work);
    },
    notificationChannels: { enabled: () => true },
  };
  c.asyncTransaction = async (work) => c.transaction(work);
  // Keep the instrumented SQLite writer as the fallback for both explicit
  // intents, including delayed/rejected writer probes installed by tests.
  c.queueTransaction = (work) => (c.db.isTransaction ? work() : c.transaction(work));
  c.asyncQueueTransaction = (work) => c.asyncTransaction(work);
  c.notificationMaintenance = createQueueMaintenance(c, {
    enabled,
    clock: f.clock,
    monotonic: () => 0,
    ...options,
  });
  t.after(() => c.notificationMaintenance.stop());
  const client = (
    id,
    {
      channel = 'telegram',
      status = 'pending',
      due = f.clock(),
      expires = f.clock() + 600000,
      lease = 0,
    } = {},
  ) => {
    c.db
      .prepare(
        'INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        f.owner.organizationId,
        'synthetic-patient',
        id,
        id,
        channel,
        c.tokenHash(id),
        c.seal({ callback: id, recipient: { chatId: '123' } }),
        status,
        due,
        expires,
        lease,
      );
  };
  const staff = (
    channel,
    id,
    {
      status = 'pending',
      due = f.clock(),
      expires = f.clock() + 600000,
      lease = 0,
      attempts = 0,
    } = {},
  ) => {
    const table =
      channel === 'telegram'
        ? 'staff_notification_jobs'
        : channel === 'max'
          ? 'staff_max_jobs'
          : 'staff_push_jobs';
    if (channel === 'push') {
      c.db
        .prepare(
          'INSERT OR IGNORE INTO staff_push_devices(id,organization_id,account_id,endpoint_hash,value,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          'synthetic-device',
          f.owner.organizationId,
          f.owner.accountId,
          'synthetic-endpoint',
          c.seal({}),
          f.clock(),
        );
    }
    c.db
      .prepare(
        `INSERT INTO ${table}(id,organization_id,account_id,${channel === 'push' ? 'device_id,' : ''}event_key,value,status,next_at,expires_at,lease_until,lease_id,attempts) VALUES(?,?,?,${channel === 'push' ? '?,' : ''}?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        f.owner.organizationId,
        f.owner.accountId,
        ...(channel === 'push' ? ['synthetic-device'] : []),
        id,
        c.seal({ kind: 'test', event: 'test' }),
        status,
        due,
        expires,
        lease,
        lease ? 'prior-lease' : null,
        attempts,
      );
    return table;
  };
  return {
    ...f,
    c,
    client,
    staff,
    maintenance: c.notificationMaintenance,
    transactions: () => transactions,
  };
}
module.exports = { maintenanceFixture };
