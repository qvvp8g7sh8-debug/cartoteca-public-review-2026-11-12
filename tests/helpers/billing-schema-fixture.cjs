const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { walletSchema } = require('../../src/server/modules/billing/wallet-schema.cjs');
const {
  serviceConnectionSchema,
} = require('../../src/server/modules/billing/entitlements-schema.cjs');
const { packageSchema } = require('../../src/server/modules/billing/package-schema.cjs');
const { paymentSchema } = require('../../src/server/modules/billing/payment-schema.cjs');
const { multiServiceSchema } = require('../../src/server/modules/billing/multi-service-schema.cjs');

const baseSchema = walletSchema + serviceConnectionSchema + packageSchema + paymentSchema;

function changeTable(sql, table, change) {
  const pattern = new RegExp('CREATE TABLE ' + table + '\\([\\s\\S]*?\\);');
  const match = sql.match(pattern);
  assert.ok(match, 'Fixture table exists: ' + table);
  const modified = change(match[0]);
  assert.notEqual(modified, match[0], 'Fixture actually changes ' + table);
  return sql.replace(pattern, () => modified);
}

function withoutPrimaryKey(sql) {
  return /,\s*PRIMARY KEY\(/.test(sql)
    ? sql.replace(/,\s*PRIMARY KEY\([^)]*\)/, '')
    : sql.replace(/\s+PRIMARY KEY/, '');
}

// Every database is synthetic and memory-only. No store opener, runtime data or network.
function fixture(t, { version = 19, changeBase = (sql) => sql, changeMulti = (sql) => sql } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE accounts(id TEXT PRIMARY KEY);
CREATE TABLE organizations(id TEXT PRIMARY KEY);
INSERT INTO accounts VALUES('synthetic-account');
INSERT INTO organizations VALUES('synthetic-organization');`);
  db.exec(changeBase(baseSchema));
  if (version === 20) db.exec(changeMulti(multiServiceSchema));
  db.exec('PRAGMA user_version=' + version);
  return db;
}

function snapshot(db) {
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all();
  return {
    schema,
    rows: schema
      .filter((row) => row.type === 'table')
      .map((row) => [row.name, db.prepare('SELECT * FROM "' + row.name + '"').all()]),
    version: db.prepare('PRAGMA user_version').get(),
    schemaVersion: db.prepare('PRAGMA schema_version').get(),
    changes: db.prepare('SELECT total_changes() AS total').get(),
  };
}

function validateReadOnly(db, validate, { rejects = true } = {}) {
  db.exec('PRAGMA query_only=ON');
  const before = snapshot(db);
  if (rejects) assert.throws(() => validate(db), /schema|constraint|index/i);
  else assert.doesNotThrow(() => validate(db));
  assert.deepEqual(snapshot(db), before, 'Validation preserves schema, data and version');
  assert.equal(db.prepare('PRAGMA query_only').get().query_only, 1);
}

module.exports = { fixture, changeTable, withoutPrimaryKey, validateReadOnly };
