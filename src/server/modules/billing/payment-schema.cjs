// Preparation only: no merchant, tax choice, order or package is created here.
const paymentSchema = `
CREATE TABLE billing_payment_settings(
 id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>=1),
 configured INTEGER NOT NULL DEFAULT 0 CHECK(configured IN (0,1)),
 changed_at INTEGER NOT NULL,value BLOB NOT NULL
);
CREATE TABLE billing_payment_orders(
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),
 account_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,
 package_id TEXT NOT NULL REFERENCES billing_package_definitions(id),
 price_kopecks INTEGER NOT NULL CHECK(price_kopecks BETWEEN 1 AND 9007199254740991),
 state TEXT NOT NULL CHECK(state IN ('creating','pending','uncertain','paid','canceled','rejected','review')),
 provider_payment_id TEXT UNIQUE,provider_status TEXT,
 receipt_status TEXT CHECK(receipt_status IS NULL OR receipt_status IN ('pending','succeeded','canceled')),
 config_revision INTEGER NOT NULL,shop_id TEXT NOT NULL,
 test_mode INTEGER NOT NULL CHECK(test_mode IN (0,1)),
 created_at INTEGER NOT NULL,changed_at INTEGER NOT NULL,
 paid_confirmed_at INTEGER,fulfilled_at INTEGER,
 lease_until INTEGER NOT NULL DEFAULT 0,lease_id TEXT,
 value BLOB NOT NULL,UNIQUE(organization_id,request_id)
);
CREATE TRIGGER billing_payment_orders_no_delete BEFORE DELETE ON billing_payment_orders BEGIN SELECT RAISE(ABORT,'Payment history is immutable'); END;
CREATE TRIGGER billing_payment_orders_frozen BEFORE UPDATE OF organization_id,account_id,request_id,package_id,price_kopecks,config_revision,shop_id,test_mode,created_at ON billing_payment_orders
 WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.account_id IS NOT OLD.account_id OR NEW.request_id IS NOT OLD.request_id OR NEW.package_id IS NOT OLD.package_id OR NEW.price_kopecks IS NOT OLD.price_kopecks OR NEW.config_revision IS NOT OLD.config_revision OR NEW.shop_id IS NOT OLD.shop_id OR NEW.test_mode IS NOT OLD.test_mode OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'Payment order terms are immutable'); END;
CREATE UNIQUE INDEX billing_payment_open_org ON billing_payment_orders(organization_id)
 WHERE state IN ('creating','pending','uncertain','review');
CREATE INDEX billing_payment_orders_org ON billing_payment_orders(organization_id,created_at DESC,id);
CREATE INDEX billing_payment_revenue ON billing_payment_orders(test_mode,paid_confirmed_at,organization_id,price_kopecks);
CREATE TABLE billing_payment_operations(
 actor_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,value BLOB NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
`;
const paymentTables = Object.freeze([
  'billing_payment_settings',
  'billing_payment_orders',
  'billing_payment_operations',
]);
module.exports = { paymentSchema, paymentTables };
