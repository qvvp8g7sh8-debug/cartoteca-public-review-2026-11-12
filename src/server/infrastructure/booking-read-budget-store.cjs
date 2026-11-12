const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { configureSqlite } = require('./sqlite-configuration.cjs');
const { createAsyncWriteLock } = require('./async-write-lock.cjs');

const filename = 'booking-read-budget.sqlite';
const readWhere =
  "(key >= 'booking-budget:read-address:' AND key < 'booking-budget:read-address;') OR (key >= 'booking-budget:site-read:' AND key < 'booking-budget:site-read;')";
const registrationTable = `CREATE TABLE booking_read_budget_store(
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1),
  store_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('isolated','legacy')))`;
const schema = `CREATE TABLE budget_meta(id INTEGER PRIMARY KEY CHECK(id=1),
  store_id TEXT NOT NULL, last_cleanup INTEGER);
  CREATE TABLE login_limits(key TEXT PRIMARY KEY, failures INTEGER NOT NULL CHECK(failures>=0),
  window_started INTEGER NOT NULL, blocked_until INTEGER NOT NULL);
  PRAGMA user_version=1;`;
// Old binaries do not know the registration table. Reject their legacy counter
// writes instead of silently giving them an empty, independent rate-limit budget.
const legacyGuards = ['INSERT', 'UPDATE'].map((operation) => ({
  name: 'booking_read_budget_legacy_' + operation.toLowerCase(),
  sql: `CREATE TRIGGER booking_read_budget_legacy_${operation.toLowerCase()}
    BEFORE ${operation} ON login_limits
    WHEN (SELECT mode FROM booking_read_budget_store WHERE id=1)='isolated'
      AND (${readWhere.replace(/\bkey\b/g, 'NEW.key')})
    BEGIN SELECT RAISE(ABORT, 'Legacy booking read-budget writes are disabled'); END`,
}));
function validateLegacyGuards(db, record) {
  for (const guard of legacyGuards) {
    const row = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
      .get(guard.name);
    if (record?.mode === 'isolated' ? row?.sql !== guard.sql : Boolean(row))
      throw Error('Booking read-budget legacy write guard mismatch');
  }
}

function registration(db) {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='booking_read_budget_store'",
      )
      .get()
  )
    return null;
  const rows = db.prepare('SELECT * FROM booking_read_budget_store').all();
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.id !== 1 ||
    row.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(row.store_id) ||
    !['isolated', 'legacy'].includes(row.mode)
  )
    throw Error('Invalid booking read-budget registration');
  return row;
}
function validate(db, record) {
  const rows = db.prepare('SELECT * FROM budget_meta').all();
  if (
    db.prepare('PRAGMA user_version').get().user_version !== 1 ||
    rows.length !== 1 ||
    rows[0].id !== 1 ||
    rows[0].store_id !== record.store_id ||
    !(rows[0].last_cleanup === null || Number.isSafeInteger(rows[0].last_cleanup))
  )
    throw Error('Booking read-budget identity mismatch');
  // Validate required columns without scanning counters on every process start.
  db.prepare('SELECT key,failures,window_started,blocked_until FROM login_limits LIMIT 0').all();
}
function validateFile(directory, record, { databaseOwner } = {}) {
  if (databaseOwner?.dialect === 'postgres') {
    const assets = require('./postgres/runtime.cjs');
    const marker = assets.readRuntime(path.dirname(directory));
    if (!record) {
      if (marker.budgetStoreId) throw Error('Unregistered PostgreSQL budget store.');
      return;
    }
    if (!marker.budgetStoreId) throw Error('PostgreSQL budget identity missing.');
    const budget = assets.openRuntimeStore(
      databaseOwner,
      path.dirname(directory),
      path.join(directory, 'booking-read-budget'),
      'budget',
    );
    try {
      validate(budget, record);
    } finally {
      budget.close();
    }
    return;
  }
  const file = path.join(directory, filename);
  if (!record) {
    if (fs.existsSync(file)) throw Error('Unregistered booking read-budget file');
    return;
  }
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    throw Error('Booking read-budget file missing; restore the complete prepared copy');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    validate(db, record);
  } finally {
    db.close();
  }
}
function assertMode(db, directory, enabled, options = {}) {
  const record = registration(db);
  validateLegacyGuards(db, record);
  validateFile(directory, record, options);
  if (Boolean(enabled) !== (record?.mode === 'isolated'))
    throw Error(
      'Booking read-budget mode differs from the prepared copy; switch all processes offline',
    );
  return record;
}
function openBookingReadBudget(db, directory, enabled, options = {}) {
  const record = assertMode(db, directory, enabled, options);
  if (!enabled) return null;
  const budget =
    options.databaseOwner?.dialect === 'postgres'
      ? require('./postgres/runtime.cjs').openRuntimeStore(
          options.databaseOwner,
          path.dirname(directory),
          path.join(directory, 'booking-read-budget'),
          'budget',
        )
      : new DatabaseSync(path.join(directory, filename));
  let writer;
  try {
    validate(budget, record);
    if (budget.dialect !== 'postgres') configureSqlite(budget);
    writer = createAsyncWriteLock(budget);
    const readCleanup = budget.prepare('SELECT last_cleanup FROM budget_meta WHERE id=1');
    const markCleanup = budget.prepare('UPDATE budget_meta SET last_cleanup=? WHERE id=1');
    return {
      db: budget,
      transaction(callback) {
        budget.exec('BEGIN IMMEDIATE');
        try {
          const value = callback();
          if (value && typeof value.then === 'function') throw Error('Async budget transaction');
          budget.exec('COMMIT');
          return value;
        } catch (error) {
          if (budget.isTransaction) budget.exec('ROLLBACK');
          throw error;
        }
      },
      asyncTransaction: writer.transaction,
      cleanup: { last: () => readCleanup.get().last_cleanup, mark: (now) => markCleanup.run(now) },
      stats: writer.stats,
      close() {
        writer.close();
        budget.close();
      },
    };
  } catch (error) {
    writer?.close();
    budget.close();
    throw error;
  }
}
module.exports = {
  filename,
  readWhere,
  schema,
  registrationTable,
  legacyGuards,
  validateLegacyGuards,
  registration,
  validate,
  validateFile,
  assertMode,
  openBookingReadBudget,
};
