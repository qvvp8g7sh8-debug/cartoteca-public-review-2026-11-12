const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { safeTree, plainFile } = require('./snapshot.cjs');

function createBackupJournal(directory, { clock = Date.now, leaseMilliseconds = 7200000 } = {}) {
  safeTree(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'backup-journal.sqlite');
  if (fs.existsSync(file)) plainFile(file);
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, destination TEXT NOT NULL, slot TEXT,
      started INTEGER NOT NULL, finished INTEGER, state TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS completed_recovery_slot ON jobs(destination,slot)
      WHERE state IN ('protected','local_only') AND slot IS NOT NULL;
    CREATE INDEX IF NOT EXISTS jobs_destination_order ON jobs(destination,started DESC,id DESC);`);
  let held = null;
  function guarded() {
    const lease = db.prepare('SELECT * FROM lease WHERE id=1').get();
    if (!held || lease?.token !== held.token || lease.expires <= clock())
      throw Error('BACKUP_LEASE_LOST');
    return lease;
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function begin(destination, slot = null) {
    return transaction(() => {
      const lease = db.prepare('SELECT * FROM lease WHERE id=1').get();
      if (lease?.expires > clock()) throw Error('BACKUP_BUSY');
      if (
        slot &&
        db
          .prepare(
            "SELECT id FROM jobs WHERE destination=? AND slot=? AND state IN ('protected','local_only')",
          )
          .get(destination, slot)
      )
        return null;
      db.prepare("UPDATE jobs SET state='interrupted',finished=? WHERE finished IS NULL").run(
        clock(),
      );
      held = { token: crypto.randomUUID(), id: crypto.randomUUID() };
      db.prepare('INSERT OR REPLACE INTO lease VALUES(1,?,?)').run(
        held.token,
        clock() + leaseMilliseconds,
      );
      db.prepare('INSERT INTO jobs VALUES(?,?,?,?,NULL,?,?)').run(
        held.id,
        destination,
        slot,
        clock(),
        'preparing',
        '{}',
      );
      return held.id;
    });
  }
  function update(state, changes = {}, finish = false) {
    return transaction(() => {
      guarded();
      const previous = db.prepare('SELECT detail FROM jobs WHERE id=?').get(held.id);
      const detail = { ...JSON.parse(previous.detail), ...changes };
      db.prepare('UPDATE jobs SET state=?,detail=?,finished=? WHERE id=?').run(
        state,
        JSON.stringify(detail),
        finish ? clock() : null,
        held.id,
      );
      if (finish) {
        db.prepare('DELETE FROM lease WHERE id=1 AND token=?').run(held.token);
        held = null;
      }
    });
  }
  function heartbeat() {
    transaction(() => {
      guarded();
      db.prepare('UPDATE lease SET expires=? WHERE token=?').run(
        clock() + leaseMilliseconds,
        held.token,
      );
    });
  }
  function rows(destination) {
    return db
      .prepare('SELECT * FROM jobs WHERE destination=? ORDER BY started DESC,id DESC')
      .all(destination)
      .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
  }
  function statusRows(destination) {
    const selected = new Map();
    const remember = (row) => {
      if (row && !selected.has(row.id))
        selected.set(row.id, { ...row, detail: JSON.parse(row.detail) });
    };
    const ordered = 'FROM jobs WHERE destination=? ORDER BY started DESC,id DESC';
    for (const row of db.prepare('SELECT * ' + ordered + ' LIMIT 10').all(destination))
      remember(row);
    // A missing/pruned local archive cannot be reported as an available recovery point.
    // Iterate only until the first existing file, instead of decoding every historical job.
    for (const row of db
      .prepare(
        "SELECT * FROM jobs WHERE destination=? AND json_extract(detail,'$.localAt') IS NOT NULL ORDER BY started DESC,id DESC",
      )
      .iterate(destination)) {
      const detail = JSON.parse(row.detail);
      if (detail.file && fs.existsSync(detail.file)) {
        remember(row);
        break;
      }
    }
    for (const field of ['remoteAt', 'drillAt']) {
      remember(
        db
          .prepare(
            "SELECT * FROM jobs WHERE destination=? AND json_extract(detail,'$." +
              field +
              "') IS NOT NULL ORDER BY started DESC,id DESC LIMIT 1",
          )
          .get(destination),
      );
    }
    return [...selected.values()].sort(
      (left, right) => right.started - left.started || right.id.localeCompare(left.id),
    );
  }
  return { begin, update, heartbeat, rows, statusRows, close: () => db.close() };
}
module.exports = { createBackupJournal };
