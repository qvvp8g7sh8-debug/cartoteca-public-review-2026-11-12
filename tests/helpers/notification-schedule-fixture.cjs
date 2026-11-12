const { maxFixture } = require('../max-fixture.cjs');
const { fail } = require('../../src/shared/errors.cjs');
const {
  createNotificationStore,
} = require('../../src/server/modules/notifications/notification-store.cjs');
const {
  createNotificationScheduleStore,
} = require('../../src/server/modules/notifications/notification-schedule-store.cjs');
const {
  createNotificationCoordinator,
} = require('../../src/server/modules/notifications/notification-coordinator.cjs');
const { createStaffPush } = require('../../src/server/modules/notifications/push-store.cjs');

function scheduleFixture(t, { migrate = true } = {}) {
  const f = maxFixture(t);
  for (const [file, name] of [
    ['013-notification-queue', 'migrateNotificationQueue'],
    ['014-notification-channels', 'migrateNotificationChannels'],
    ['015-max-inbox', 'migrateMaxInbox'],
    ['016-staff-max', 'migrateStaffMax'],
    ['017-staff-push', 'migrateStaffPush'],
    ...(migrate ? [['018-notification-schedule', 'migrateNotificationSchedule']] : []),
  ])
    require('../../src/server/migrations/' + file + '.cjs')[name](f.database, f.directory);
  const { db, seal } = f.database;
  db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
    seal({ name: 'Synthetic', timeZone: 'UTC' }),
    'org',
  );
  let now = Date.parse('2030-01-01T08:00:00Z');
  const clock = () => now;
  const metrics = { appointmentReads: 0, profileReads: 0 };
  const appointment = {
    id: 'a',
    date: '2030-01-03',
    time: '10:00',
    duration: 60,
    staffId: 'owner',
    status: 'scheduled',
  };
  f.patients[0].appointments.push(appointment);
  const context = { ...f.database, ...f.platform, fail };
  f.platform.staffPush = createStaffPush(context);
  if (migrate)
    f.platform.notificationSchedule = createNotificationScheduleStore(context, { enabled: true });
  const tenantStore = (org) => ({
    ...f.tenantStore(org),
    get: () => null,
    readSelected(ids) {
      metrics.profileReads++;
      return f.tenantStore(org).readSelected(ids);
    },
    readPatientAppointments(patient) {
      metrics.appointmentReads++;
      return org === 'org' ? f.patients.find((p) => p.id === patient)?.appointments || [] : [];
    },
    transaction: (work) => work(),
    indexes: {
      appointments() {
        throw Error('Global appointment scan must not run in enabled schema18.');
      },
    },
  });
  const sent = [],
    readiness = { telegram: true, max: true };
  const providers = Object.fromEntries(
    ['telegram', 'max'].map((channel) => [
      channel,
      {
        status: () => ({
          configured: true,
          connected: readiness[channel],
          botId: channel === 'max' ? '123' : '321',
        }),
        acquire: async () => true,
        send: async (value) => {
          sent.push({ channel, ...value });
          return {};
        },
      },
    ]),
  );
  const store = createNotificationStore(f.database);
  const coordinator = createNotificationCoordinator({
    platform: f.platform,
    tenantStore,
    store,
    links: f.links,
    providers,
    clock,
  });
  function link(patient = 'p') {
    db.prepare('INSERT OR REPLACE INTO telegram_links VALUES(?,?,?,?)').run(
      'org',
      patient,
      f.database.limitKey('telegram-chat', patient),
      seal({ chatId: '456', linkedAt: now, servicesConsent: true }),
    );
    const issued = f.links.issue('org', patient, 'owner', '123', () => {}, now);
    f.links.consume(issued.token, '123', patient === 'p' ? '789' : '790', () => {}, now);
  }
  function dirty(patient = 'p') {
    f.database.transaction(() =>
      f.platform.notificationSchedule.markDirty('org', 'client', patient),
    );
  }
  function device(deviceId = 'device', account = 'owner', leadMinutes = 30) {
    db.prepare('INSERT OR REPLACE INTO staff_push_devices VALUES(?,?,?,?,?,?)').run(
      deviceId,
      'org',
      account,
      'hash-' + deviceId,
      seal({
        enabled: true,
        bindingId: 'synthetic-binding',
        preferences: { events: ['reminder'], leadMinutes, reminderMode: 'workday' },
      }),
      now,
    );
  }
  return {
    ...f,
    context,
    clock,
    metrics,
    appointment,
    tenantStore,
    store,
    coordinator,
    sent,
    readiness,
    link,
    dirty,
    device,
    advance: (ms) => {
      now += ms;
    },
    setNow: (value) => {
      now = value;
    },
  };
}
module.exports = { scheduleFixture };
