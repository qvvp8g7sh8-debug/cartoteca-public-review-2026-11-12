const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function installProfile(config) {
  const platformStoreId = randomUUID(),
    rootCabinetStoreId = randomUUID();
  const marker = {
    version: 1,
    backend: 'postgres',
    migrationId: randomUUID(),
    platformStoreId,
    rootCabinetStoreId,
    notificationSchema: 11,
    cabinetSchema: 1,
    budgetStoreId: null,
    cabinetTemplates: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
    stores: [
      {
        kind: 'platform',
        storeId: platformStoreId,
        organizationId: null,
        relativeDirectory: 'platform',
        schemaVersion: 11,
      },
      {
        kind: 'cabinet',
        storeId: rootCabinetStoreId,
        organizationId: null,
        relativeDirectory: '.',
        schemaVersion: 1,
      },
    ],
  };
  fs.mkdirSync(config.source, { recursive: true });
  const filename = path.join(config.source, 'postgresql-runtime.json');
  fs.writeFileSync(filename, JSON.stringify(marker));
  Object.assign(config, {
    storageBackend: 'postgres',
    applicationRole: 'synthetic_app',
    connection: {
      host: '127.0.0.1',
      port: 5432,
      database: 'synthetic',
      user: 'synthetic_owner',
      password: 'synthetic-operator-password',
    },
    connectionOptions: { profile: 'local' },
  });
  return { marker, filename };
}
module.exports = { installProfile };
