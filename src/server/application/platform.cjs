const { createPlatformDatabase } = require('../infrastructure/platform-database.cjs');
const constants = require('../infrastructure/platform-constants.cjs');
const { fail } = require('../../shared/errors.cjs');
function createPlatformStore(
  directory,
  {
    notificationSchema = 11,
    databaseOwner = null,
    scheduledNotifications = false,
    scheduleStartupReconcile = true,
    notificationMaintenanceEnabled = false,
    sharedCabinetWrites = false,
    isolatedReadBudgets = false,
    notificationChannels = null,
    notificationChannelProjection = false,
    assistantComposition = true,
    administrationComposition = true,
    paymentNetworkEnabled = false,
    paymentProviderFactory = null,
    paymentFetch = null,
    assistantCodex = null,
    assistantLocalSpeech = null,
    assistantAppointmentSavingEnabled = false,
    assistantStateBackend = 'file',
    assistantDialogueCapacity = 100,
    assistantReadConfig = null,
    assertAssistantExecutorOwned = null,
  } = {},
) {
  if (
    typeof notificationChannelProjection !== 'boolean' ||
    typeof scheduleStartupReconcile !== 'boolean' ||
    typeof assistantComposition !== 'boolean' ||
    typeof administrationComposition !== 'boolean'
  )
    throw Error('Invalid internal platform composition.');
  const database = createPlatformDatabase(directory, {
    notificationSchema,
    databaseOwner,
    sharedCabinetWrites,
    isolatedReadBudgets,
  });
  try {
    require('../migrations/003-telegram.cjs').migrateTelegram(database.db, directory);
  } catch (error) {
    database.db.close();
    throw error;
  }
  try {
    require('../migrations/004-manual-confirmations.cjs').migrateManualConfirmations(
      database.db,
      directory,
    );
  } catch (error) {
    database.db.close();
    throw error;
  }
  try {
    require('../migrations/005-support.cjs').migrateSupport(database.db, directory);
  } catch (error) {
    database.db.close();
    throw error;
  }
  const context = {
    ...constants,
    ...database,
    fail,
    paymentNetworkEnabled: paymentNetworkEnabled === true,
    paymentProviderFactory,
    paymentFetch,
  };
  try {
    require('../modules/assistant/access/store.cjs').assertAssistantStateBackend(context, {
      directory,
      backend: assistantStateBackend,
    });
    context.notificationMaintenance =
      require('../modules/notifications/queue-maintenance.cjs').createQueueMaintenance(context, {
        enabled: notificationMaintenanceEnabled,
      });
    context.sessionMaintenance =
      require('../modules/auth/session-maintenance.cjs').createSessionMaintenance(context);
    context.notificationChannels = notificationChannelProjection
      ? require('../modules/notifications/channel-projection.cjs').createNotificationChannelProjection(
          context,
        )
      : require('../modules/notifications/channel-state.cjs').createNotificationChannelState(
          context,
          notificationChannels,
        );
    context.notificationSchedule =
      notificationSchema >= 18
        ? require('../modules/notifications/notification-schedule-store.cjs').createNotificationScheduleStore(
            context,
            { enabled: scheduledNotifications, startupReconcile: scheduleStartupReconcile },
          )
        : null;
    require('../migrations/006-organization-time-zone.cjs').migrateOrganizationTimeZone(
      database,
      directory,
    );
    require('../migrations/007-work-schedules.cjs').migrateWorkSchedules(database, directory);
    require('../migrations/008-email-invitations.cjs').migrateEmailInvitations(database, directory);
    require('../migrations/009-booking-requests.cjs').migrateBookingRequests(database, directory);
    require('../migrations/010-staff-notifications.cjs').migrateStaffNotifications(
      database,
      directory,
    );
    require('../migrations/011-platform-administration.cjs').migratePlatformAdministration(
      database,
      directory,
    );
  } catch (error) {
    database.db.close();
    throw error;
  }
  Object.assign(
    context,
    require('../modules/organizations/time-zone.cjs').createOrganizationTimeZone(context),
  );
  Object.assign(context, require('../modules/auth/passwords.cjs').createPasswords(context));
  Object.assign(context, require('../modules/users/accounts.cjs').createAccounts(context));
  Object.assign(context, require('../modules/auth/login-limits.cjs').createLoginLimits(context));
  Object.assign(
    context,
    require('../modules/auth/public-limits.cjs').createPublicAuthLimits(context),
  );
  Object.assign(
    context,
    require('../modules/organizations/service.cjs').createOrganizations(context),
  );
  Object.assign(context, require('../modules/auth/registration.cjs').createRegistration(context));
  Object.assign(
    context,
    require('../modules/organizations/email-invitations.cjs').createEmailInvitations(context),
  );
  Object.assign(
    context,
    require('../modules/auth/authentication.cjs').createAuthentication(context),
  );
  Object.assign(context, require('../modules/auth/recovery.cjs').createRecovery(context));
  context.adminMfa = require('../modules/auth/admin-mfa.cjs').createAdminMfa(context);
  Object.assign(context, require('../modules/auth/sessions.cjs').createSessions(context));
  Object.assign(
    context,
    require('../modules/users/specialties.cjs').createStaffSpecialties(context),
  );
  Object.assign(context, require('../modules/users/profile.cjs').createProfiles(context));
  Object.assign(context, require('../modules/services/groups.cjs').createServiceGroups(context));
  context.appointmentConfirmations =
    require('../modules/cabinet/confirmations.cjs').createAppointmentConfirmations({
      ...context,
      notify: (...args) => {
        context.staffPush?.confirmation(...args);
        require('../modules/notifications/staff-appointment-events.cjs').staffConfirmation(
          context,
          ...args,
        );
      },
    });
  context.telegram = require('../modules/notifications/telegram-store.cjs').createTelegramStore(
    context,
  );
  context.support = require('../modules/support/store.cjs').createSupportStore(context);
  Object.assign(context, require('../modules/workspace/service.cjs').createWorkspace(context));
  context.calendarSubscription =
    require('../modules/calendar/subscription.cjs').createCalendarSubscription(context);
  context.personalEvents = require('../modules/calendar/personal-events.cjs').createPersonalEvents(
    context,
  );
  Object.assign(context, require('../modules/services/catalog.cjs').createServiceCatalog(context));
  context.workSchedules = require('../modules/schedules/service.cjs').createWorkSchedules(context);
  context.onlineBooking = require('../modules/booking/settings.cjs').createBookingSettings(context);
  try {
    context.bookingShortLinks =
      require('../modules/booking/short-links.cjs').createBookingShortLinks(context);
  } catch (error) {
    database.closeWriter();
    database.db.close();
    throw error;
  }
  context.bookingPublication =
    require('../modules/booking/publication.cjs').createBookingPublication(context);
  context.bookingRequests =
    require('../modules/booking/request-store.cjs').createBookingRequestStore({
      ...context,
      notify: (...args) => {
        if (args[2] !== 'new-classic-booking') {
          context.staffNotifications.enqueue(...args);
          context.staffMaxNotifications?.enqueue(...args);
        }
        context.staffPush?.booking(...args);
      },
    });
  context.staffNotifications =
    require('../modules/notifications/staff-store.cjs').createStaffNotifications(context);
  context.staffMaxNotifications =
    notificationSchema >= 16
      ? require('../modules/notifications/staff-max-store.cjs').createStaffMaxNotifications(context)
      : null;
  context.staffPush =
    notificationSchema >= 17
      ? require('../modules/notifications/push-store.cjs').createStaffPush(context)
      : null;
  context.bookingProposals =
    require('../modules/booking/proposal-store.cjs').createBookingProposalStore(context);
  Object.assign(context, require('../modules/admin/bootstrap.cjs').createBootstrap(context));
  if (administrationComposition)
    Object.assign(context, require('../modules/admin/service.cjs').createAdministration(context));
  context.billing = require('../modules/billing/paid-services.cjs').createPaidServices(context);
  context.assistantReads =
    assistantComposition && assistantReadConfig?.storageBackend === 'postgres'
      ? require('../infrastructure/postgres/assistant-reads.cjs').createAssistantReads(
          assistantReadConfig,
        )
      : null;
  context.assistant = assistantComposition
    ? require('../modules/assistant/service.cjs').createAssistant(context, {
        directory,
        stateBackend: assistantStateBackend,
        codex: assistantCodex,
        localSpeech: assistantLocalSpeech,
        appointmentSavingEnabled: assistantAppointmentSavingEnabled === true,
        dialogueCapacity: assistantDialogueCapacity,
        assertExecutorOwned: assertAssistantExecutorOwned,
      })
    : null;
  const notifications = [15, 16, 17, 18, 19, 20].includes(notificationSchema)
    ? {
        notificationHistory:
          require('../modules/notifications/notification-history.cjs').createNotificationHistory(
            context,
          ),
        maxLinks: require('../modules/notifications/max-links.cjs').createMaxLinks(context),
        notificationStore:
          require('../modules/notifications/notification-store.cjs').createNotificationStore(
            context,
          ),
        maxInbox: require('../modules/notifications/max-inbox.cjs').createMaxInbox(context),
      }
    : {};
  const publicMethods = [
    'accountProfile',
    'updateAccountProfile',
    'updateStaffSpecialty',
    'registerOwner',
    'importLegacyOwner',
    'bootstrapGlobalAdmin',
    'issueGlobalAdminBootstrap',
    'globalAdminBootstrapStatus',
    'consumeGlobalAdminBootstrap',
    'adminOverview',
    'authenticate',
    'verifyEmail',
    'requestPasswordReset',
    'resetPassword',
    'login',
    'session',
    'selectOrganization',
    'logout',
    'createInvitation',
    'acceptInvitation',
    'emailInvitations',
    'prepareEmailInvitation',
    'finishEmailInvitation',
    'revokeEmailInvitation',
    'emailInvitationInfo',
    'acceptEmailInvitation',
    'organizationAccess',
    'updateMembership',
    'memberships',
    'availableMemberships',
    'subscription',
    'organization',
    'organizationTimeZone',
    'updateOrganizationTimeZone',
  ];
  let readBudget, publicLimits;
  try {
    readBudget = require('../infrastructure/booking-read-budget-store.cjs').openBookingReadBudget(
      database.db,
      directory,
      isolatedReadBudgets,
      { databaseOwner },
    );
    publicLimits = require('../modules/booking/public-limits.cjs').createBookingPublicLimits(
      context,
      { readBudget },
    );
  } catch (error) {
    readBudget?.close();
    database.closeWriter();
    database.db.close();
    throw error;
  }
  return {
    processRoles: require('../infrastructure/process-role-lease.cjs').createProcessRoleLease(
      database,
    ),
    ...notifications,
    notificationChannels: context.notificationChannels,
    notificationMaintenance: context.notificationMaintenance,
    sessionMaintenance: context.sessionMaintenance,
    ...Object.fromEntries(
      [
        ...publicMethods,
        'consumePublicAuthRequest',
        'serviceGroups',
        'createServiceGroup',
        'deleteServiceGroup',
        'assertServiceGroups',
        'serviceCatalog',
        'assertServiceCatalog',
        'revokeEmailVerification',
        'revokePasswordReset',
        'workspaceSettings',
        'workspaceMembers',
        'workspaceIdentities',
        'assertWorkspace',
        'assertWorkspaceSelection',
        'saveWorkspace',
      ].map((name) => [name, context[name]]),
    ),
    organizationQueueTransaction:
      database.db.revisionProfile === 3 ? database.organizationQueueTransaction : null,
    withWriteLock: database.transaction,
    withAsyncWriteLock: database.asyncTransaction,
    withCompoundMutation: database.db.revisionProfile === 3 ? database.compoundTransaction : null,
    withAsyncCompoundMutation:
      database.db.revisionProfile === 3 ? database.asyncCompoundTransaction : null,
    withSharedCabinetCommit: database.sharedCabinetCommit,
    sharedCabinetStats: database.sharedCabinetStats,
    writeQueueStats: database.writeQueueStats,
    withReadSnapshot: database.readSnapshot,
    withReadOnlySnapshot: database.readOnlySnapshot,
    withNotificationReadSnapshot:
      database.db.revisionProfile === 3 ? database.readOnlySnapshot : null,
    readVersion: require('../infrastructure/read-version.cjs').createReadVersion(database.db),
    adminMfa: context.adminMfa,
    admin: context.admin,
    assistant: context.assistant,
    assistantReads: context.assistantReads,
    billing: context.billing,
    telegram: context.telegram,
    support: context.support,
    workSchedules: context.workSchedules,
    personalEvents: context.personalEvents,
    calendarSubscription: context.calendarSubscription,
    onlineBooking: context.onlineBooking,
    bookingPublication: context.bookingPublication,
    bookingShortLinks: context.bookingShortLinks,
    bookingPublicLimits: publicLimits,
    readBudgetQueueStats: readBudget?.stats,
    bookingRequests: context.bookingRequests,
    staffNotifications: context.staffNotifications,
    staffMaxNotifications: context.staffMaxNotifications,
    staffPush: context.staffPush,
    notificationSchedule: context.notificationSchedule,
    bookingProposals: context.bookingProposals,
    appointmentConfirmations: context.appointmentConfirmations,
    hasAccounts: () => Boolean(database.db.prepare('SELECT 1 FROM accounts LIMIT 1').get()),
    close: () => {
      void context.assistantReads?.close().catch(() => {});
      context.notificationMaintenance.stop();
      context.sessionMaintenance.stop();
      readBudget?.close();
      database.closeWriter();
      database.db.close();
    },
  };
}

module.exports = { createPlatformStore };
