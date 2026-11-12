const { createRoleRenewalDiagnostics } = require('./role-renewal-diagnostics.cjs');
const http = require('node:http'),
  path = require('node:path'),
  fs = require('node:fs');
const { configuration, root } = require('../config.cjs');
const { publicAssetRoot } = require('../../shared/web-assets.cjs');
const { createPlatformStore } = require('./platform.cjs');
const { createRequestHandler } = require('../http/request-handler.cjs');
const { createStorage } = require('../infrastructure/cabinet-storage.cjs');
const { createTenantPool } = require('../infrastructure/tenant-pool.cjs');
const { createRequestDispatcher } = require('../infrastructure/request-dispatcher.cjs');
const { createReadCacheBudget } = require('../infrastructure/read-cache-budget.cjs');
const { configuredMailer } = require('../modules/notifications/email-adapter.cjs');
const { clientAddressResolver } = require('../../../client-address.cjs');
const { fail } = require('../../shared/errors.cjs');
const { configuredTelegram } = require('../modules/notifications/telegram-adapter.cjs');
const { createTelegramRuntime } = require('../modules/notifications/telegram-runtime.cjs');
const {
  createAppointmentStateReader,
} = require('../modules/notifications/appointment-state-reader.cjs');
const { createMaxConnections } = require('../modules/notifications/max-connections.cjs');
const { createMaxEvents } = require('../modules/notifications/max-events.cjs');
const { createMaxRuntime } = require('../modules/notifications/max-runtime.cjs');
const { createStaffMaxService } = require('../modules/notifications/staff-max-service.cjs');
const { createStaffMaxRuntime } = require('../modules/notifications/staff-max-runtime.cjs');
const {
  createNotificationCoordinator,
} = require('../modules/notifications/notification-coordinator.cjs');
const {
  createNotificationProviders,
} = require('../modules/notifications/notification-providers.cjs');
const { createTelegramPacing } = require('../modules/notifications/telegram-pacing.cjs');
const {
  configuredSupportDelivery,
  createSupportRuntime,
} = require('../modules/support/delivery.cjs');
const { routes } = require('./routes.cjs');
const { createRequestMetrics } = require('../infrastructure/request-metrics.cjs');
const { photoReader } = require('../infrastructure/photos/photo-reader.cjs');
const { createAdminEmailRuntime } = require('../modules/admin/email-queue.cjs');
const { createBookingPublicationRuntime } = require('../modules/booking/publication-runtime.cjs');
const { assertNoOrganizationSwitch } = require('../infrastructure/backup/organization-guard.cjs');
function createMultiServer(options = {}) {
  let authority;
  try {
    return createOwnedMultiServer(options, (dataDir) => {
      authority =
        require('../infrastructure/assistant-executor-authority.cjs').acquireAssistantExecutorAuthority(
          dataDir,
        );
      return authority;
    });
  } catch (error) {
    authority?.close();
    throw error;
  }
}
function createOwnedMultiServer(options, acquireAuthority) {
  options = require('./process-role.cjs').runtimeOptions(
    configuration(require('./release-gate.cjs').gatedRelease(options)),
  );
  if (
    options.commonNotificationsEnabled === true &&
    options.notificationSchema &&
    ![15, 16, 17, 18, 19, 20].includes(options.notificationSchema)
  )
    throw fail(503, 'Общая очередь требует отдельно подготовленной схемы 15–19.');
  if (
    options.maxConnectionsEnabled === true &&
    (!options.commonNotificationsEnabled ||
      !options.maxBot ||
      !options.maxBotIdentity ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(options.maxWebhookSecret || ''))
  )
    throw fail(503, 'Настройте проверенное подключение MAX перед запуском.');
  const config = options;
  if (config.storageBackend === 'postgres' && options.databaseOwner?.dialect !== 'postgres')
    throw Error(
      'PostgreSQL requires its ready isolated execution owner; SQLite fallback is forbidden.',
    );
  const { dataDir, origin, production, trustedProxies } = config;
  if (config.pushEnabled && ![17, 18, 19, 20].includes(options.notificationSchema))
    throw fail(503, 'Сначала подготовьте схему 17 для пуш-уведомлений.');
  if (config.scheduledNotifications && ![18, 19, 20].includes(options.notificationSchema))
    throw fail(503, 'Сначала подготовьте схему 18 для планирования уведомлений.');
  assertNoOrganizationSwitch(dataDir);
  if (fs.existsSync(path.join(dataDir, '.restore-in-progress')))
    throw Error('Restore publication is incomplete; do not start this data directory.');
  const sendMail = options.sendMail === undefined ? configuredMailer() : options.sendMail;
  const telegramBot =
    options.telegramBot === undefined ? configuredTelegram() : options.telegramBot;
  const clientAddress = clientAddressResolver(trustedProxies);
  const readCacheBudget = createReadCacheBudget({ maxBytes: config.tenantReadCacheBytes });
  const calendarFeeds = require('../modules/calendar/feed-cache.cjs').createCalendarFeedCache({
    budget: readCacheBudget,
  });
  const storageOptions = {
    readCacheBudget,
    cabinetSchema: config.cabinetSchema,
    databaseOwner: options.databaseOwner,
    databaseRoot: dataDir,
  };
  const legacyStorage = createStorage(dataDir, storageOptions);
  const assistantSavingEnabled =
    options.assistantAppointmentSavingEnabled === true &&
    !config.releaseGate &&
    process.env.CARTOTECA_RELEASE_GATE !== '1' &&
    ['combined', 'web'].includes(config.processRole);
  let platform, assistantAuthority;
  try {
    // Local explicit pilots keep their existing behavior; production has one root-data owner.
    if (assistantSavingEnabled && options.databaseOwner?.dialect === 'postgres')
      assistantAuthority = options.databaseOwner.acquireExecutorAuthority(
        require('../infrastructure/postgres/runtime.cjs').readRuntime(dataDir).platformStoreId,
      );
    else if (production && assistantSavingEnabled) assistantAuthority = acquireAuthority(dataDir);
    platform = createPlatformStore(path.join(dataDir, 'platform'), {
      databaseOwner: options.databaseOwner,
      notificationSchema:
        options.notificationSchema || (options.commonNotificationsEnabled === true ? 15 : 11),
      paymentNetworkEnabled:
        options.paymentNetworkEnabled === true &&
        !config.releaseGate &&
        process.env.CARTOTECA_RELEASE_GATE !== '1' &&
        config.processRole !== 'preflight',
      paymentProviderFactory: options.paymentProviderFactory,
      paymentFetch: options.paymentFetch,
      assistantAppointmentSavingEnabled: assistantSavingEnabled,
      assistantStateBackend: config.assistantStateBackend,
      assistantDialogueCapacity: config.assistantDialogueCapacity,
      assistantReadConfig: config,
      assertAssistantExecutorOwned: assistantAuthority?.assertOwned,
      assistantCodex: require('../modules/assistant/providers/codex/codex.cjs').createCodexRuntime({
        enabled: config.assistantCodexEnabled === true,
        production: config.production,
        host: config.host,
        origin: config.origin,
        additionalOrigins: config.additionalOrigins,
        releaseGate: config.releaseGate,
        processRole: config.processRole,
      }),
      assistantLocalSpeech:
        require('../modules/assistant/providers/local-speech/local-speech.cjs').createLocalSpeechRuntime(
          {
            enabled: config.assistantLocalSpeechEnabled === true,
            production: config.production,
            host: config.host,
            origin: config.origin,
            additionalOrigins: config.additionalOrigins,
            releaseGate: config.releaseGate,
            processRole: config.processRole,
            directory: config.assistantWhisperDirectory,
            threads: config.assistantWhisperThreads,
          },
        ),
      scheduledNotifications: config.scheduledNotifications,
      notificationMaintenanceEnabled: config.notificationMaintenanceEnabled,
      sharedCabinetWrites: config.sharedCabinetWrites,
      isolatedReadBudgets: config.isolatedReadBudgets,
      notificationChannels:
        config.processRole === 'preflight' || config.releaseGate
          ? { passive: true }
          : {
              telegram: Boolean(telegramBot),
              max: Boolean(
                options.maxConnectionsEnabled && options.maxBot && options.maxBotIdentity,
              ),
              push: Boolean(config.pushEnabled && /^https:\/\//.test(origin)),
            },
    });
  } catch (error) {
    legacyStorage.close();
    throw error;
  }
  if (!platform.hasAccounts()) {
    const owner = legacyStorage.get('owner');
    if (owner)
      platform.importLegacyOwner({
        email: owner.email,
        displayName: 'Владелец',
        organizationName: 'Картотека',
        salt: owner.salt,
        passwordHash: owner.passwordHash,
      });
  }
  if (production && !platform.hasAccounts()) {
    platform.close();
    legacyStorage.close();
    throw Error('Initialize an owner and administrator before production deployment.');
  }
  const pool = createTenantPool({
    limit: config.tenantCacheLimit,
    idleMs: config.tenantIdleMs,
    open(organizationId, observeOpen) {
      if (!organizationId) throw fail(403, 'Выберите кабинет.');
      const organization = platform.organization(organizationId);
      // Pool eviction must not close the root legacy store used by the server itself.
      return organization.legacyData
        ? { ...legacyStorage, close() {} }
        : createStorage(path.join(dataDir, 'tenants', organizationId), {
            ...storageOptions,
            photoOrganizationId: organizationId,
            observeOpen,
          });
    },
  });
  const requestDispatcher = createRequestDispatcher();
  const backgroundLane =
    (lane) =>
    (callback, organizationId = '', canRun = () => true) =>
      requestDispatcher.run(
        () => {
          if (!canRun()) return;
          return callback();
        },
        {
          priority: 'background',
          scopeKey: organizationId ? 'org:' + organizationId : 'runtime:' + lane,
          cancelled: () => closed || !canRun(),
        },
      );
  // Fixed internal lanes share the same global/per-organization queue limits.
  const runBackgroundWork = backgroundLane('maintenance');
  const runPushBackgroundWork = backgroundLane('push');
  const notificationStore = platform.notificationStore || options.notificationStore;
  let backgroundStarted = false,
    closed = false,
    roleLease = null,
    roleLeaseUntil = 0,
    roleTimer = null,
    backgroundState = 'stopped';
  const backgroundCanRun = () =>
    !closed &&
    backgroundState === 'running' &&
    Boolean(roleLease) &&
    Date.now() < roleLeaseUntil &&
    platform.processRoles.isCurrent?.() !== false;
  const backgroundStatus = () => ({
    role: config.processRole,
    state: backgroundState === 'running' && !backgroundCanRun() ? 'lease-expired' : backgroundState,
    active: backgroundCanRun(),
  });
  const staffPush = require('../modules/notifications/push-runtime.cjs').createPushRuntime({
    runBackgroundWork: runPushBackgroundWork,
    platform,
    tenantStore: pool.get,
    origin,
    enabled: config.pushEnabled,
    send: options.pushSend,
    canRun: backgroundCanRun,
  });
  const maxLinks = platform.maxLinks || options.maxLinks;
  let telegram;
  const telegramPacing = createTelegramPacing();
  const maxPacing = createTelegramPacing();
  const notificationCoordinator =
    options.commonNotificationsEnabled === true
      ? createNotificationCoordinator({
          runBackgroundWork,
          platform,
          tenantStore: pool.get,
          store: notificationStore,
          links: maxLinks,
          providers: createNotificationProviders({
            telegramBot,
            telegramPacing,
            telegramStatus: () => telegram?.status() || { connected: false },
            maxBot: options.maxBot || null,
            maxIdentity: options.maxBotIdentity || null,
            maxPacing,
          }),
        })
      : null;
  telegram = createTelegramRuntime({
    runBackgroundWork,
    platform,
    tenantStore: pool.get,
    bot: telegramBot,
    origin,
    pacing: telegramPacing,
    coordinator: notificationCoordinator,
    canRun: backgroundCanRun,
  });
  const appointmentState = {
    decorate: createAppointmentStateReader({
      platform,
      store: platform.telegram,
      tenantStore: pool.get,
      coordinator: notificationCoordinator,
    }),
  };
  const support = createSupportRuntime({
    runBackgroundWork,
    store: platform.support,
    origin,
    ...(options.supportDelivery === undefined
      ? configuredSupportDelivery()
      : options.supportDelivery),
    canRun: backgroundCanRun,
  });
  // Prepared schema and verified /me identity only; no migration or API request here.
  const maxConnections = createMaxConnections({
    platform,
    tenantStore: pool.get,
    links: maxLinks || null,
    botIdentity: options.maxBotIdentity || null,
    enabled: options.maxConnectionsEnabled === true,
    coordinator: notificationCoordinator,
  });
  const staffMax = createStaffMaxService({
    platform,
    identity: options.maxBotIdentity || null,
    enabled: options.maxConnectionsEnabled === true,
  });
  const maxEvents =
    options.maxConnectionsEnabled === true
      ? createMaxEvents({
          connections: maxConnections,
          coordinator: notificationCoordinator,
          staff: staffMax,
          botId: options.maxBotIdentity?.botId || '',
          secret: options.maxWebhookSecret || '',
          enabled: true,
        })
      : null;
  const maxRuntime = createMaxRuntime({
    runBackgroundWork,
    inbox: platform.maxInbox || options.maxInbox || null,
    events: maxEvents,
    bot: options.maxBot || null,
    identity: options.maxBotIdentity || null,
    pacing: maxPacing,
    staffDelivery: createStaffMaxRuntime({
      runBackgroundWork,
      platform,
      tenantStore: pool.get,
      store: platform.staffMaxNotifications,
      bot: options.maxBot || null,
      identity: options.maxBotIdentity || null,
      pacing: maxPacing,
      origin,
    }),
    canRun: backgroundCanRun,
  });
  const adminEmail = createAdminEmailRuntime({
    runBackgroundWork,
    queue: platform.admin.emailQueue,
    sendMail,
    canRun: backgroundCanRun,
  });
  const publicationRuntime = createBookingPublicationRuntime({
    runBackgroundWork,
    publication: platform.bookingPublication,
    canRun: backgroundCanRun,
  });
  const metrics = createRequestMetrics({
    enabled: options.metricsEnabled ?? process.env.CARTOTECA_METRICS === '1',
    assistantEnabled: options.assistantTimingEnabled ?? config.processRole !== 'background',
    intervalMs: options.metricsIntervalMs,
    resourceStats: () => ({
      tenantPool: pool.stats(),
      writeQueue: platform.writeQueueStats(),
      sharedCabinetQueue: platform.sharedCabinetStats?.() || null,
      readBudgetQueue: platform.readBudgetQueueStats?.() || null,
      readCache: readCacheBudget.stats(),
      requestDispatcher: requestDispatcher.stats(),
      requestWork: requestDispatcher.workStats(),
      assistant: platform.assistant.runtimeStats?.() || null,
      photoReads: photoReader.stats(),
      passwordWork: require('../infrastructure/password-work.cjs').passwordWork.stats(),
      background: backgroundStatus(),
      notificationMaintenance: platform.notificationMaintenance.stats(),
      sessionMaintenance: platform.sessionMaintenance.stats(),
      pushDelivery: staffPush.stats(),
    }),
    ...(options.metricsEmit ? { emit: options.metricsEmit } : {}),
  });
  const server = http.createServer(
    require('../http/internal-ingress.cjs').createInternalIngress(
      createRequestHandler({
        config,
        platform,
        pool,
        routes,
        metrics,
        requestDispatcher,
        clientAddress,
        sendMail,
        assetRoot: publicAssetRoot(root),
        services: {
          telegram,
          appointmentState,
          notificationCoordinator,
          maxConnections,
          maxRuntime,
          staffMax,
          support,
          calendarFeeds,
          staffPush,
          adminEmail,
        },
      }),
      config.internalIngressSecret,
    ),
  );
  // Private process bridge only; never exposed as an HTTP route or config.
  server.nativeProviderStatus = () => ({
    telegram: telegram.status(),
    providers: {
      telegram: {
        configured: Boolean(telegramBot),
        connected: Boolean(telegram.status().connected),
        botId: telegram.status().botId || '',
      },
      max: {
        configured: Boolean(options.maxBot && options.maxBotIdentity),
        connected: Boolean(options.maxBot && options.maxBotIdentity),
        botId: options.maxBotIdentity?.botId || '',
      },
    },
  });
  server.telegramRuntime = telegram;
  server.staffPushRuntime = staffPush;
  server.maxRuntime = maxRuntime;
  server.requestMetrics = metrics;
  server.supportRuntime = support;
  server.adminEmailRuntime = adminEmail;
  server.bookingPublicationRuntime = publicationRuntime;
  server.processRole = config.processRole;
  const processOwner = require('node:crypto').randomUUID();
  const roleRenewalDiagnostics = createRoleRenewalDiagnostics({ role: config.processRole });
  const identityStartup = require('./identity-startup.cjs').createIdentityStartup({
    initialize: (signal) => telegram.initialize(signal),
  });
  const stopBackground = () => {
    roleLeaseUntil = 0;
    clearInterval(roleTimer);
    roleTimer = null;
    // Stop every runtime even if a failed database prevents one lease release.
    for (const runtime of [
      platform.notificationMaintenance,
      platform.sessionMaintenance,
      telegram,
      staffPush,
      maxRuntime,
      support,
      adminEmail,
      publicationRuntime,
    ]) {
      try {
        runtime.stop();
      } catch {
        /* The owning process is already stopping. */
      }
    }
    if (roleLease) {
      try {
        platform.processRoles.release(processOwner, roleLease);
      } catch {
        /* Lease expires. */
      }
      roleLease = null;
    }
  };
  server.backgroundStatus = backgroundStatus;
  // A finite owner may stop delivery while HTTP remains available for receipt
  // reconciliation. The process cannot acquire a second background lifetime.
  server.stopBackground = () => {
    if (closed || !backgroundStarted || !roleLease) return false;
    stopBackground();
    if (backgroundState !== 'lease-lost') backgroundState = 'stopped';
    return true;
  };
  server.startBackground = () => {
    if (
      closed ||
      backgroundStarted ||
      options.releaseGate ||
      !['combined', 'background'].includes(config.processRole)
    )
      return false;
    const acquiredAt = Date.now();
    roleLease = platform.processRoles.acquire(config.processRole, processOwner, acquiredAt);
    roleLeaseUntil = acquiredAt + platform.processRoles.durationMs;
    backgroundStarted = true;
    backgroundState = 'running';
    let expectedRenewalAt = acquiredAt + 10000;
    roleTimer = setInterval(() => {
      const attemptedAt = Date.now();
      const expectedAt = expectedRenewalAt;
      expectedRenewalAt = attemptedAt + 10000;
      try {
        const renewedAt = Date.now();
        if (platform.processRoles.renew(processOwner, roleLease, renewedAt)) {
          roleLeaseUntil = renewedAt + platform.processRoles.durationMs;
          return;
        }
        roleRenewalDiagnostics.report(null, {
          attemptedAt,
          expectedAt,
          finishedAt: Date.now(),
          confirmedUntil: roleLeaseUntil,
        });
      } catch (error) {
        roleRenewalDiagnostics.report(error, {
          attemptedAt,
          expectedAt,
          finishedAt: Date.now(),
          confirmedUntil: roleLeaseUntil,
        });
        // A refused PG BEGIN did not change the lease. Retry only on the next
        // normal tick while the already confirmed ownership is still valid.
        if (
          backgroundCanRun() &&
          error?.postgres === true &&
          error.postgresCode === 'POSTGRES_BUSY' &&
          error.code === 'ERR_SQLITE_ERROR' &&
          error.errcode === 5 &&
          error.retryableBeforeBegin === true &&
          error.transactionOpen === false &&
          error.channelPoisoned === false &&
          error.outcomeUnknown !== true
        )
          return;
        // A rolled-back lease-only lock refusal leaves the confirmed deadline
        // unchanged. No retry occurs before the next ordinary timer tick.
        if (
          backgroundCanRun() &&
          error?.postgres === true &&
          (error.code === 'POSTGRES_ROLE_AUTHORITY_BUSY' ||
            error.postgresCode === 'POSTGRES_ROLE_AUTHORITY_BUSY') &&
          error.leaseUnchanged === true &&
          error.transactionOpen === false &&
          error.channelPoisoned === false &&
          error.outcomeUnknown !== true
        )
          return;
        /* Every other failure stops scheduling and delivery attempts. */
      }
      backgroundState = 'lease-lost';
      stopBackground();
      console.error('Фоновая работа остановлена: не удалось продлить аренду процесса.');
      server.emit('backgroundError', Error('Background process lease lost.'));
    }, 10000);
    roleTimer.unref();
    platform.notificationMaintenance.start(backgroundCanRun, runBackgroundWork);
    platform.sessionMaintenance.start(backgroundCanRun, runBackgroundWork);
    if (options.pushAutostart !== false) staffPush.start();
    if (options.bookingPublicationAutostart !== false) publicationRuntime.start();
    if (options.adminEmailAutostart !== false) adminEmail.start();
    if (options.telegramAutostart !== false) telegram.start();
    if (options.maxAutostart === true) maxRuntime.start();
    if (options.supportAutostart !== false) support.start();
    return true;
  };
  server.once('listening', () => {
    if (config.processRole === 'web' && options.telegramIdentityAutostart && telegramBot)
      void identityStartup.start();
    server.startBackground();
  });
  server.once('close', () => {
    try {
      closed = true;
      requestDispatcher.close();
      identityStartup.stop();
      metrics.close();
      stopBackground();
      if (backgroundState !== 'lease-lost') backgroundState = 'stopped';
      platform.close();
      pool.close();
      legacyStorage.close();
      readCacheBudget.clear();
    } finally {
      assistantAuthority?.close();
      options.databaseOwner?.closeSync();
    }
  });
  return server;
}
module.exports = { createMultiServer, routes };
