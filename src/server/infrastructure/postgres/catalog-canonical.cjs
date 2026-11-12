const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describeSqliteSchema, digest } = require('./catalog-sqlite.cjs');
const cache = new Map();
const upgrades = [
  [12, '012-max-connections', 'migrateMaxConnections'],
  [13, '013-notification-queue', 'migrateNotificationQueue'],
  [14, '014-notification-channels', 'migrateNotificationChannels'],
  [15, '015-max-inbox', 'migrateMaxInbox'],
  [16, '016-staff-max', 'migrateStaffMax'],
  [17, '017-staff-push', 'migrateStaffPush'],
  [18, '018-notification-schedule', 'migrateNotificationSchedule'],
  [19, '019-paid-services', 'migratePaidServices'],
  [20, '020-multi-service-billing', 'migrateMultiServiceBilling'],
];
// Empty temporary SQLite is the source of truth for original migration/catalog
// contracts. No configured DATA path or working database is opened here.
function canonicalSqliteSchema({
  kind,
  version = kind === 'platform' ? 19 : kind === 'cabinet' ? 2 : 1,
  components = {},
} = {}) {
  if (
    !['platform', 'cabinet', 'budget'].includes(kind) ||
    !(
      kind === 'platform'
        ? [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
        : kind === 'cabinet'
          ? [0, 1, 2]
          : [1]
    ).includes(version) ||
    Object.keys(components).some(
      (key) =>
        ![
          'patientHistory',
          'assistantRows',
          'notificationMaintenance',
          'bookingPublicLinks',
          'isolatedReadBudgets',
        ].includes(key),
    )
  )
    throw Error('Unsupported canonical database profile.');
  const key = JSON.stringify({ kind, version, components });
  if (cache.has(key)) return structuredClone(cache.get(key));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg-schema-'));
  let database, storage, db;
  try {
    if (kind === 'platform') {
      const platform = path.join(directory, 'platform');
      const store = require('../../application/platform.cjs').createPlatformStore(platform);
      store.close();
      database = require('../platform-database.cjs').createPlatformDatabase(platform);
      for (const [target, file, name] of upgrades)
        if (version >= target)
          require('../../migrations/' + file + '.cjs')[name](database, platform, { offline: true });
      db = database.db;
      if (components.notificationMaintenance)
        db.exec(require('../notification-maintenance-schema.cjs').schema);
      if (components.bookingPublicLinks)
        db.exec(require('../booking-public-links-schema.cjs').schema);
      if (components.assistantRows)
        for (const definition of require('../../modules/assistant/access/row-schema.cjs')
          .definitions)
          db.exec(definition.sql);
      if (components.isolatedReadBudgets) {
        const budget = require('../booking-read-budget-store.cjs');
        db.exec(budget.registrationTable);
        for (const guard of budget.legacyGuards) db.exec(guard.sql);
      }
    } else if (kind === 'cabinet') {
      storage = require('../cabinet-storage.cjs').createStorage(directory);
      storage.close();
      storage = null;
      db = new DatabaseSync(path.join(directory, 'cabinet.sqlite'));
      if (version === 0) {
        db.exec(
          'DROP TABLE cabinet_summaries;DROP TABLE cabinet_patient_counts;DROP TABLE cabinet_record_ids;DROP TABLE cabinet_appointments;DROP TABLE cabinet_days;DROP TABLE cabinet_photo_refs;PRAGMA user_version=0',
        );
      }
      if (version >= 1)
        require('../../migrations/001-cabinet-indexes.cjs').migrateCabinetIndexes({
          db,
          directory,
          rebuild() {},
        });
      if (version === 2)
        require('../../migrations/002-cabinet-records.cjs').migrateCabinetRecords({
          db,
          encode() {
            throw Error('Nonempty canonical fixture.');
          },
          decode() {
            throw Error('Nonempty canonical fixture.');
          },
        });
      if (components.patientHistory) {
        if (version !== 2) throw Error('Patient history requires canonical records');
        db.exec(require('../cabinet-history-index145.cjs').schema);
      }
    } else {
      db = new DatabaseSync(':memory:');
      db.exec(require('../booking-read-budget-store.cjs').schema);
    }
    const result = describeSqliteSchema(db);
    cache.set(key, result);
    return structuredClone(result);
  } finally {
    storage?.close();
    if (database) {
      database.closeWriter();
      database.db.close();
    } else db?.close();
    const resolved = path.resolve(directory),
      parent = path.resolve(os.tmpdir());
    if (
      path.dirname(resolved) !== parent ||
      !path.basename(resolved).startsWith('cartoteca-pg-schema-')
    )
      throw Error('Unsafe canonical schema cleanup.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
// Written only by offline import/restore. Runtime creation reads these exact
// hashes from its asset lineage instead of guessing among historical catalogs.
function canonicalCabinetTemplateHashes() {
  return Object.fromEntries(
    [1, 2].map((version) => [
      String(version),
      digest(canonicalSqliteSchema({ kind: 'cabinet', version })),
    ]),
  );
}
module.exports = { canonicalSqliteSchema, canonicalCabinetTemplateHashes };
