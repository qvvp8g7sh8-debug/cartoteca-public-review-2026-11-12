const { walletTables } = require('./wallet-schema.cjs');
const { packageTables } = require('./package-schema.cjs');
const { paymentTables } = require('./payment-schema.cjs');

const billingTables = Object.freeze([
  ...walletTables,
  'billing_service_connections',
  'billing_customer_operations',
  ...packageTables,
  ...paymentTables,
]);
const billingBlobs = Object.freeze({
  billing_entries: 'value',
  billing_reservations: 'value',
  billing_operations: 'value',
  billing_service_connections: 'value',
  billing_customer_operations: 'value',
  billing_package_operations: 'value',
  billing_payment_settings: 'value',
  billing_payment_orders: 'value',
  billing_payment_operations: 'value',
});
const billingTriggers = Object.freeze([
  ['billing_entries_immutable_update', 'billing_entries', 'UPDATE'],
  ['billing_entries_immutable_delete', 'billing_entries', 'DELETE'],
  ['billing_package_grants_no_update', 'billing_package_grants', 'UPDATE'],
  ['billing_package_grants_no_delete', 'billing_package_grants', 'DELETE'],
  ['billing_payment_orders_no_delete', 'billing_payment_orders', 'DELETE'],
  ['billing_payment_orders_frozen', 'billing_payment_orders', 'UPDATE'],
]);

// Read-only completeness gate shared by startup and offline backup validation.
function validatePaidSchema(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 20) require('./multi-service-schema.cjs').validateMultiServiceSchema(db);
  for (const name of billingTables)
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
      throw Error('Incomplete package/payment schema.');
  for (const [name, table, action] of billingTriggers) {
    const row = db
      .prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(name);
    if (
      row?.tbl_name !== table ||
      !new RegExp('BEFORE\\s+' + action + '(?:\\s+OF\\s+[\\s\\S]+?)?\\s+ON', 'i').test(row.sql) ||
      !/RAISE\s*\(\s*ABORT/i.test(row.sql)
    )
      throw Error('Financial history protection is missing.');
  }
  for (const [table, column] of Object.entries(billingBlobs)) {
    const info = db
      .prepare('PRAGMA table_info(' + table + ')')
      .all()
      .find((entry) => entry.name === column);
    if (!info || info.type.toUpperCase() !== 'BLOB' || info.notnull !== 1)
      throw Error('Encrypted financial state column is missing.');
  }
  if (version < 20) require('./schema-index-validation.cjs').validateBillingIndexes(db, 19);
}
module.exports = { billingTables, billingBlobs, billingTriggers, validatePaidSchema };
