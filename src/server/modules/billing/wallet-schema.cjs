// Exported preparation DDL only. Opening the store never executes this schema.
const walletSchema = `
CREATE TABLE billing_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  default_markup_bps INTEGER NOT NULL DEFAULT 0 CHECK(default_markup_bps BETWEEN 0 AND 1000000),
  configured INTEGER NOT NULL DEFAULT 0 CHECK(configured IN (0,1)),
  insufficient_funds_policy TEXT NOT NULL DEFAULT 'prepaid' CHECK(insufficient_funds_policy IN ('unconfigured','prepaid')),
  changed_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO billing_settings(id) VALUES(1);
CREATE TABLE billing_organization_settings(
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  markup_bps INTEGER CHECK(markup_bps BETWEEN 0 AND 1000000),
  changed_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE billing_wallets(
  id TEXT PRIMARY KEY,
  organization_id TEXT UNIQUE REFERENCES organizations(id),
  balance_microrub INTEGER NOT NULL DEFAULT 0 CHECK(balance_microrub BETWEEN -9007199254740991 AND 9007199254740991),
  reserved_microrub INTEGER NOT NULL DEFAULT 0 CHECK(reserved_microrub BETWEEN 0 AND 9007199254740991),
  provider_cost_microrub INTEGER NOT NULL DEFAULT 0 CHECK(provider_cost_microrub BETWEEN 0 AND 9007199254740991),
  charged_microrub INTEGER NOT NULL DEFAULT 0 CHECK(charged_microrub BETWEEN 0 AND 9007199254740991),
  unpaid_charge_microrub INTEGER NOT NULL DEFAULT 0 CHECK(unpaid_charge_microrub BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  changed_at INTEGER NOT NULL DEFAULT 0,
  CHECK((id='platform' AND organization_id IS NULL) OR (organization_id IS NOT NULL AND id='org:'||organization_id)),
  CHECK(organization_id IS NULL OR balance_microrub>=0)
);
CREATE TABLE billing_reservations(
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  service TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','settled','released')),
  provider_quote_microrub INTEGER NOT NULL CHECK(provider_quote_microrub BETWEEN 0 AND 9007199254740991),
  charge_quote_microrub INTEGER NOT NULL CHECK(charge_quote_microrub BETWEEN 0 AND 9007199254740991),
  markup_bps INTEGER NOT NULL CHECK(markup_bps BETWEEN 0 AND 1000000),
  package_covered INTEGER NOT NULL DEFAULT 0 CHECK(package_covered IN (0,1)),
  provider_actual_microrub INTEGER CHECK(provider_actual_microrub BETWEEN 0 AND 9007199254740991),
  charged_microrub INTEGER CHECK(charged_microrub BETWEEN 0 AND 9007199254740991),
  retail_microrub INTEGER CHECK(retail_microrub BETWEEN 0 AND 9007199254740991),
  unpaid_charge_microrub INTEGER CHECK(unpaid_charge_microrub BETWEEN 0 AND 9007199254740991),
  estimated INTEGER NOT NULL DEFAULT 1 CHECK(estimated IN (0,1)),
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  value BLOB NOT NULL
);
CREATE INDEX billing_reservations_org ON billing_reservations(organization_id,state,created_at);
CREATE TABLE billing_entries(
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES billing_wallets(id),
  organization_id TEXT REFERENCES organizations(id),
  reservation_id TEXT REFERENCES billing_reservations(id),
  kind TEXT NOT NULL CHECK(kind IN ('credit','expense','charge')),
  service TEXT,
  amount_microrub INTEGER NOT NULL CHECK(amount_microrub BETWEEN -9007199254740991 AND 9007199254740991),
  balance_after_microrub INTEGER NOT NULL CHECK(balance_after_microrub BETWEEN -9007199254740991 AND 9007199254740991),
  actor_id TEXT REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  value BLOB NOT NULL,
  UNIQUE(wallet_id,idempotency_key),
  UNIQUE(wallet_id,reservation_id,kind)
);
CREATE INDEX billing_entries_wallet ON billing_entries(wallet_id,created_at DESC,id);
CREATE INDEX billing_entries_org ON billing_entries(organization_id,created_at DESC);
CREATE TRIGGER billing_entries_immutable_update BEFORE UPDATE ON billing_entries BEGIN SELECT RAISE(ABORT,'Financial history is append-only'); END;
CREATE TRIGGER billing_entries_immutable_delete BEFORE DELETE ON billing_entries BEGIN SELECT RAISE(ABORT,'Financial history is append-only'); END;
CREATE TABLE billing_operations(
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  value BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(actor_id,request_id)
);
`;
const walletTables = Object.freeze([
  'billing_settings',
  'billing_organization_settings',
  'billing_wallets',
  'billing_reservations',
  'billing_entries',
  'billing_operations',
]);
module.exports = { walletSchema, walletTables };
