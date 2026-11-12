const path = require('node:path');
const { fail } = require('../src/shared/errors.cjs');

// Invoke the actual closed SQL builders with an empty recording port. This is
// source/plan coverage only: the port neither authorizes nor persists anything.
function collectBuilderSQL(root, catalog) {
  const statements = [];
  const uuid = '00000000-0000-4000-8000-000000000122';
  let ready = true;
  const db = {
    isTransaction: true,
    prepare(sql) {
      const frames = new Error().stack.split('\n');
      const frame = frames.find((line) => line.includes(path.join(root, 'src')));
      const location =
        /\((.+):(\d+):\d+\)$/.exec(frame || '') || /at (.+):(\d+):\d+$/.exec(frame || '');
      const entry = {
        sql,
        file: location
          ? path.relative(root, location[1]).replaceAll('\\', '/')
          : 'generated-builder',
        line: location ? Number(location[2]) : 0,
        operation: 'prepare',
        method: 'all',
        generated: true,
      };
      statements.push(entry);
      const get = (...args) => {
        if (/^PRAGMA user_version$/i.test(sql)) return { user_version: 20 };
        if (/SELECT count\(\*\) n/i.test(sql)) return { n: 0 };
        if (/FROM sqlite_(master|schema)/i.test(sql)) {
          const name = args[0] || /name='([^']+)'/.exec(sql)?.[1];
          return catalog.objects.some((object) => object.name === name) ? { 1: 1 } : undefined;
        }
        if (/SELECT 1 FROM telegram_runtime WHERE key=\?/i.test(sql))
          return ready ? { 1: 1 } : undefined;
        if (/SELECT id FROM support_requests WHERE id=\?/i.test(sql))
          return { id: 'synthetic-request' };
        if (/^SELECT 1 FROM notification_channel_jobs/i.test(sql)) return { 1: 1 };
        return undefined;
      };
      return {
        get,
        all: () => [],
        iterate: function* () {},
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
    exec() {},
  };
  const context = {
    db,
    fail,
    open: (value) => value,
    seal: (value) => value,
    transaction: (callback) => callback(),
    id: () => uuid,
    limitKey: () => 'synthetic-scope',
    tokenHash: (value) => value,
    audit() {},
    setAuditObserver() {},
    now: () => 1,
    admin() {},
    available: () => true,
    identifier: (value) => value,
    packages: {
      multipleServices: () => true,
      services: () => [{ code: 'voice-assistant', title: 'Assistant' }],
    },
  };
  const policy = { assert() {} };
  const channels = [['telegram'], ['max'], ['telegram', 'max']];
  for (const enabled of [false, true]) {
    context.notificationMaintenance = { enabled, recoverClient() {} };
    require('../src/server/modules/notifications/push-queue.cjs').createPushQueue(context, {});
    const store =
      require('../src/server/modules/notifications/notification-store.cjs').createNotificationStore(
        context,
      );
    for (const selected of channels) {
      store.claim(1, selected);
      store.claimManaged(1, selected);
    }
  }
  const maintenance = require('../src/server/modules/notifications/queue-compatibility-maintenance.cjs');
  for (const table of [
    'telegram_jobs',
    'staff_push_jobs',
    'staff_notification_jobs',
    'staff_max_jobs',
    'notification_channel_jobs',
  ])
    for (const selected of table === 'notification_channel_jobs' ? channels : [[]])
      maintenance.createQueueCompatibilityMaintenance(context, table, selected);
  require('../src/server/modules/notifications/queue-maintenance-store.cjs').createQueueMaintenanceStore(
    context,
  );
  for (const rowReady of [false, true]) {
    ready = rowReady;
    for (const channel of ['telegram', 'max']) {
      const interest =
        require('../src/server/modules/notifications/staff-notification-interest.cjs').createStaffNotificationInterest(
          context,
          channel,
        );
      for (const staff of [null, uuid]) interest.rows(uuid, staff, 'appointment');
      interest.hasAppointments(uuid);
      interest.hasEnabledRecipients();
      interest.organizations('', 2);
    }
    const interest =
      require('../src/server/modules/notifications/client-notification-interest.cjs').createClientNotificationInterest(
        context,
      );
    for (const selected of channels) {
      interest.organizations(selected);
      interest.batch('', 2, selected);
      for (const org of ['', uuid]) interest.has(org, selected);
    }
  }
  ready = true;
  require('../src/server/modules/notifications/pause-pending.cjs').pausePendingNotifications(
    context,
    uuid,
  );
  const booking =
    require('../src/server/modules/booking/request-store.cjs').createBookingRequestStore(context);
  for (const staff of ['', uuid])
    for (const cursor of [null, { createdAt: 1, id: uuid }]) booking.list(uuid, staff, cursor, 1);
  booking.publicCapacity(uuid, '70000000000', 1);
  for (const to of ['2026-10-21', '2026-11-21']) booking.reserves(uuid, '2026-10-21', to, 1);
  const future = require('../src/server/modules/schedules/future-days.cjs').createFutureDays(
    context,
  );
  for (const staff of [[], [uuid], [uuid, 'second']]) Array.from(future(uuid, staff, '2026-10-21'));
  const indexes = require('../src/server/infrastructure/cabinet-indexes.cjs').createCabinetIndexes({
    ...context,
    schemaVersion: 2,
    hash: (value) => value,
    encode: (value) => value,
    decode: (value) => value,
  });
  for (const staffId of ['', uuid])
    for (const end of ['2026-10-21', '2026-11-21'])
      indexes.appointments('2026-10-21', end, { staffId });
  const audit = require('../src/server/modules/admin/audit.cjs').createAdminAudit(context, policy);
  audit.page(uuid);
  audit.page(uuid, {
    q: 'synthetic',
    actorId: uuid,
    organizationId: uuid,
    event: 'created',
    before: '1',
  });
  const directory = require('../src/server/modules/admin/directory.cjs').createAdminDirectory(
    context,
    { touch() {} },
  );
  for (const kind of ['account', 'organization'])
    for (const selected of [{}, { q: 'synthetic', status: 'active', plan: 'paid' }]) {
      directory.page(kind, selected);
      directory.page(kind, {
        ...selected,
        cursor: require('../src/server/modules/admin/directory-query.cjs').directoryCursor(
          'synthetic-scope',
          { created_at: 1, id: uuid },
          context.limitKey,
        ),
      });
    }
  const cases = require('../src/server/modules/support/cases.cjs').createSupportCases(
    context,
    policy,
    {},
    {},
  );
  for (const state of ['', 'open', 'resolved'])
    cases.page(uuid, { state, organizationId: uuid, accountId: uuid, before: 1, beforeId: uuid });
  cases.page(uuid);
  const conversation =
    require('../src/server/modules/support/conversation.cjs').createSupportConversation(
      context,
      policy,
      {},
    );
  for (const author of [false, true])
    for (const input of [{}, { before: 1, beforeId: uuid }])
      conversation.page(uuid, uuid, input, author);
  const improvements =
    require('../src/server/modules/support/improvements.cjs').createImprovementListing(context);
  for (const organizationId of [null, uuid])
    for (const input of [{}, { before: 1, beforeId: uuid }])
      improvements.improvements({ accountId: uuid, organizationId }, input);
  const ledger =
    require('../src/server/modules/billing/payment-order-ledger.cjs').createPaymentOrderLedger(
      context,
      {},
    );
  const row = { id: uuid, value: { revision: 1 } };
  for (const changes of [
    {},
    { state: 'pending' },
    {
      provider_payment_id: uuid,
      provider_status: 'pending',
      receipt_status: 'pending',
      state: 'pending',
      paid_confirmed_at: null,
      fulfilled_at: null,
      lease_until: 0,
      lease_id: null,
    },
  ])
    ledger.save(row, { revision: 1 }, changes);
  for (const organization of [null, uuid]) {
    ledger.adminRevenue(uuid, organization);
    ledger.serviceRevenues(uuid, organization);
  }
  for (const ids of [[uuid], [uuid, '00000000-0000-4000-8000-000000000123']])
    ledger.organizationRevenues(uuid, ids);
  for (const status of ['all', 'attention', 'pending', 'paid', 'canceled', 'rejected'])
    for (const input of [
      {},
      { organizationId: uuid, serviceCode: 'voice-assistant', q: uuid, before: '1:' + uuid },
    ])
      ledger.adminOrders(uuid, { ...input, status });
  return statements;
}
module.exports = { collectBuilderSQL };
