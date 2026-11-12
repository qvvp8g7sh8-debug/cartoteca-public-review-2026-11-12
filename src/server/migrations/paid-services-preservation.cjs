const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  quote,
  dataInventory,
  inventoryFingerprint,
} = require('../infrastructure/backup/organization-inventory.cjs');
const budget = require('../infrastructure/booking-read-budget-store.cjs');
const links = require('../infrastructure/booking-public-links-schema.cjs');
const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify(value, (_, item) =>
        typeof item === 'bigint' ? ['integer', item.toString()] : item,
      ),
    )
    .digest('hex');
function platformProof(directory, names) {
  const db = new DatabaseSync(path.join(directory, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    db.exec('BEGIN');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (!names && version !== 17) throw Error('Paid services production source must be schema17.');
    const registration = budget.assertMode(db, path.join(directory, 'platform'), true);
    if (registration?.version !== 1 || links.validate(db)?.version !== 1)
      throw Error('Prepared read-budget1 and public-links1 components are required.');
    const tables =
      names ||
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name);
    const records = tables.map((name) => {
      const statement = db.prepare('SELECT * FROM ' + quote(name));
      statement.setReadBigInts(true);
      const rows = [];
      for (const row of statement.iterate()) rows.push(hash(row));
      rows.sort();
      return { name, rows: rows.length, sha256: hash(rows) };
    });
    const mappings = db.prepare('SELECT * FROM booking_public_links ORDER BY code').all();
    return {
      version,
      tables: records,
      readBudgetStoreId: registration.store_id,
      publicLinksFingerprint: hash(mappings),
      originalTableFingerprint: hash(records),
    };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
function productionProof(directory) {
  const inventory = dataInventory(directory),
    platform = platformProof(directory);
  return {
    platform,
    inventory,
    sourceFingerprint: inventoryFingerprint(inventory),
    preservedFiles: inventory.filter((row) => row.name !== 'platform/platform.sqlite'),
  };
}
function verifyPreserved(source, destination, before) {
  if (inventoryFingerprint(dataInventory(source)) !== before.sourceFingerprint)
    throw Error('Original production data changed while preparing its copy.');
  const after = platformProof(
    destination,
    before.platform.tables.map((row) => row.name),
  );
  if (
    after.version !== 19 ||
    hash(after.tables) !== hash(before.platform.tables) ||
    after.readBudgetStoreId !== before.platform.readBudgetStoreId ||
    after.publicLinksFingerprint !== before.platform.publicLinksFingerprint ||
    hash(dataInventory(destination).filter((row) => row.name !== 'platform/platform.sqlite')) !==
      hash(before.preservedFiles)
  )
    throw Error('Original records, files, keys or component identities were not preserved.');
  return {
    sourceSha256: before.sourceFingerprint,
    originalTables: after.tables.length,
    originalTableSha256: after.originalTableFingerprint,
    files: before.preservedFiles.length,
  };
}
module.exports = { productionProof, verifyPreserved };
