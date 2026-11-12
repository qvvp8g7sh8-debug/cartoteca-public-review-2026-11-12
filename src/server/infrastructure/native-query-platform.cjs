const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformDatabase } = require('./platform-database.cjs');
const constants = require('./platform-constants.cjs');
const { fail } = require('../../shared/errors.cjs');

// Compose existing read/auth factories, not another web server or assistant.
// Session repair retains the established transactional authority semantics.
function createNativeQueryPlatform(config, preparedRead = null) {
  const filename = path.join(config.dataDir, 'platform', 'platform.sqlite');
  let notificationSchema;
  if (preparedRead) notificationSchema = config.notificationSchema;
  else if (config.databaseOwner?.dialect === 'postgres')
    notificationSchema = require('./postgres/runtime.cjs').readRuntime(
      config.dataDir,
    ).notificationSchema;
  else {
    if (!fs.existsSync(filename)) throw fail(503, 'Подготовленная база недоступна.');
    const probe = new DatabaseSync(filename, { readOnly: true, timeout: 0 });
    try {
      notificationSchema = probe.prepare('PRAGMA user_version').get().user_version;
    } finally {
      probe.close();
    }
  }
  if (
    ![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(notificationSchema) ||
    (config.notificationSchema != null && config.notificationSchema !== notificationSchema)
  )
    throw fail(503, 'Схема подготовленной базы не соответствует настройкам.');
  const database =
    preparedRead?.database ||
    createPlatformDatabase(path.join(config.dataDir, 'platform'), {
      notificationSchema,
      databaseOwner: config.databaseOwner,
      sharedCabinetWrites: config.sharedCabinetWrites === true,
      isolatedReadBudgets: config.isolatedReadBudgets === true,
    });
  const c = { ...constants, ...database, fail };
  try {
    Object.assign(c, require('../modules/users/accounts.cjs').createAccounts(c));
    Object.assign(c, require('../modules/organizations/service.cjs').createOrganizations(c));
    Object.assign(c, require('../modules/auth/sessions.cjs').createSessions(c));
    Object.assign(
      c,
      require('../modules/organizations/time-zone.cjs').createOrganizationTimeZone(c),
    );
    Object.assign(c, require('../modules/workspace/service.cjs').createWorkspace(c));
    c.workSchedules = require('../modules/schedules/service.cjs').createWorkSchedules(c);
    Object.assign(c, require('../modules/services/groups.cjs').createServiceGroups(c));
    Object.assign(c, require('../modules/services/catalog.cjs').createServiceCatalog(c));
    const flags = config.notificationChannels;
    const channelRow = database.db.prepare('SELECT value FROM telegram_runtime WHERE key=?');
    const channels = () => {
      const row = channelRow.get('notification-channel-state-v1');
      return row ? database.open(row.value) : {};
    };
    // Unlike channel-state's owner constructor, this projection never reconciles
    // flags, cancels delivery, or generates new channel epochs.
    c.notificationChannels = {
      enabled: (channel) =>
        !flags || (flags[channel] === true && channels()[channel]?.enabled === true),
      version: (channel) => (flags ? channels()[channel]?.version || '' : ''),
    };
    c.telegram = require('../modules/notifications/telegram-store.cjs').createTelegramStore(c);
    c.appointmentConfirmations =
      require('../modules/cabinet/confirmations.cjs').createAppointmentConfirmations(c);
    c.personalEvents = require('../modules/calendar/personal-events.cjs').createPersonalEvents(c);
    c.bookingRequests = require('../modules/booking/request-store.cjs').createBookingRequestStore(
      c,
    );
    if (config.commonNotificationsEnabled === true) {
      c.maxLinks = require('../modules/notifications/max-links.cjs').createMaxLinks(c);
      c.notificationStore =
        require('../modules/notifications/notification-store.cjs').createNotificationStore(c);
    }
    const projectionSnapshot =
      preparedRead?.projectionSnapshot ||
      require('./native-projection-snapshot140.cjs').createProjectionSnapshot(
        database,
        config.databaseOwner?.dialect === 'postgres' && database.db.revisionProfile === 3,
      );
    c.withReadSnapshot = projectionSnapshot.read;
    c.withProjectionSnapshot = projectionSnapshot.run;
    c.projectionSnapshotProof = projectionSnapshot.proof;
    c.isProjectionSnapshot = projectionSnapshot.contains;
    const projectionRequests = (org, route) => {
      if (!database.db.canPrefetchReads) return [];
      const requests = [...c.organization.readRequests(org)];
      if (
        [
          '/api/cabinet/calendar',
          '/api/cabinet/patient',
          '/api/cabinet/patient/upcoming',
          '/api/cabinet/operation',
        ].includes(route)
      ) {
        requests.push(
          ...c.subscription.readRequests(org),
          ...c.telegram.settings.readRequests(org),
        );
        if (flags && channelRow.readRequest)
          requests.push(channelRow.readRequest('get', ['notification-channel-state-v1']));
        requests.push(...(c.bookingRequests.appointmentSources.readRequests?.(org) || []));
      }
      return requests;
    };
    c.prefetchProjection = (org, route) => {
      const requests = projectionRequests(org, route);
      return requests.length ? database.db.prefetchReads(requests) : false;
    };
    c.prefetchProjectionAsync = (org, route) =>
      database.db.prefetchAll(projectionRequests(org, route));
    c.readVersion =
      preparedRead?.readVersion || require('./read-version.cjs').createReadVersion(database.db);
    c.close = () => {
      database.closeWriter();
      database.db.close();
      if (!preparedRead) config.databaseOwner?.closeSync();
    };
    return c;
  } catch (error) {
    database.closeWriter();
    database.db.close();
    throw error;
  }
}

module.exports = { createNativeQueryPlatform };
