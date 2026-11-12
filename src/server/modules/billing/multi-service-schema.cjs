// Only migration020 uses this SQL; schema019 and all existing history remain intact.
const multiServiceSchema = `
CREATE TABLE billing_financial_actions(
 id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,
 order_id TEXT NOT NULL REFERENCES billing_payment_orders(id),kind TEXT NOT NULL CHECK(kind IN ('refund','receipt')),
 state TEXT NOT NULL CHECK(state IN ('creating','pending','uncertain','succeeded','canceled','rejected','review')),
 amount_kopecks INTEGER NOT NULL CHECK(amount_kopecks>0),provider_id TEXT,
 fingerprint TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,changed_at INTEGER NOT NULL,value BLOB NOT NULL,
 UNIQUE(actor_id,request_id),UNIQUE(kind,provider_id)
);
CREATE UNIQUE INDEX billing_financial_open_order ON billing_financial_actions(order_id) WHERE state IN ('creating','pending','uncertain','review');
CREATE UNIQUE INDEX billing_one_closing_receipt ON billing_financial_actions(order_id) WHERE kind='receipt' AND state NOT IN ('rejected','canceled');
CREATE TRIGGER billing_financial_no_delete BEFORE DELETE ON billing_financial_actions BEGIN SELECT RAISE(ABORT,'Financial history is immutable'); END;
CREATE TRIGGER billing_financial_frozen BEFORE UPDATE OF actor_id,request_id,order_id,kind,amount_kopecks,fingerprint,created_at ON billing_financial_actions
 BEGIN SELECT RAISE(ABORT,'Financial action terms are immutable'); END;
CREATE TABLE billing_grant_revocations(grant_id TEXT PRIMARY KEY REFERENCES billing_package_grants(id),reference_id TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER billing_revocations_no_delete BEFORE DELETE ON billing_grant_revocations BEGIN SELECT RAISE(ABORT,'Grant history is immutable'); END;
CREATE TRIGGER billing_revocations_no_update BEFORE UPDATE ON billing_grant_revocations BEGIN SELECT RAISE(ABORT,'Grant history is immutable'); END;
CREATE TABLE billing_services(code TEXT PRIMARY KEY,title TEXT NOT NULL,created_at INTEGER NOT NULL);
INSERT INTO billing_services VALUES('voice-assistant','Голосовой помощник',0);
ALTER TABLE billing_package_definitions ADD COLUMN service_code TEXT NOT NULL DEFAULT 'voice-assistant';
ALTER TABLE billing_package_definitions ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1 CHECK(period_months BETWEEN 1 AND 36);
ALTER TABLE billing_package_definitions ADD COLUMN receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(receipt_json));
ALTER TABLE billing_package_definitions ADD COLUMN quota_unit TEXT NOT NULL DEFAULT 'tasks' CHECK(quota_unit IN ('tasks','units','access'));
ALTER TABLE billing_package_grants ADD COLUMN service_code TEXT NOT NULL DEFAULT 'voice-assistant';
ALTER TABLE billing_package_grants ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1 CHECK(period_months BETWEEN 1 AND 36);
ALTER TABLE billing_package_grants ADD COLUMN quota_unit TEXT NOT NULL DEFAULT 'tasks' CHECK(quota_unit IN ('tasks','units','access'));
ALTER TABLE billing_payment_orders ADD COLUMN service_code TEXT NOT NULL DEFAULT 'voice-assistant';
CREATE TRIGGER billing_package_definitions_service_known BEFORE INSERT ON billing_package_definitions WHEN NOT EXISTS(SELECT 1 FROM billing_services WHERE code=NEW.service_code) BEGIN SELECT RAISE(ABORT,'Unknown billing service'); END;
CREATE TRIGGER billing_package_grants_service_known BEFORE INSERT ON billing_package_grants WHEN NOT EXISTS(SELECT 1 FROM billing_services WHERE code=NEW.service_code) BEGIN SELECT RAISE(ABORT,'Unknown billing service'); END;
CREATE TRIGGER billing_payment_orders_service_known BEFORE INSERT ON billing_payment_orders WHEN NOT EXISTS(SELECT 1 FROM billing_services WHERE code=NEW.service_code) BEGIN SELECT RAISE(ABORT,'Unknown billing service'); END;
CREATE INDEX billing_grants_org_service ON billing_package_grants(organization_id,service_code,ends_at DESC);
DROP INDEX billing_payment_open_org;
CREATE UNIQUE INDEX billing_payment_open_service ON billing_payment_orders(organization_id,service_code)
 WHERE state IN ('creating','pending','uncertain','review');
CREATE TRIGGER billing_payment_service_frozen BEFORE UPDATE OF service_code ON billing_payment_orders
 WHEN NEW.service_code IS NOT OLD.service_code BEGIN SELECT RAISE(ABORT,'Payment service is immutable'); END;
CREATE TRIGGER billing_package_service_frozen BEFORE UPDATE OF service_code ON billing_package_definitions
 WHEN NEW.service_code IS NOT OLD.service_code BEGIN SELECT RAISE(ABORT,'Package service is immutable'); END;
`;
function validateMultiServiceSchema(db) {
  const expected = {
    billing_services: ['code', 'title', 'created_at'],
    billing_package_definitions: ['service_code', 'period_months', 'quota_unit', 'receipt_json'],
    billing_package_grants: ['service_code', 'period_months', 'quota_unit'],
    billing_payment_orders: ['service_code'],
    billing_financial_actions: [
      'id',
      'actor_id',
      'request_id',
      'order_id',
      'kind',
      'state',
      'amount_kopecks',
      'provider_id',
      'fingerprint',
      'lease_until',
      'created_at',
      'changed_at',
      'value',
    ],
    billing_grant_revocations: ['grant_id', 'reference_id', 'created_at'],
  };
  for (const [table, names] of Object.entries(expected)) {
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (
      names.some((name) => !columns.some((row) => row.name === name)) ||
      (table === 'billing_financial_actions' &&
        !columns.some(
          (row) => row.name === 'value' && row.type.toUpperCase() === 'BLOB' && row.notnull === 1,
        ))
    )
      throw Error('Incomplete multi-service billing schema: ' + table);
  }
  for (const name of [
    'billing_financial_no_delete',
    'billing_financial_frozen',
    'billing_revocations_no_delete',
    'billing_revocations_no_update',
    'billing_package_definitions_service_known',
    'billing_package_grants_service_known',
    'billing_payment_orders_service_known',
    'billing_payment_service_frozen',
    'billing_package_service_frozen',
  ])
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))
      throw Error('Missing multi-service protection: ' + name);
  for (const name of [
    'billing_payment_open_service',
    'billing_financial_open_order',
    'billing_one_closing_receipt',
    'billing_grants_org_service',
  ])
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name))
      throw Error('Missing multi-service index: ' + name);
  require('./schema-index-validation.cjs').validateBillingIndexes(db, 20);
}
module.exports = { multiServiceSchema, validateMultiServiceSchema };
