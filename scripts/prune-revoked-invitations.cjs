const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  pruneRevokedInvitations,
} = require('../src/server/modules/organizations/invitation-revocation.cjs');

function options(args) {
  const flags = new Set(['--apply', '--dry-run', '--stopped']);
  const names = new Set(['--database', '--snapshot-directory', '--expected-count', '--organization']);
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if ((!flags.has(name) && !names.has(name)) || values.has(name))
      throw Error('Invalid explicit arguments.');
    if (flags.has(name)) values.set(name, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error('Missing explicit argument.');
      values.set(name, value);
    }
  }
  const database = values.get('--database');
  if (!database || !path.isAbsolute(database) || path.basename(database) !== 'platform.sqlite')
    throw Error('An explicit absolute platform database filename is required.');
  const apply = values.has('--apply');
  if (apply && values.has('--dry-run')) throw Error('Conflicting operation modes.');
  if (!apply && ['--stopped', '--expected-count', '--snapshot-directory'].some((n) => values.has(n)))
    throw Error('Apply arguments require explicit apply mode.');
  const organizationId = values.get('--organization') ?? null;
  if (organizationId !== null && !/^[a-zA-Z0-9_-]{1,120}$/.test(organizationId))
    throw Error('Invalid organization identifier.');
  const result = { database: path.resolve(database), apply, organizationId };
  if (!apply) return result;
  const count = values.get('--expected-count');
  const directory = values.get('--snapshot-directory');
  if (
    !values.has('--stopped') ||
    !/^(0|[1-9]\d*)$/.test(count || '') ||
    !Number.isSafeInteger(Number(count)) ||
    !directory ||
    !path.isAbsolute(directory)
  )
    throw Error('Apply requires stopped writers, an exact count and a new snapshot directory.');
  return { ...result, expectedCount: Number(count), snapshotDirectory: path.resolve(directory) };
}

function plainDirectory(directory) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    if (!fs.lstatSync(current).isDirectory()) throw Error('Directory must not contain links.');
    if (path.dirname(current) === current) return;
  }
}
function plainDatabase(filename) {
  plainDirectory(path.dirname(filename));
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = filename + suffix;
    if ((suffix === '' || fs.existsSync(file)) && !fs.lstatSync(file).isFile())
      throw Error('Database must not contain links.');
  }
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}
function assertPlatform(db) {
  for (const name of ['accounts', 'organizations', 'memberships', 'platform_audit']) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name))
      throw Error('Not an existing platform database.');
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(email_invitations)').all();
  if (
    !foreignKeys.some(
      (key) =>
        key.table === 'invitations' &&
        key.from === 'token_hash' &&
        key.to === 'token_hash' &&
        key.on_delete === 'CASCADE',
    )
  )
    throw Error('Invitation cascade is required.');
  // Preparation validates the invitation columns without reading encrypted payloads.
  matchingCount(db, null);
}
function matchingCount(db, organizationId) {
  const statement = db.prepare(`SELECT COUNT(*) matched FROM invitations i
    WHERE i.used_at IS NULL${organizationId === null ? '' : ' AND i.organization_id=?'}
    AND EXISTS (SELECT 1 FROM email_invitations e WHERE e.status='revoked'
      AND e.token_hash=i.token_hash AND e.organization_id=i.organization_id)`);
  return Number((organizationId === null ? statement.get() : statement.get(organizationId)).matched);
}
function fileDigest(filename) {
  const digest = crypto.createHash('sha256');
  const file = fs.openSync(filename, 'r');
  try {
    const bytes = Buffer.allocUnsafe(65536);
    let length;
    while ((length = fs.readSync(file, bytes, 0, bytes.length, null)))
      digest.update(bytes.subarray(0, length));
    return digest.digest('hex');
  } finally {
    fs.closeSync(file);
  }
}
function snapshot({ database, snapshotDirectory, organizationId }, matched) {
  const sourceDirectory = path.dirname(database);
  if (within(sourceDirectory, snapshotDirectory) || within(snapshotDirectory, sourceDirectory))
    throw Error('Snapshot must be separate from the platform directory.');
  plainDirectory(path.dirname(snapshotDirectory));
  // Deliberately not recursive: an existing directory can never be reused or overwritten.
  fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
  const filename = path.join(snapshotDirectory, 'platform.sqlite');
  const reader = new DatabaseSync(database, { readOnly: true });
  try {
    reader.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'");
  } finally {
    reader.close();
  }
  fs.chmodSync(filename, 0o600);
  const copy = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').all();
    if (
      integrity.length !== 1 ||
      integrity[0].integrity_check !== 'ok' ||
      copy.prepare('PRAGMA foreign_key_check').all().length ||
      matchingCount(copy, organizationId) !== matched
    )
      throw Error('Snapshot verification failed.');
  } finally {
    copy.close();
  }
  fs.writeFileSync(
    path.join(snapshotDirectory, 'manifest.json'),
    JSON.stringify({ version: 1, createdAt: Date.now(), matched, sha256: fileDigest(filename) }),
    { flag: 'wx', mode: 0o600 },
  );
  // No platform key is opened or copied. Recovery needs the current key kept in place.
}

function runCleanup(value) {
  plainDatabase(value.database);
  const db = new DatabaseSync(value.database, { readOnly: !value.apply, timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (!value.apply) db.exec('PRAGMA query_only=ON;');
    assertPlatform(db);
    if (!value.apply) return { matched: matchingCount(db, value.organizationId), deleted: 0 };
    db.exec('BEGIN IMMEDIATE');
    const matched = matchingCount(db, value.organizationId);
    if (matched !== value.expectedCount) throw Error('Expected count changed.');
    snapshot(value, matched);
    if (matchingCount(db, value.organizationId) !== matched) throw Error('Invitation set changed.');
    const result = pruneRevokedInvitations(
      {
        db,
        transaction: (callback) => callback(),
        audit: (event, actorId, organizationId, detail) => {
          db.prepare(
            'INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,?,?)',
          ).run(Date.now(), actorId, organizationId, event, JSON.stringify(detail));
        },
      },
      { organizationId: value.organizationId },
    );
    if (result.deleted !== matched || matchingCount(db, value.organizationId) !== 0)
      throw Error('Unexpected cleanup result.');
    db.exec('COMMIT');
    return { matched, deleted: result.deleted };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runCleanup(options(process.argv.slice(2)))));
  } catch {
    // Never print database paths, SQLite errors, invitation identifiers or payloads.
    console.error('Очистка приглашений не завершена. Проверьте параметры и сохраните созданную копию.');
    process.exitCode = 1;
  }
}
module.exports = { options, runCleanup };
