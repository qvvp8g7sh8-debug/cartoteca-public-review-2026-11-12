const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createStorage } = require('../../storage.cjs');
const { PRIVACY_VERSION } = require('../../src/shared/privacy-consent.cjs');
const { publicInfo } = require('../../src/server/modules/booking/public-service.cjs');
const crypto = require('node:crypto');

async function bookingFixture({
  patients = 0,
  history = 0,
  appointments = 0,
  notificationSchema = 11,
  scheduledNotifications = false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-classic-'));
  let platform = createPlatformStore(path.join(dir, 'platform'));
  let storage;
  const close = () => {
    storage?.close();
    platform.close();
    if (
      path.dirname(dir) !== path.resolve(os.tmpdir()) ||
      !path.basename(dir).startsWith('cartoteca-classic-')
    )
      throw Error('Unsafe synthetic fixture cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    if ([15, 18].includes(notificationSchema)) {
      platform.close();
      const directory = path.join(dir, 'platform');
      const database =
        require('../../src/server/infrastructure/platform-database.cjs').createPlatformDatabase(
          directory,
        );
      try {
        require('../../src/server/migrations/012-max-connections.cjs').migrateMaxConnections(
          database,
          directory,
        );
        require('../../src/server/migrations/013-notification-queue.cjs').migrateNotificationQueue(
          database,
          directory,
        );
        require('../../src/server/migrations/014-notification-channels.cjs').migrateNotificationChannels(
          database,
          directory,
        );
        require('../../src/server/migrations/015-max-inbox.cjs').migrateMaxInbox(
          database,
          directory,
        );
        if (notificationSchema === 18) {
          require('../../src/server/migrations/016-staff-max.cjs').migrateStaffMax(
            database,
            directory,
          );
          require('../../src/server/migrations/017-staff-push.cjs').migrateStaffPush(
            database,
            directory,
          );
          require('../../src/server/migrations/018-notification-schedule.cjs').migrateNotificationSchedule(
            database,
            directory,
          );
        }
      } finally {
        database.db.close();
      }
      platform = createPlatformStore(directory, { notificationSchema, scheduledNotifications });
    }
    const password = 'Synthetic-classic-password-2026';
    const owner = await platform.registerOwner({
      email: 'owner@classic.test',
      password,
      displayName: 'Тестовый специалист',
      organizationName: 'Тестовая организация',
      city: 'Тестовый город',
    });
    platform.verifyEmail(owner.verificationToken);
    const token = (await platform.login('owner@classic.test', password)).token;
    const org = owner.organizationId;
    if (patients > 10) {
      const admin = await platform.bootstrapGlobalAdmin({
        email: 'admin@classic.test',
        password,
        displayName: 'Тестовый оператор',
      });
      platform.admin.updateSubscription(admin.accountId, org, {
        requestId: crypto.randomUUID(),
        expectedRevision: 0,
        reason: 'Синтетический нагрузочный стенд',
        plan: 'paid',
        limits: {
          patients: 20000,
          photos: 100000,
          publicBooking: true,
          automaticNotifications: true,
        },
      });
    }
    storage = createStorage(path.join(dir, 'tenants', org));
    const date = '2030-01-01',
      now = Date.parse('2030-01-01T05:00:00Z');
    const patientRows = Array.from({ length: patients }, (_, i) => ({
      id: 'synthetic-' + i,
      firstName: 'Тестовый',
      lastName: 'Клиент' + i,
      name: 'Тестовый Клиент' + i,
      phone: '+7' + String(9000000000 + i),
      createdBy: owner.accountId,
      visits: Array.from({ length: history }, (_, n) => ({
        id: `visit-${i}-${n}`,
        date: '2020-01-01',
        procedure: 'Тестовая процедура',
        staffId: owner.accountId,
        photos: [],
      })),
      appointments:
        i < appointments
          ? [
              {
                id: 'seed-booking-' + i,
                date,
                time: `${String(13 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
                duration: 30,
                service: 'Тестовая услуга',
                staffId: owner.accountId,
                status: 'scheduled',
              },
            ]
          : [],
    }));
    storage.write({
      revision: 0,
      patients: patientRows,
      services: [{ id: 's', name: 'Тестовая услуга', duration: '30 минут', price: 120 }],
    });
    platform.workSchedules.save(
      token,
      {
        staffId: owner.accountId,
        dates: [date, '2030-01-02', '2030-01-03'],
        status: 'working',
        intervals: [
          ['09:00', '12:00'],
          ['13:00', '20:00'],
        ],
        revision: 0,
        expectedTimeZone: 'Europe/Moscow',
      },
      storage,
    );
    platform.bookingPublication.save(token, { enabled: true, revision: 0 });
    const context = {
      platform,
      tenantStore: () => storage,
      clientAddress: () => 'synthetic-client',
      req: {},
    };
    const setMode = (bookingMode) => {
      const saved = platform.onlineBooking.view(token);
      const {
        revision,
        mode,
        minimumLeadMinutes,
        reservationMinutes,
        showPrices,
        staff,
        services,
      } = saved;
      return platform.onlineBooking.save(
        token,
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
    const input = (extra = {}) => ({
      key: publicInfo(context, org, now).challenge,
      date,
      time: '09:00',
      serviceIds: ['s'],
      staffId: owner.accountId,
      kind: 'reserve',
      bookingMode: platform.onlineBooking.settings(org).bookingMode,
      firstName: 'Тестовый',
      lastName: '',
      middleName: '',
      phone: '+79999999999',
      comment: '',
      consent: true,
      privacyConsentVersion: PRIVACY_VERSION,
      ...extra,
    });
    return { dir, platform, storage, context, owner, org, token, date, now, setMode, input, close };
  } catch (error) {
    close();
    throw error;
  }
}
module.exports = { bookingFixture };
