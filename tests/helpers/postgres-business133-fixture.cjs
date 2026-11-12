const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { bookingFixture } = require('./booking-fixture.cjs');
const { startPostgresTestRuntime } = require('../../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../../src/server/infrastructure/postgres/migration.cjs');
const {
  prepareCompoundProfile,
} = require('../../src/server/infrastructure/postgres/revision-operator133.cjs');
const {
  initializePostgresOwner,
} = require('../../src/server/infrastructure/postgres/initialize.cjs');
const { createPlatformStore } = require('../../src/server/application/platform.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const { KEYS } = require('../../src/server/infrastructure/postgres/lock-intents.cjs');
async function postgresBusinessFixture(t, { cabinetSchema = 1 } = {}) {
  const source = await bookingFixture({ patients: 1, appointments: 1, notificationSchema: 18 });
  const adminActor = await source.platform.bootstrapGlobalAdmin({
    email: 'operator@compound.synthetic.test',
    password: 'Synthetic-compound-operator-password',
    displayName: 'Synthetic operator',
  });
  source.platform.admin.updateSubscription(adminActor.accountId, source.org, {
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: 'Synthetic compound effects',
    plan: 'paid',
    limits: { patients: 20000, photos: 100000, publicBooking: true, automaticNotifications: true },
  });
  const sourceDatabase = createPlatformDatabase(path.join(source.dir, 'platform'), {
    notificationSchema: 18,
  });
  sourceDatabase.transaction(() => {
    const seal = sourceDatabase.seal,
      db = sourceDatabase.db;
    db.prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)').run(
      'notification-channel-state-v1',
      seal({
        telegram: { enabled: true, version: 'synthetic-telegram' },
        max: { enabled: false, version: 'synthetic-max' },
        push: { enabled: true, version: 'synthetic-push' },
      }),
    );
    db.prepare('INSERT INTO telegram_settings VALUES(?,?)').run(
      source.org,
      seal({ events: ['reminder', 'created', 'moved', 'cancelled'] }),
    );
    db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?)').run(
      source.org,
      'synthetic-0',
      'synthetic-chat',
      seal({ chatId: 'synthetic-chat', linkedAt: 1 }),
    );
    db.prepare('INSERT INTO staff_telegram_links VALUES(?,?,?,?)').run(
      source.org,
      source.owner.accountId,
      'synthetic-staff-chat-hash',
      seal({
        chatId: 'synthetic-staff-chat',
        bindingId: 'synthetic-staff-binding',
        enabled: true,
        events: ['new-request', 'created', 'moved', 'cancelled', 'confirmation'],
      }),
    );
    db.prepare("DELETE FROM telegram_runtime WHERE key GLOB 'staff-interest-v1:*'").run();
    db.prepare('INSERT INTO staff_push_devices VALUES(?,?,?,?,?,?)').run(
      'synthetic-device',
      source.org,
      source.owner.accountId,
      'synthetic-endpoint',
      seal({
        enabled: true,
        bindingId: 'synthetic-push-binding',
        preferences: { events: ['created', 'moved', 'cancelled', 'confirmation', 'new-request'] },
        subscription: { endpoint: 'https://fcm.googleapis.com/synthetic-no-delivery', keys: {} },
      }),
      1,
    );
  });
  sourceDatabase.db.close();
  const sourceClose = source.platform.close,
    sourceStorageClose = source.storage.close;
  let platformClosed = false,
    storageClosed = false;
  source.platform.close = () => {
    if (!platformClosed) {
      platformClosed = true;
      sourceClose();
    }
  };
  source.storage.close = () => {
    if (!storageClosed) {
      storageClosed = true;
      sourceStorageClose();
    }
  };
  if (cabinetSchema === 2)
    require('../../src/server/migrations/002-cabinet-records.cjs').migrateCabinetRecords(
      source.storage,
    );
  source.storage.close();
  source.platform.close();
  t.after(source.close);
  const runtime = await startPostgresTestRuntime(),
    admin = new Client(runtime.admin);
  let owner, platform, storage, database;
  t.after(async () => {
    storage?.close();
    platform?.close();
    database?.db.close();
    await owner?.close();
    await admin.end();
    await runtime.close();
  });
  await admin.connect();
  const destination = path.join(runtime.root, 'assets');
  await migratePostgresData({
    source: source.dir,
    destination,
    client: admin,
    applicationRole: runtime.application.user,
    dryRun: false,
    offline: true,
  });
  await admin.query('BEGIN');
  try {
    await admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
    await prepareCompoundProfile(admin, runtime.application.user);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
  const options = await initializePostgresOwner({
    dataDir: destination,
    storageBackend: 'postgres',
    postgres: runtime.application,
    notificationSchema: 18,
    processRole: 'command',
  });
  owner = options.databaseOwner;
  database = createPlatformDatabase(path.join(destination, 'platform'), {
    notificationSchema: 18,
    databaseOwner: owner,
    sharedCabinetWrites: true,
  });
  platform = createPlatformStore(path.join(destination, 'platform'), {
    ...options,
    assistantComposition: false,
    scheduledNotifications: true,
    scheduleStartupReconcile: false,
    notificationChannelProjection: true,
  });
  storage = createStorage(path.join(destination, 'tenants', source.org), {
    databaseOwner: owner,
    databaseRoot: destination,
    photoOrganizationId: source.org,
    cabinetSchema,
  });
  const context = {
    platform,
    token: source.token,
    current: platform.session(source.token),
    tenantStore: (org) => {
      if (org !== source.org) throw Error('Foreign synthetic scope');
      return storage;
    },
    clientAddress: () => 'synthetic-client',
    req: { headers: {} },
    assertCurrent() {
      const fresh = platform.session(source.token);
      if (!fresh || fresh.organizationId !== source.org)
        throw Object.assign(Error('Synthetic access revoked'), { status: 403 });
      return fresh;
    },
    requireCurrent() {
      return this.assertCurrent();
    },
  };
  const input = (extra = {}) => ({
    key: require('../../src/server/modules/booking/public-service.cjs').publicInfo(
      context,
      source.org,
      source.now,
    ).challenge,
    date: source.date,
    time: '09:00',
    serviceIds: ['s'],
    staffId: source.owner.accountId,
    kind: 'reserve',
    bookingMode: platform.onlineBooking.settings(source.org).bookingMode,
    firstName: 'Synthetic',
    lastName: '',
    middleName: '',
    phone: '+79999999999',
    comment: '',
    consent: true,
    privacyConsentVersion: require('../../src/shared/privacy-consent.cjs').PRIVACY_VERSION,
    ...extra,
  });
  const setMode = (bookingMode) => {
    const { revision, mode, minimumLeadMinutes, reservationMinutes, showPrices, staff, services } =
      platform.onlineBooking.view(source.token);
    return platform.onlineBooking.save(
      source.token,
      {
        revision,
        mode,
        bookingMode,
        minimumLeadMinutes,
        reservationMinutes,
        showPrices,
        staff,
        services,
      },
      new Set(['s']),
    );
  };
  return {
    ...source,
    runtime,
    admin,
    databaseOwner: owner,
    destination,
    database,
    platform,
    storage,
    context,
    input,
    setMode,
  };
}
module.exports = { postgresBusinessFixture };
