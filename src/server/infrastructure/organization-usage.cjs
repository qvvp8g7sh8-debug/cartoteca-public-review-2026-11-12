const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Read-only technical aggregates. No key, ciphertext, patient name or photo is read.
function organizationUsage(dataDirectory, organization, { databaseOwner } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(organization.id)) return { available: false };
  const filename = organization.legacyData
    ? path.join(dataDirectory, 'cabinet.sqlite')
    : path.join(dataDirectory, 'tenants', organization.id, 'cabinet.sqlite');
  if (!databaseOwner && !fs.existsSync(filename))
    return { available: true, patients: 0, photos: 0, initialized: false };
  let db;
  try {
    db =
      databaseOwner?.dialect === 'postgres'
        ? require('./postgres/runtime.cjs').openRuntimeStore(
            databaseOwner,
            dataDirectory,
            path.dirname(filename),
            'cabinet',
            { organizationId: organization.id, allowCreate: false },
          )
        : new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000;');
    const patients = db.prepare('SELECT count(*) n FROM patients').get().n;
    const photos = db
      .prepare('SELECT COALESCE(SUM(photo_count),0) n FROM cabinet_patient_counts')
      .get().n;
    return { available: true, patients, photos, initialized: true };
  } catch (error) {
    if (databaseOwner?.dialect === 'postgres' && error.code === 'POSTGRES_STORE_MISSING')
      return { available: true, patients: 0, photos: 0, initialized: false };
    return { available: false };
  } finally {
    db?.close();
  }
}
module.exports = { organizationUsage };
