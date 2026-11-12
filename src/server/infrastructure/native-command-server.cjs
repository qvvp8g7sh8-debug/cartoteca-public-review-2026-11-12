const http = require('node:http');
const path = require('node:path');
const { configuration } = require('../config.cjs');
const { createPlatformStore } = require('../application/platform.cjs');
const { createStorage } = require('./cabinet-storage.cjs');
const { createTenantPool } = require('./tenant-pool.cjs');
const { createReadCacheBudget } = require('./read-cache-budget.cjs');
const { createRequestDispatcher } = require('./request-dispatcher.cjs');
const { createRequestMetrics } = require('./request-metrics.cjs');
const { createRequestHandler } = require('../http/request-handler.cjs');
const { createInternalIngress } = require('../http/internal-ingress.cjs');
const { clientAddressResolver } = require('../../../client-address.cjs');
const { routes, isNativeCommand } = require('./native-command-routes.cjs');
const { providerSnapshot } = require('./native-application.cjs');
const { ticketHeader, createCommandResponseBudget } = require('./native-command-ticket.cjs');
const {
  createNotificationCoordinator,
} = require('../modules/notifications/notification-coordinator.cjs');
const {
  createAppointmentStateReader,
} = require('../modules/notifications/appointment-state-reader.cjs');

// Each bounded manual-command owner uses existing HTTP handlers and transaction
// functions. It owns no assistant, delivery adapter, scheduler or channel epoch.
function createNativeCommandServer(options = {}, observedProviders = null, tickets = null) {
  const config = configuration({ ...options, processRole: 'web' });
  if (!config.internalIngressSecret) throw Error('Native commands require private ingress.');
  let snapshot = providerSnapshot(observedProviders);
  if (!snapshot) throw Error('Native commands require a provider observation.');
  const budget = createReadCacheBudget({
    maxBytes: Math.min(config.tenantReadCacheBytes, 16 * 1024 * 1024),
  });
  let platform, pool, dispatcher, metrics;
  const cleanup = () => {
    try {
      dispatcher?.close();
      metrics?.close();
      pool?.close();
      platform?.close();
      budget.clear();
    } finally {
      config.databaseOwner?.closeSync();
    }
  };
  try {
    platform = createPlatformStore(path.join(config.dataDir, 'platform'), {
      databaseOwner: config.databaseOwner,
      notificationSchema: config.notificationSchema,
      sharedCabinetWrites: config.sharedCabinetWrites,
      isolatedReadBudgets: config.isolatedReadBudgets,
      scheduledNotifications: config.scheduledNotifications,
      scheduleStartupReconcile: false,
      notificationChannelProjection: true,
      assistantComposition: false,
      administrationComposition: false,
      assistantStateBackend: config.assistantStateBackend,
      paymentNetworkEnabled: false,
      notificationMaintenanceEnabled: false,
    });
    if (!platform.hasAccounts()) throw Error('Native commands require initialized accounts.');
    pool = createTenantPool({
      limit: Math.min(config.tenantCacheLimit, 16),
      idleMs: config.tenantIdleMs,
      open(org, observeOpen) {
        const organization = platform.organization(org);
        return createStorage(
          organization.legacyData ? config.dataDir : path.join(config.dataDir, 'tenants', org),
          {
            readCacheBudget: budget,
            databaseOwner: config.databaseOwner,
            databaseRoot: config.dataDir,
            cabinetSchema: config.cabinetSchema,
            photoOrganizationId: org,
            observeOpen,
          },
        );
      },
    });
    dispatcher = createRequestDispatcher();
    // Each execution owner reports its own save phases under the same operator
    // diagnostics setting. This timer never schedules business work.
    metrics = createRequestMetrics({
      enabled: config.metricsEnabled ?? process.env.CARTOTECA_METRICS === '1',
      intervalMs: config.metricsIntervalMs,
    });
    const providers = Object.fromEntries(
      ['telegram', 'max'].map((channel) => [
        channel,
        { status: () => snapshot.providers[channel] },
      ]),
    );
    const notificationCoordinator =
      config.commonNotificationsEnabled === true || config.maxEnabled === true
        ? createNotificationCoordinator({
            platform,
            tenantStore: pool.get,
            store: platform.notificationStore,
            links: platform.maxLinks,
            providers,
          })
        : null;
    const appointmentState = {
      decorate: createAppointmentStateReader({
        platform,
        store: platform.telegram,
        tenantStore: pool.get,
        coordinator: notificationCoordinator,
      }),
    };
    const handler = createRequestHandler({
      config,
      platform,
      pool,
      routes,
      metrics,
      requestDispatcher: dispatcher,
      clientAddress: clientAddressResolver(config.trustedProxies),
      sendMail: null,
      services: {
        telegram: { status: () => snapshot.telegram },
        appointmentState,
        notificationCoordinator,
      },
    });
    const server = http.createServer(
      createInternalIngress((req, res) => {
        if (isNativeCommand(req)) {
          const complete = tickets?.begin(req.headers[ticketHeader]);
          delete req.headers[ticketHeader];
          if (tickets && !complete) {
            res.shouldKeepAlive = false;
            res.writeHead(409, { Connection: 'close' });
            return res.end();
          }
          const retainedBytes = createCommandResponseBudget(res);
          void Promise.resolve()
            .then(() => handler(req, res))
            .finally(() => {
              const bytes = retainedBytes();
              complete?.(bytes);
            })
            .catch(() => res.destroy());
          return;
        }
        res.shouldKeepAlive = false;
        res.writeHead(404, { Connection: 'close' });
        res.end();
      }, config.internalIngressSecret),
    );
    server.nativeProviderStatus = () => structuredClone(snapshot);
    server.updateNativeProviderStatus = (value) => {
      const next = providerSnapshot(value);
      if (!next) throw Error('Invalid native provider observation.');
      snapshot = next;
    };
    server.processRole = 'command';
    server.backgroundStatus = () => ({ role: 'command', state: 'passive', active: false });
    server.startBackground = () => false;
    server.requestMetrics = metrics;
    server.once('close', cleanup);
    return server;
  } catch (error) {
    cleanup();
    throw error;
  }
}
module.exports = { createNativeCommandServer };
