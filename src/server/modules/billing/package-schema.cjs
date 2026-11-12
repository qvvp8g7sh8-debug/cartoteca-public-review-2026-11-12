// Preparation-only SQL: no package, trial, price or quota is created automatically.
const packageSchema = `
CREATE TABLE billing_package_definitions(
 id TEXT PRIMARY KEY,title TEXT NOT NULL,
 price_kopecks INTEGER NOT NULL CHECK(price_kopecks BETWEEN 0 AND 9007199254740991),
 task_limit INTEGER NOT NULL CHECK(task_limit BETWEEN 0 AND 1000000),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision>=1),changed_at INTEGER NOT NULL,
 CHECK(enabled=0 OR (price_kopecks>0 AND task_limit>0))
);
CREATE TABLE billing_package_grants(
 id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),
 package_id TEXT NOT NULL REFERENCES billing_package_definitions(id),
 package_version INTEGER NOT NULL,title TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('paid','trial')),
 source_order_id TEXT UNIQUE,
 test_mode INTEGER NOT NULL DEFAULT 0 CHECK(test_mode IN (0,1)),
 price_kopecks INTEGER NOT NULL CHECK(price_kopecks BETWEEN 0 AND 9007199254740991),
 task_limit INTEGER NOT NULL CHECK(task_limit BETWEEN 1 AND 1000000),
 starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
 actor_id TEXT REFERENCES accounts(id),created_at INTEGER NOT NULL,
 CHECK((source='trial' AND price_kopecks=0 AND source_order_id IS NULL) OR
       (source='paid' AND price_kopecks>0 AND source_order_id IS NOT NULL))
);
CREATE INDEX billing_package_grants_org ON billing_package_grants(organization_id,ends_at DESC,starts_at DESC);
CREATE TRIGGER billing_package_grants_no_update BEFORE UPDATE ON billing_package_grants BEGIN SELECT RAISE(ABORT,'Package grants are immutable'); END;
CREATE TRIGGER billing_package_grants_no_delete BEFORE DELETE ON billing_package_grants BEGIN SELECT RAISE(ABORT,'Package history is immutable'); END;
CREATE TABLE billing_package_tasks(
 id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES billing_package_grants(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id),account_id TEXT NOT NULL REFERENCES accounts(id),
 session_hash TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
 dialogue_hash TEXT,state TEXT NOT NULL CHECK(state IN ('reserved','accepted','uncertain','released')),
 attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt>=1),created_at INTEGER NOT NULL,accepted_at INTEGER,
 UNIQUE(organization_id,account_id,session_hash,request_id)
);
CREATE INDEX billing_package_tasks_quota ON billing_package_tasks(grant_id,state);
CREATE TABLE billing_package_operations(
 actor_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,value BLOB NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
`;
const packageTables = Object.freeze([
  'billing_package_definitions',
  'billing_package_grants',
  'billing_package_tasks',
  'billing_package_operations',
]);
module.exports = { packageSchema, packageSchemaSQL: packageSchema, packageTables };
