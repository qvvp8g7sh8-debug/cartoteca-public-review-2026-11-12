const http = require('node:http');
const { isCommandNotStarted } = require('../infrastructure/native-command-outcome151.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { configuration } = require('../config.cjs');
const { startNativeApplication } = require('../infrastructure/native-application.cjs');
const { createNativeExecutor } = require('../infrastructure/native-executor.cjs');
const { createNativeMemoryWorkBudget } = require('../infrastructure/native-memory-work-budget.cjs');
const { isNativeQuery } = require('../infrastructure/native-query-kernel.cjs');
const {
  isPostgresReadOperation,
} = require('../infrastructure/postgres/read-operation-routes145.cjs');
const {
  isNativeCommand,
  nativeCommandOwnerCount,
} = require('../infrastructure/native-command-routes.cjs');
const { createNativeProxy } = require('../http/native-proxy.cjs');
const { createNativeCommandProxy } = require('../http/native-command-proxy.cjs');
const { json } = require('../http/responses.cjs');
const {
  configuredNativeMemoryBudget,
  nativeMemoryProcess,
  assertNativeMemoryEnvironment,
} = require('../infrastructure/native-memory-budget.cjs');
const {
  assertNativeMemoryProcess,
  sampleIsolateMemory,
  normalizeNativeMemoryReport,
} = require('../infrastructure/native-memory-observation.cjs');

function waitBounded(work, milliseconds, message) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

// The public event loop never opens SQLite or parses clinical JSON. Only closed
// reads use query executors; an attested/explicit profile separates the three
// manual-save routes from the single stateful assistant/web owner.
async function createIsolatedServer(
  options = {},
  {
    startApplication = startNativeApplication,
    createExecutor = createNativeExecutor,
    startupMs = 30000,
    shutdownMs = 4500,
  } = {},
) {
  if (![startupMs, shutdownMs].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 60000))
    throw Error('Invalid isolated lifecycle deadline.');
  const config = configuration(options);
  const commandCount = nativeCommandOwnerCount(config);
  const memoryBudget = configuredNativeMemoryBudget(config, commandCount);
  const gatewayMemory = memoryBudget ? nativeMemoryProcess(memoryBudget, 'gateway') : null;
  const workBudget = memoryBudget ? createNativeMemoryWorkBudget(memoryBudget.workAdmission) : null;
  if (gatewayMemory) {
    assertNativeMemoryEnvironment(process.env);
    assertNativeMemoryProcess(gatewayMemory);
  }
  const owner = await startApplication({ config });
  let queries,
    proxy,
    commands,
    server,
    closing,
    closeState = 'open';
  try {
    const snapshot = owner.providerStatus();
    const readConfig = {
      dataDir: config.dataDir,
      production: config.production,
      releaseGate: config.releaseGate,
      storageBackend: config.storageBackend,
      postgres: config.postgres,
      postgresProfile: config.postgresProfile,
      postgresAllowedHosts: config.postgresAllowedHosts,
      postgresPin: config.postgresPin,
      ...([2, 3].includes(config.postgresRevisionProfile)
        ? { postgresRevisionProfile: config.postgresRevisionProfile }
        : {}),
      readBudgetVersion: config.readBudgetVersion,
      bookingLinksVersion: config.bookingLinksVersion,
      origin: config.origin,
      additionalOrigins: config.additionalOrigins,
      notificationSchema: config.notificationSchema,
      cabinetSchema: config.cabinetSchema,
      sharedCabinetWrites: config.sharedCabinetWrites,
      isolatedReadBudgets: config.isolatedReadBudgets,
      commonNotificationsEnabled:
        config.commonNotificationsEnabled === true || config.maxEnabled === true,
      notificationChannels: {
        telegram: Boolean(snapshot?.providers.telegram.configured),
        max: Boolean(snapshot?.providers.max.configured),
        push: Boolean(config.pushEnabled && /^https:\/\//.test(config.origin)),
      },
      ...(gatewayMemory ? { nativeMemoryProcess: gatewayMemory } : {}),
      tenantReadCacheBytes: Math.min(
        config.tenantReadCacheBytes,
        gatewayMemory?.queryCacheBytes ?? 16 * 1024 * 1024,
      ),
      ...(memoryBudget?.budgetMiB === 8192 ? { directoryMaxRows180: 150000 } : {}),
      ...(config.nativeDirectorySnapshots180 === true ? { nativeDirectorySnapshots180: true } : {}),
      tenantCacheLimit: Math.min(config.tenantCacheLimit, 16),
      tenantIdleMs: config.tenantIdleMs,
    };
    queries = createExecutor({
      filename: path.resolve(__dirname, '../infrastructure/native-query-worker.cjs'),
      workerData: { config: readConfig },
      concurrency: config.nativeQueryWorkers,
      ...(config.nativeQueryAffinity184 === true ? { strictAffinity: true } : {}),
      cancelGraceMs: 100,
      ...(workBudget ? { workBudget } : {}),
      ...(workBudget && config.storageBackend === 'postgres' && config.postgresRevisionProfile === 3
        ? { boundedRead: isPostgresReadOperation }
        : {}),
      resourceLimits: gatewayMemory?.workerResourceLimits || { maxOldGenerationSizeMb: 256 },
      ...(gatewayMemory
        ? {
            memoryProcess: gatewayMemory,
            maxRequestBytes: 1024 * 1024,
            maxPendingBytes: 1024 * 1024,
          }
        : {}),
    });
    await waitBounded(queries.ready(), startupMs, 'Native query startup deadline exceeded.');
    if (owner.stats().state !== 'ready') throw Error('Application owner stopped during startup.');
    proxy = createNativeProxy({ endpoint: () => owner.endpoint() });
    if (commandCount >= 2 || (commandCount === 1 && workBudget))
      commands = createNativeCommandProxy({
        endpoint: (index) => owner.commandEndpoint(index),
        reserve: (index, ticket) => owner.reserveCommand(index, ticket),
        ownerCount: commandCount,
        ...(workBudget ? { workBudget, physicalClosed: () => owner.close() } : {}),
      });
    else if (commandCount === 1)
      commands = createNativeProxy({
        endpoint: () => owner.commandEndpoint(),
        activeLimit: 1,
        pendingLimit: 16,
        waitMs: 5000,
        timeoutMs: 120000,
      });
    server = http.createServer((req, res) => {
      req.pause();
      void handle(req, res).catch((error) => {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) return res.destroy();
        res.shouldKeepAlive = false;
        res.setHeader('Connection', 'close');
        if (error.status === 503) res.setHeader('Retry-After', '1');
        json(res, error.status || 503, {
          error: error.status ? error.message : 'Сервер временно недоступен.',
          ...(isNativeCommand(req) &&
          isCommandNotStarted(error) &&
          [503, 504].includes(error.status)
            ? { code: 'CABINET_COMMAND_NOT_STARTED' }
            : {}),
        });
      });
    });
    async function handle(req, res) {
      if (closing) throw Object.assign(Error('Сервер останавливается.'), { status: 503 });
      if (commands && isNativeCommand(req)) return commands.run(req, res);
      if (!isNativeQuery(req)) return proxy.run(req, res);
      if (owner.stats().state !== 'ready')
        throw Object.assign(Error('Сервер останавливается.'), { status: 503 });
      const abort = new AbortController();
      const cancel = () => abort.abort();
      req.once('aborted', cancel);
      res.once('close', cancel);
      let result;
      try {
        result = await queries.run(
          {
            kind: 'query',
            metadata: {
              method: req.method,
              url: req.url,
              headers: req.headers,
              localPort: req.socket.localPort,
              remoteAddress: req.socket.remoteAddress,
              runtime: owner.providerStatus(),
            },
          },
          {
            signal: abort.signal,
            mutating: false,
            affinityKey: createHash('sha256')
              .update(
                String(req.headers['x-cartoteca-account-id'] || '') +
                  ':' +
                  String(req.headers['x-cartoteca-organization-id'] || ''),
              )
              .digest('hex'),
          },
        );
        if (abort.signal.aborted || res.destroyed) return result.release();
        // A raw serialized result stays budgeted until the client finishes.
        res.once('finish', result.release);
        res.once('close', result.release);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      } finally {
        req.removeListener('aborted', cancel);
        if (!result) res.removeListener('close', cancel);
      }
    }
    const originalClose = server.close.bind(server);
    const stop = () => {
      if (closing) return closing;
      closeState = 'closing';
      workBudget?.close();
      proxy.close();
      commands?.close();
      closing = waitBounded(
        Promise.all([queries.close(), owner.close()]),
        shutdownMs,
        'Native shutdown deadline exceeded.',
      ).then(
        () => {
          closeState = 'closed';
        },
        () => {
          closeState = 'failed';
          throw Object.assign(
            Error('Native shutdown could not confirm every owned executor exit.'),
            {
              code: 'NATIVE_SHUTDOWN_FAILED',
            },
          );
        },
      );
      return closing;
    };
    let httpClose;
    server.close = (callback) => {
      if (!httpClose)
        httpClose = (async () => {
          let failure;
          try {
            await stop();
          } catch (error) {
            failure = error;
            server.emit('backgroundError', error);
          }
          await new Promise((resolve) =>
            originalClose((error) => {
              if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') failure ||= error;
              resolve();
            }),
          );
          if (failure) throw failure;
        })();
      if (callback) void httpClose.then(() => callback(), callback);
      else void httpClose.catch(() => {});
      return server;
    };
    owner.once('failed', () => {
      server.emit('backgroundError', Error('Isolated application owner stopped.'));
      server.close();
    });
    server.isolationStatus = () => ({
      closeState,
      ...(gatewayMemory
        ? {
            memory: {
              budget: memoryBudget,
              work: workBudget.stats(),
              gateway: normalizeNativeMemoryReport({
                pid: process.pid,
                main: sampleIsolateMemory(),
              }),
            },
          }
        : {}),
      owner: owner.stats(),
      queries: queries.stats(),
      proxy: proxy.stats(),
      ...(commands ? { commands: commands.stats() } : {}),
    });
    return server;
  } catch (error) {
    workBudget?.close();
    proxy?.close();
    commands?.close();
    try {
      await waitBounded(
        Promise.all([queries?.close(), owner.close()]),
        shutdownMs,
        'Native startup cleanup deadline exceeded.',
      );
    } catch {
      throw Object.assign(
        Error('Native startup cleanup could not confirm every owned executor exit.'),
        {
          code: 'NATIVE_STARTUP_CLEANUP_FAILED',
        },
      );
    }
    throw error;
  }
}
module.exports = { createIsolatedServer };
