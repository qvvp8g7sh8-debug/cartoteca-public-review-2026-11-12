const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { canonicalSqliteSchema } = require('./catalog-canonical.cjs');
const { createCabinetIndexes } = require('../cabinet-indexes.cjs');
// Reproduce the existing automatic 0 -> 1 derived-index preparation without
// writing/copying the source database. Original encrypted base rows stay exact.
function prepareLegacyCabinetIndexes(store, root) {
  if (store.kind !== 'cabinet' || store.schemaVersion !== 0) return;
  const key = fs.readFileSync(path.join(root, store.relativeDirectory, 'encryption.key'));
  if (key.length !== 32) throw Error('Legacy cabinet encryption key is invalid.');
  const cipherKey = crypto.createSecretKey(key),
    db = new DatabaseSync(':memory:');
  try {
    const metadata = canonicalSqliteSchema({ kind: 'cabinet', version: 1 });
    for (const kind of ['table', 'index'])
      for (const object of metadata.objects)
        if (object.sql && object.type === kind) db.exec(object.sql);
    db.exec('PRAGMA user_version=1');
    const decode = (value) => {
      const bytes = Buffer.from(value),
        cipher = crypto.createDecipheriv('aes-256-gcm', cipherKey, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
      );
    };
    const encode = (value) => {
      const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv('aes-256-gcm', cipherKey, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    };
    const indexes = createCabinetIndexes({
      db,
      schemaVersion: 1,
      encode,
      decode,
      hash: (value) => crypto.createHmac('sha256', cipherKey).update(value).digest('hex'),
    });
    for (const row of store.sqlite
      .prepare('SELECT id,value FROM patients ORDER BY rowid')
      .iterate()) {
      const patient = decode(row.value);
      if (
        patient.id !== row.id ||
        !Array.isArray(patient.visits) ||
        !Array.isArray(patient.appointments)
      )
        throw Error('Invalid legacy patient for index preparation.');
      indexes.replace([patient], []);
    }
    const baseTables = new Set(Object.keys(store.source.tables));
    store.readers = Object.fromEntries(
      Object.keys(metadata.tables)
        .filter((name) => !baseTables.has(name))
        .map((name) => [name, db]),
    );
    store.derivedDatabase = db;
    store.originalSource = store.source;
    store.source = metadata;
    store.sourceSchemaVersion = 0;
    store.schemaVersion = 1;
    store.derivedIndexesPrepared = true;
  } catch (error) {
    db.close();
    throw error;
  }
}
module.exports = { prepareLegacyCabinetIndexes };
