const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  safeTree,
  plainFile,
  readKey,
  openValue,
} = require('../infrastructure/backup/snapshot.cjs');
const { configureSqlite } = require('../infrastructure/sqlite-configuration.cjs');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { createPatientRecords } = require('../infrastructure/cabinet-records.cjs');
const { migrateCabinetRecords, rollbackCabinetRecords } = require('./002-cabinet-records.cjs');
const MARKER = '.cabinet-records-in-progress';
const sqlPath = (value) => "'" + value.replace(/'/g, "''") + "'";
function codec(key) {
  return {
    decode: (value) => JSON.parse(openValue(key, value).toString('utf8')),
    encode(value) {
      const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
  };
}
function checkedSnapshot(db, filename) {
  db.exec('VACUUM INTO ' + sqlPath(filename));
  fs.chmodSync(filename, 0o600);
  const copy = new DatabaseSync(filename, { readOnly: true });
  try {
    if (
      copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      copy.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Cabinet copy integrity failed');
  } finally {
    copy.close();
  }
  syncFile(filename);
}
function checkPhotos(db, directory, key) {
  const active = new Set(
    db
      .prepare('SELECT id FROM photos WHERE active=1')
      .all()
      .map((row) => row.id),
  );
  for (const id of active) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid cabinet photograph identifier');
    const file = path.join(directory, 'photos', id + '.enc');
    plainFile(file);
    openValue(key, fs.readFileSync(file));
  }
  const decode = codec(key).decode,
    records = createPatientRecords({ db, decode });
  for (const row of db.prepare('SELECT id,value FROM patients').iterate())
    for (const visit of (records ? records.hydrate([row])[0] : decode(row.value)).visits || [])
      for (const photo of visit.photos || []) {
        const id = photo.data?.match(/^\/api\/photos\/([a-f0-9]{32})$/)?.[1];
        if (!id || !active.has(id)) throw Error('Invalid cabinet photograph reference');
      }
}
function prepareCabinetRecordsCopy({ source, destination, rollback = false, offline = false }) {
  if (offline !== true) throw Error('Stop writers before preparing a cabinet records copy');
  source = path.resolve(source);
  destination = path.resolve(destination);
  const relative = path.relative(source, destination);
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw Error('Cabinet destination must be outside the source');
  safeTree(source);
  safeTree(path.dirname(destination));
  if (fs.existsSync(destination)) throw Error('Cabinet destination must not exist');
  if (fs.existsSync(path.join(source, MARKER))) throw Error('Incomplete cabinet records copy');
  const filename = path.join(source, 'cabinet.sqlite');
  plainFile(filename);
  const key = readKey(path.join(source, 'encryption.key'));
  const db = new DatabaseSync(filename),
    expected = rollback ? 2 : 1;
  let copy;
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== expected)
      throw Error('Unexpected source cabinet version');
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    fs.mkdirSync(destination, { mode: 0o700 });
    fs.writeFileSync(path.join(destination, MARKER), String(expected), { flag: 'wx', mode: 0o600 });
    syncFile(path.join(destination, MARKER));
    syncDirectory(destination);
    const reader = new DatabaseSync(filename, { readOnly: true });
    try {
      checkedSnapshot(reader, path.join(destination, 'cabinet.sqlite'));
    } finally {
      reader.close();
    }
    fs.copyFileSync(
      path.join(source, 'encryption.key'),
      path.join(destination, 'encryption.key'),
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(path.join(destination, 'encryption.key'), 0o600);
    syncFile(path.join(destination, 'encryption.key'));
    const photos = path.join(source, 'photos');
    safeTree(photos);
    fs.mkdirSync(path.join(destination, 'photos'), { mode: 0o700 });
    for (const entry of fs.readdirSync(photos, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{32}\.enc$/.test(entry.name))
        throw Error('Unsafe cabinet photograph');
      const original = path.join(photos, entry.name),
        target = path.join(destination, 'photos', entry.name);
      plainFile(original);
      fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, 0o600);
      syncFile(target);
    }
    db.exec('ROLLBACK');
    copy = new DatabaseSync(path.join(destination, 'cabinet.sqlite'));
    configureSqlite(copy);
    const backup = path.join(destination, 'migration-backups', 'before-records-002');
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    checkedSnapshot(copy, path.join(backup, 'cabinet.sqlite'));
    fs.copyFileSync(
      path.join(destination, 'encryption.key'),
      path.join(backup, 'encryption.key'),
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(path.join(backup, 'encryption.key'), 0o600);
    syncFile(path.join(backup, 'encryption.key'));
    syncDirectory(backup);
    (rollback ? rollbackCabinetRecords : migrateCabinetRecords)({ db: copy, ...codec(key) });
    if (
      copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      copy.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Prepared cabinet integrity failed');
    checkPhotos(copy, destination, key);
    copy.close();
    copy = null;
    syncFile(path.join(destination, 'cabinet.sqlite'));
    syncDirectory(path.join(destination, 'photos'));
    syncDirectory(destination);
    fs.unlinkSync(path.join(destination, MARKER));
    syncDirectory(destination);
    return {
      sourceVersion: expected,
      cabinetVersion: rollback ? 1 : 2,
      destination,
      sourceUnchanged: true,
    };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    copy?.close();
  }
}
module.exports = { prepareCabinetRecordsCopy, codec, checkPhotos };
