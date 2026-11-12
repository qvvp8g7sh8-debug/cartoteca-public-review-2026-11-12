const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fail } = require('../../shared/errors.cjs');

const filename = 'assistant-executor-lock.sqlite';
const APPLICATION_ID = 0x43415050;
const unavailable = () =>
  fail(503, 'Голосовой помощник занят другим процессом или временно недоступен.');
function plainFile(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw unavailable();
  return stat;
}
const sameFile = (first, second) => first.dev === second.dev && first.ino === second.ino;

// Disposable OS coordination only. This file belongs to the shared DATA ROOT,
// outside platform/ (which an offline organization restore may replace).
// BEGIN EXCLUSIVE lasts for this connection's lifetime. The OS releases it on
// process death: no lease expiry, heartbeat, timer, draft or clinical data.
// NEVER unlink this file: a replacement inode would split ownership.
function acquireAssistantExecutorAuthority(dataDir) {
  let db,
    descriptor,
    owned,
    directory,
    lock,
    closed = false;
  function close() {
    if (closed) return;
    closed = true;
    try {
      if (db?.isOpen) {
        try {
          if (db.isTransaction) db.exec('ROLLBACK');
        } finally {
          db.close();
        }
      }
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        descriptor = undefined;
      }
    }
  }
  function assertOwned() {
    try {
      if (closed || !db?.isOpen || !db.isTransaction) throw unavailable();
      if (fs.realpathSync(dataDir) !== directory || !sameFile(owned, plainFile(lock)))
        throw unavailable();
      if (!sameFile(owned, fs.fstatSync(descriptor, { bigint: true }))) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  try {
    directory = fs.realpathSync(dataDir);
    if (!fs.lstatSync(directory).isDirectory()) throw unavailable();
    lock = path.join(directory, filename);
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      plainFile(lock);
      descriptor = fs.openSync(lock, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    }
    owned = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFile(owned, plainFile(lock))) throw unavailable();
    // SQLite may recover its own hot rollback journal after interrupted startup.
    // Never follow a sidecar link; WAL is not part of this locking protocol.
    if (fs.lstatSync(lock + '-journal', { throwIfNoEntry: false })) plainFile(lock + '-journal');
    for (const suffix of ['-wal', '-shm'])
      if (fs.lstatSync(lock + suffix, { throwIfNoEntry: false })) throw unavailable();
    db = new DatabaseSync(lock, { timeout: 0 });
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw unavailable();
    db.exec('BEGIN EXCLUSIVE');
    const application = db.prepare('PRAGMA application_id').get().application_id;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (
      application === 0 &&
      version === 0 &&
      db.prepare('SELECT name FROM sqlite_schema').all().length === 0
    ) {
      // Initialize a valid empty database ONCE. Keeping a zero-byte database in
      // an uncommitted first write would leave a journal after every crash.
      db.exec('PRAGMA application_id=' + APPLICATION_ID + '; PRAGMA user_version=1; COMMIT');
      db.exec('BEGIN EXCLUSIVE');
    } else if (application !== APPLICATION_ID || version !== 1) throw unavailable();
    assertOwned();
    return Object.freeze({ assertOwned, close });
  } catch {
    try {
      close();
    } catch {
      /* Retain the original safe admission failure. */
    }
    throw unavailable();
  }
}
module.exports = { acquireAssistantExecutorAuthority, filename };
