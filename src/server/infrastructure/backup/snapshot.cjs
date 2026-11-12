const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { assertNoOrganizationSwitch } = require('./organization-guard.cjs');
const readBudget = require('../booking-read-budget-store.cjs');
const { stateName, readStateBytes } = require('../../modules/assistant/access/store.cjs');
function plainFile(file) {
  if (!fs.lstatSync(file).isFile()) throw Error('Backup source must be a regular file.');
}
function safeTree(directory) {
  let current = path.resolve(directory);
  while (true) {
    if (fs.existsSync(current) && !fs.lstatSync(current).isDirectory())
      throw Error('Backup path contains a link or non-directory.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function openValue(key, blob) {
  const value = Buffer.from(blob),
    cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  cipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]);
}
function readKey(file) {
  safeTree(path.dirname(file));
  plainFile(file);
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw Error('Backup source key is invalid.');
  return key;
}
function sqlPath(file) {
  return "'" + file.replace(/'/g, "''") + "'";
}
function cabinetPaths(source, platform) {
  const roots = new Set();
  if (fs.existsSync(path.join(source, 'cabinet.sqlite'))) roots.add('');
  const tenantRoot = path.join(source, 'tenants');
  if (fs.existsSync(tenantRoot)) {
    safeTree(tenantRoot);
    for (const entry of fs.readdirSync(tenantRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,120}$/.test(entry.name))
        throw Error('Unsafe tenant directory.');
      roots.add('tenants/' + entry.name);
    }
  }
  const key = readKey(path.join(source, 'platform', 'platform.key')),
    organizations = [];
  for (const row of platform.prepare('SELECT id,value FROM organizations').iterate()) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(row.id)) throw Error('Unsafe organization identifier.');
    const organization = JSON.parse(openValue(key, row.value).toString('utf8'));
    const root = organization.legacyData ? '' : 'tenants/' + row.id;
    if (organization.legacyData && !roots.has(''))
      throw Error('Legacy organization database is missing.');
    // Registered organizations without a first cabinet read legitimately have no tenant DB yet.
    if (fs.existsSync(path.join(source, root))) roots.add(root);
    organizations.push({ id: row.id, root, initialized: roots.has(root) });
  }
  return { cabinets: [...roots].sort(), organizations };
}
function snapshotDatabases(source, stage) {
  source = path.resolve(source);
  assertNoOrganizationSwitch(source);
  safeTree(source);
  safeTree(path.join(source, 'platform'));
  const platformFile = path.join(source, 'platform', 'platform.sqlite');
  plainFile(platformFile);
  const platform = new DatabaseSync(platformFile),
    locks = [],
    files = [];
  let budget;
  const snapshot = (relative, filename, keyName, connection) => {
    const original = path.join(source, relative),
      target = path.join(stage, relative);
    safeTree(original);
    plainFile(path.join(original, filename));
    if (keyName) readKey(path.join(original, keyName));
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const reader = new DatabaseSync(path.join(original, filename), { readOnly: true });
    try {
      reader.exec('PRAGMA busy_timeout=30000');
      reader.exec('VACUUM INTO ' + sqlPath(path.join(target, filename)));
    } finally {
      reader.close();
    }
    files.push([relative ? relative + '/' : '', filename].join(''));
    if (keyName) {
      fs.copyFileSync(
        path.join(original, keyName),
        path.join(target, keyName),
        fs.constants.COPYFILE_EXCL,
      );
      files.push([relative ? relative + '/' : '', keyName].join(''));
    }
    if (filename === 'cabinet.sqlite') {
      safeTree(path.join(original, 'photos'));
      for (const { id } of connection.prepare('SELECT id FROM photos WHERE active=1').iterate()) {
        if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid photo identifier.');
        const name = (relative ? relative + '/' : '') + 'photos/' + id + '.enc',
          originalFile = path.join(source, name),
          targetFile = path.join(stage, name);
        plainFile(originalFile);
        fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
        // Photo objects are immutable. Pin their bytes before releasing database locks:
        // later orphan cleanup cannot remove a hardlinked snapshot. Other volumes copy.
        try {
          fs.linkSync(originalFile, targetFile);
        } catch (error) {
          if (!['EXDEV', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
          fs.copyFileSync(originalFile, targetFile, fs.constants.COPYFILE_EXCL);
        }
        files.push(name);
      }
    }
  };
  try {
    platform.exec('PRAGMA busy_timeout=30000; BEGIN IMMEDIATE');
    const record = readBudget.registration(platform),
      platformDirectory = path.join(source, 'platform');
    readBudget.validateFile(platformDirectory, record);
    readBudget.validateLegacyGuards(platform, record);
    if (record) {
      budget = new DatabaseSync(path.join(platformDirectory, readBudget.filename));
      // Runtime public-read budgets never acquire a platform lock. Preserve
      // platform -> budget -> tenant order and keep all snapshots coherent.
      budget.exec('PRAGMA busy_timeout=30000; BEGIN IMMEDIATE');
      readBudget.validate(budget, record);
    }
    const { cabinets, organizations } = cabinetPaths(source, platform);
    // Same lock order as live v2 writes. Synchronous only: no await under SQLite locks.
    // Cabinet locks also exclude legacy/local maintenance writers during the snapshot.
    for (const relative of cabinets) {
      const filename = path.join(source, relative, 'cabinet.sqlite');
      safeTree(path.dirname(filename));
      plainFile(filename);
      const db = new DatabaseSync(filename);
      locks.push(db);
      db.exec('PRAGMA busy_timeout=30000; BEGIN IMMEDIATE');
    }
    snapshot('platform', 'platform.sqlite', 'platform.key', platform);
    // Assistant writers also hold the platform lock; copy the atomic encrypted
    // state in the same snapshot, excluding transient locks and temp files.
    const assistantFile = path.join(platformDirectory, stateName);
    if (fs.existsSync(assistantFile)) plainFile(assistantFile);
    const assistantBytes = readStateBytes(platformDirectory);
    if (assistantBytes) {
      fs.writeFileSync(path.join(stage, 'platform', stateName), assistantBytes, {
        flag: 'wx',
        mode: 0o600,
      });
      files.push('platform/' + stateName);
    }
    if (budget) snapshot('platform', readBudget.filename, null, budget);
    cabinets.forEach((relative, i) =>
      snapshot(relative, 'cabinet.sqlite', 'encryption.key', locks[i]),
    );
    return { cabinets, organizations, files };
  } finally {
    for (const db of locks.reverse()) {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
    }
    if (budget) {
      if (budget.isTransaction) budget.exec('ROLLBACK');
      budget.close();
    }
    if (platform.isTransaction) platform.exec('ROLLBACK');
    platform.close();
  }
}
module.exports = { snapshotDatabases, cabinetPaths, openValue, readKey, plainFile, safeTree };
