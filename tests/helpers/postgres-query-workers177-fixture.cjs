const path = require('node:path');
const assert = require('node:assert/strict');
const { postgresRevisionFixture } = require('./postgres-revision133-fixture.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const upgrades = [
  ['012-max-connections', 'migrateMaxConnections'],
  ['013-notification-queue', 'migrateNotificationQueue'],
  ['014-notification-channels', 'migrateNotificationChannels'],
  ['015-max-inbox', 'migrateMaxInbox'],
  ['016-staff-max', 'migrateStaffMax'],
  ['017-staff-push', 'migrateStaffPush'],
  ['018-notification-schedule', 'migrateNotificationSchedule'],
  ['019-paid-services', 'migratePaidServices'],
];

async function postgresQueryWorkers177Fixture(t) {
  const fixture = await postgresRevisionFixture(t, {
    prepareSource(source) {
      // These are two real encrypted synthetic tenants. Close the old factory
      // once before explicit offline preparation; both existing cleanups retain
      // this same object and must be safe to call afterwards.
      const originalClose = source.platform.close;
      let closed = false;
      source.platform.close = () => {
        if (!closed) {
          closed = true;
          originalClose();
        }
      };
      source.platform.close();
      const directory = path.join(source.directory, 'platform');
      const database = createPlatformDatabase(directory);
      try {
        for (const [file, method] of upgrades)
          require('../../src/server/migrations/' + file + '.cjs')[method](database, directory, {
            offline: true,
          });
        assert.equal(database.db.prepare('PRAGMA user_version').get().user_version, 19);
        source.config.notificationSchema = 19;
      } finally {
        database.db.close();
      }
    },
  });
  assert.equal(fixture.profile.notificationSchema, 19);
  return fixture;
}
module.exports = { postgresQueryWorkers177Fixture };
