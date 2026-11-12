const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { safeTree, plainFile } = require('../infrastructure/backup/snapshot.cjs');
const { fail } = require('../../shared/errors.cjs');
const { validatePaidSchema } = require('../modules/billing/prepared-schema.cjs');

function notificationSchema(config, environment = process.env) {
  const requested =
    config.notificationSchema ??
    environment.CARTOTECA_MAX_SCHEMA ??
    (config.pushEnabled ? 17 : config.maxEnabled || config.releaseGate ? 15 : 11);
  const schema = ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20'].includes(requested)
    ? Number(requested)
    : requested;
  if (![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(schema))
    throw fail(503, 'Нужна поддерживаемая подготовленная схема уведомлений.');
  if (config.pushEnabled && !config.releaseGate && schema < 17)
    throw fail(503, 'Сначала подготовьте схему 17 для пуш-уведомлений.');
  if (config.scheduledNotifications && schema < 18)
    throw fail(503, 'Сначала подготовьте схему 18 для планирования уведомлений.');
  if ((config.maxEnabled || config.releaseGate) && schema < 15)
    throw fail(503, 'Нужна подготовленная схема MAX.');
  return schema;
}

function assertPreparedNotifications(dataDir, schema = 15, { databaseOwner } = {}) {
  if (![15, 16, 17, 18, 19, 20].includes(schema))
    throw fail(503, 'Нужна подготовленная схема MAX.');
  const file = path.join(dataDir, 'platform', 'platform.sqlite');
  let db;
  if (databaseOwner?.dialect === 'postgres')
    db = require('../infrastructure/postgres/runtime.cjs').openRuntimeStore(
      databaseOwner,
      dataDir,
      path.join(dataDir, 'platform'),
      'platform',
      { schemaVersion: schema },
    );
  else {
    safeTree(path.dirname(file));
    plainFile(file);
    db = new DatabaseSync(file, { readOnly: true });
  }
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== schema)
      throw fail(503, 'Сначала подготовьте и проверьте копию базы MAX.');
    for (const table of [
      'max_client_links',
      'notification_channel_jobs',
      'notification_confirmations',
      'max_event_inbox',
      'max_runtime_leases',
      ...(schema >= 16
        ? ['staff_max_links', 'staff_max_tokens', 'staff_max_jobs', 'staff_max_stops']
        : []),
      ...(schema >= 17 ? ['staff_push_config', 'staff_push_devices', 'staff_push_jobs'] : []),
      ...(schema >= 18
        ? ['notification_schedule', 'notification_schedule_dirty', 'notification_schedule_intents']
        : []),
      ...(schema >= 19
        ? [
            'billing_settings',
            'billing_organization_settings',
            'billing_wallets',
            'billing_reservations',
            'billing_entries',
            'billing_operations',
            'billing_service_connections',
            'billing_customer_operations',
          ]
        : []),
    ])
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        throw fail(503, 'Подготовка базы MAX не завершена.');
    if (schema >= 19) {
      try {
        validatePaidSchema(db);
      } catch {
        throw fail(503, 'Подготовка схемы пакетов и оплаты не завершена.');
      }
    }
  } finally {
    db.close();
  }
}

module.exports = { notificationSchema, assertPreparedNotifications };
