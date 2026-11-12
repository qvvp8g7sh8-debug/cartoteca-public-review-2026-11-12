const path = require('node:path');
const assert = require('node:assert/strict');
const { postgresRevisionFixture } = require('./postgres-revision133-fixture.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createPlatformStore } = require('../../src/server/application/platform.cjs');
const { schema } = require('../../src/server/infrastructure/booking-public-links-schema.cjs');
const { migrateCabinetRecords } = require('../../src/server/migrations/002-cabinet-records.cjs');
const DAY176 = '2040-01-01';
const BEFORE176 = Date.parse('2040-01-01T05:00:00Z');
const AFTER176 = Date.parse('2040-01-01T08:00:00Z');

async function postgresBookingHealth176Fixture(t) {
  const f = await postgresRevisionFixture(t, {
    async prepareSource(source) {
      // A real optional component is migrated with two real encrypted tenants.
      // The already-open source factory still uses its legacy-link fallback.
      const database = createPlatformDatabase(path.join(source.directory, 'platform'));
      database.db.exec(schema);
      database.db.close();
      for (const actor of source.actors) {
        const storage = createStorage(path.join(source.directory, 'tenants', actor.organizationId));
        try {
          const state = storage.read();
          state.services = [
            {
              id: 'health176-service',
              name: 'Synthetic service',
              duration: '30 минут',
              price: 0,
              staffId: actor.accountId,
            },
          ];
          state.patients[0].appointments = [
            {
              id: 'health176-appointment',
              date: DAY176,
              time: '09:00',
              duration: 30,
              staffId: actor.accountId,
              service: 'Synthetic service',
              status: 'scheduled',
              notes: '',
            },
          ];
          storage.write(state);
          source.platform.workSchedules.save(
            actor.token,
            {
              staffId: actor.accountId,
              dates: [DAY176],
              status: 'working',
              intervals: [['09:00', '10:00']],
              revision: 0,
              expectedTimeZone: 'Europe/Moscow',
            },
            storage,
          );
          source.platform.bookingPublication.save(actor.token, { enabled: true, revision: 0 });
          migrateCabinetRecords(storage);
        } finally {
          storage.close();
        }
      }
    },
  });
  await f.change(3);
  const bindings = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const binding of bindings.reverse()) {
      binding.storage.close();
      binding.platform.close();
      binding.database.db.close();
      await binding.native.close();
    }
  }
  t.after(close);
  for (const actor of f.fixture.actors) {
    const native = await f.owner();
    const options = {
      notificationSchema: 11,
      databaseOwner: native.owner,
      sharedCabinetWrites: true,
      assistantComposition: false,
      administrationComposition: true,
      scheduledNotifications: false,
      scheduleStartupReconcile: false,
      notificationMaintenanceEnabled: false,
    };
    const database = createPlatformDatabase(path.join(f.assets, 'platform'), options);
    const platform = createPlatformStore(path.join(f.assets, 'platform'), options);
    const storage = createStorage(path.join(f.assets, 'tenants', actor.organizationId), {
      databaseOwner: native.owner,
      databaseRoot: f.assets,
      photoOrganizationId: actor.organizationId,
      cabinetSchema: 2,
    });
    assert.equal(platform.bookingShortLinks.available, true);
    const context = {
      platform,
      token: actor.token,
      current: platform.session(actor.token),
      req: { headers: {} },
      res: {},
      tenantStore(org) {
        assert.equal(org, actor.organizationId);
        return storage;
      },
      assertCurrent() {
        const current = platform.session(actor.token);
        if (!current || current.organizationId !== actor.organizationId)
          throw Object.assign(Error('Synthetic current authority revoked'), { status: 403 });
        return current;
      },
      requireCurrent() {
        return this.assertCurrent();
      },
    };
    bindings.push({ actor, native, database, platform, storage, context });
  }
  function snapshot(binding) {
    const { db } = binding.database;
    const org = binding.actor.organizationId;
    return binding.database.readOnlySnapshot(() => ({
      organization: db.prepare('SELECT * FROM organizations WHERE id=?').get(org),
      links: db
        .prepare('SELECT * FROM booking_public_links WHERE organization_id=? ORDER BY staff_id')
        .all(org),
      audit: db
        .prepare('SELECT * FROM platform_audit WHERE organization_id=? ORDER BY id')
        .all(org),
      adminSource: db
        .prepare(
          "SELECT * FROM admin_directory_records WHERE kind='organization' AND resource_id=?",
        )
        .get(org),
      adminTerms: db
        .prepare(
          "SELECT * FROM admin_directory_terms WHERE kind='organization' AND resource_id=? ORDER BY term_hash",
        )
        .all(org),
      adminVersion: db
        .prepare(
          "SELECT * FROM admin_resource_versions WHERE kind='organization' AND resource_id=?",
        )
        .get(org),
      patients: binding.storage.db.prepare('SELECT * FROM patients ORDER BY id').all(),
      records: binding.storage.db
        .prepare('SELECT * FROM cabinet_patient_records ORDER BY patient_id,kind,position')
        .all(),
    }));
  }
  return { ...f, a: bindings[0], b: bindings[1], close, snapshot };
}
module.exports = { postgresBookingHealth176Fixture, DAY176, BEFORE176, AFTER176 };
