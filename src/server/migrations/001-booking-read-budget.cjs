const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { safeTree, plainFile } = require('../infrastructure/backup/snapshot.cjs');
const { configureSqlite } = require('../infrastructure/sqlite-configuration.cjs');
const store = require('../infrastructure/booking-read-budget-store.cjs');

// Component schema v1, independent of notification schema17/18. Only a newly
// restored offline copy may be changed. Startup never creates or migrates it.
function migrateBookingReadBudget(directory, { rollback = false } = {}) {
  directory = path.resolve(directory);
  safeTree(directory);
  const marker = path.join(path.dirname(directory), '.restore-in-progress');
  plainFile(marker);
  if (fs.readFileSync(marker, 'utf8') !== 'booking-read-budget-preparation-v1')
    throw Error('Read budgets require an offline preparation copy');
  const platformFile = path.join(directory, 'platform.sqlite');
  plainFile(platformFile);
  const db = new DatabaseSync(platformFile);
  let budget;
  try {
    configureSqlite(db);
    const previous = store.registration(db);
    store.validateLegacyGuards(db, previous);
    store.validateFile(directory, previous);
    if (rollback ? previous?.mode !== 'isolated' : previous?.mode === 'isolated')
      throw Error('Unexpected source read-budget mode');
    const budgetFile = path.join(directory, store.filename);
    if (!previous) {
      const handle = fs.openSync(budgetFile, 'wx', 0o600);
      fs.closeSync(handle);
    }
    budget = new DatabaseSync(budgetFile);
    configureSqlite(budget);
    // Fixed lock order. There is no await or arbitrary callback in these transactions.
    db.exec('BEGIN IMMEDIATE');
    budget.exec('BEGIN IMMEDIATE');
    if (!previous) {
      db.exec(store.registrationTable);
      budget.exec(store.schema);
    }
    if (rollback) for (const guard of store.legacyGuards) db.exec('DROP TRIGGER ' + guard.name);
    const source = rollback ? budget : db,
      target = rollback ? db : budget;
    target.exec('DELETE FROM login_limits WHERE ' + store.readWhere);
    const put = target.prepare(
      'INSERT INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?)',
    );
    let count = 0;
    for (const row of source
      .prepare(
        'SELECT key,failures,window_started,blocked_until FROM login_limits WHERE ' +
          store.readWhere,
      )
      .iterate()) {
      put.run(row.key, row.failures, row.window_started, row.blocked_until);
      count++;
    }
    const id = rollback ? previous.store_id : randomUUID();
    if (!rollback) {
      budget
        .prepare(
          'INSERT INTO budget_meta(id,store_id,last_cleanup) VALUES(1,?,NULL) ON CONFLICT(id) DO UPDATE SET store_id=excluded.store_id,last_cleanup=NULL',
        )
        .run(id);
      db.exec('DELETE FROM login_limits WHERE ' + store.readWhere);
    }
    budget.exec('COMMIT');
    db.prepare(
      'INSERT INTO booking_read_budget_store(id,version,store_id,mode) VALUES(1,1,?,?) ON CONFLICT(id) DO UPDATE SET store_id=excluded.store_id,mode=excluded.mode',
    ).run(id, rollback ? 'legacy' : 'isolated');
    if (!rollback) for (const guard of store.legacyGuards) db.exec(guard.sql);
    db.exec('COMMIT');
    store.validateLegacyGuards(db, store.registration(db));
    store.validate(budget, store.registration(db));
    for (const connection of [db, budget])
      if (
        connection.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        connection.prepare('PRAGMA foreign_key_check').all().length
      )
        throw Error('Read-budget preparation integrity failed');
    return {
      componentVersion: 1,
      mode: rollback ? 'legacy' : 'isolated',
      countersPreserved: count,
    };
  } finally {
    if (budget?.isTransaction) budget.exec('ROLLBACK');
    if (db.isTransaction) db.exec('ROLLBACK');
    budget?.close();
    db.close();
  }
}
module.exports = { migrateBookingReadBudget };
