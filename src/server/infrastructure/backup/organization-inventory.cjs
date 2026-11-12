const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { safeTree, plainFile } = require('./snapshot.cjs');
const { syncFile, syncDirectory } = require('./durable.cjs');
const readBudget = require('../booking-read-budget-store.cjs');
const { stateName } = require('../../modules/assistant/access/store.cjs');
function assistantFiles(directory) {
  const file = path.join(directory, stateName);
  if (!fs.existsSync(file)) return [];
  plainFile(file);
  return [stateName];
}

const quote = (name) => '"' + name.replace(/"/g, '""') + '"';
function budgetFiles(directory) {
  const db = new DatabaseSync(path.join(directory, 'platform.sqlite'), { readOnly: true });
  try {
    const record = readBudget.registration(db);
    readBudget.validateFile(directory, record);
    return record ? [readBudget.filename] : [];
  } finally {
    db.close();
  }
}
function tables(db) {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
}
function columns(db, table) {
  return db
    .prepare('PRAGMA table_info(' + quote(table) + ')')
    .all()
    .map((row) => row.name);
}
function feed(hash, value) {
  const bytes =
    Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(JSON.stringify(value));
  hash.update(String(bytes.length) + ':');
  hash.update(bytes);
}
function databaseFingerprint(filename) {
  plainFile(filename);
  const db = new DatabaseSync(filename, { readOnly: true }),
    hash = crypto.createHash('sha256');
  try {
    db.exec('BEGIN');
    feed(hash, db.prepare('PRAGMA user_version').get());
    for (const table of tables(db)) {
      feed(hash, table);
      const names = columns(db, table.name),
        list = names.map(quote).join(',');
      for (const row of db
        .prepare(`SELECT ${list} FROM ${quote(table.name)} ORDER BY ${list}`)
        .iterate()) {
        for (const name of names) feed(hash, row[name]);
      }
    }
    return hash.digest('hex');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
function dataInventory(directory) {
  directory = path.resolve(directory);
  safeTree(directory);
  const roots = [];
  if (fs.existsSync(path.join(directory, 'cabinet.sqlite'))) roots.push('');
  const tenants = path.join(directory, 'tenants');
  if (fs.existsSync(tenants)) {
    safeTree(tenants);
    for (const entry of fs.readdirSync(tenants, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,120}$/.test(entry.name))
        throw Error('Unsafe organization directory.');
      roots.push('tenants/' + entry.name);
    }
  }
  const files = ['platform/platform.sqlite', 'platform/platform.key'];
  files.push(...budgetFiles(path.join(directory, 'platform')).map((name) => 'platform/' + name));
  files.push(...assistantFiles(path.join(directory, 'platform')).map((name) => 'platform/' + name));
  for (const root of roots.sort()) {
    const prefix = root ? root + '/' : '';
    files.push(prefix + 'cabinet.sqlite', prefix + 'encryption.key');
    const photoDir = path.join(directory, root, 'photos');
    if (!fs.existsSync(photoDir)) continue;
    safeTree(photoDir);
    // Only referenced active photos participate: orphan/inactive files are not restored.
    const db = new DatabaseSync(path.join(directory, root, 'cabinet.sqlite'), { readOnly: true });
    try {
      for (const row of db.prepare('SELECT id FROM photos WHERE active=1 ORDER BY id').iterate()) {
        if (!/^[a-f0-9]{32}$/.test(row.id)) throw Error('Unsafe photo identifier.');
        files.push(prefix + 'photos/' + row.id + '.enc');
      }
    } finally {
      db.close();
    }
  }
  return files.sort().map((name) => {
    const file = path.join(directory, name);
    safeTree(path.dirname(file));
    plainFile(file);
    return {
      name,
      sha256: name.endsWith('.sqlite')
        ? databaseFingerprint(file)
        : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    };
  });
}
function inventoryFingerprint(inventory) {
  return crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}
function disjoint(...directories) {
  const resolved = directories.map((directory) => path.resolve(directory));
  for (let i = 0; i < resolved.length; i++)
    for (let j = i + 1; j < resolved.length; j++) {
      for (const [parent, child] of [
        [resolved[i], resolved[j]],
        [resolved[j], resolved[i]],
      ]) {
        const relative = path.relative(parent, child);
        if (
          !relative ||
          (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
        )
          throw Error('Restore directories must be independent.');
      }
    }
  resolved.forEach(safeTree);
}
function componentFingerprint(directory, kind) {
  safeTree(directory);
  const database = kind === 'platform' ? 'platform.sqlite' : 'cabinet.sqlite';
  const key = kind === 'platform' ? 'platform.key' : 'encryption.key';
  const files = [database, key];
  if (kind === 'platform') files.push(...budgetFiles(directory), ...assistantFiles(directory));
  if (kind !== 'platform') {
    const db = new DatabaseSync(path.join(directory, database), { readOnly: true });
    try {
      for (const row of db.prepare('SELECT id FROM photos WHERE active=1 ORDER BY id').iterate()) {
        if (!/^[a-f0-9]{32}$/.test(row.id)) throw Error('Unsafe photograph identifier.');
        files.push('photos/' + row.id + '.enc');
      }
    } finally {
      db.close();
    }
  }
  return inventoryFingerprint(
    files.sort().map((name) => {
      const filename = path.join(directory, name);
      safeTree(path.dirname(filename));
      plainFile(filename);
      return {
        name,
        sha256: name.endsWith('.sqlite')
          ? databaseFingerprint(filename)
          : crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
      };
    }),
  );
}
function flushTree(directory) {
  safeTree(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) flushTree(filename);
    else {
      plainFile(filename);
      syncFile(filename);
    }
  }
  syncDirectory(directory);
}
module.exports = {
  quote,
  tables,
  columns,
  dataInventory,
  inventoryFingerprint,
  componentFingerprint,
  disjoint,
  flushTree,
};
