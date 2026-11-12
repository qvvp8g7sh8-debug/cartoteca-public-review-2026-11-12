const { createConfiguredMultiServer } = require('../application/max-startup.cjs');
const { createEntrypointLifecycle } = require('../application/entrypoint-lifecycle.cjs');
const { providerSnapshot } = require('./native-application.cjs');
const { createNativeCommandServer } = require('./native-command-server.cjs');
const protocol = 'cartoteca-native-application-v1';
const { nativeCommandOwnerCount } = require('./native-command-routes.cjs');
const { createCommandTicketState, ticketPattern } = require('./native-command-ticket.cjs');
const { nativeFailureDiagnostic } = require('./native-application-diagnostics.cjs');
const {
  assertNativeMemoryProcess,
  sampleIsolateMemory,
  normalizeNativeMemoryReport,
} = require('./native-memory-observation.cjs');

function validCommandIndex(message) {
  if (message.role !== 'command' || message.commandIndex === undefined) return true;
  try {
    return (
      Number.isInteger(message.commandIndex) &&
      message.commandIndex >= 0 &&
      message.commandIndex < nativeCommandOwnerCount(message.config)
    );
  } catch {
    return false;
  }
}

async function runNativeApplicationChild(
  runtime = process,
  {
    createServer = createConfiguredMultiServer,
    createCommandServer = createNativeCommandServer,
    createLifecycle = createEntrypointLifecycle,
  } = {},
) {
  if (typeof runtime.send !== 'function')
    throw Error('Native application child requires private IPC.');
  let initialized = false,
    server,
    statusTimer,
    memoryTimer,
    memoryBudget,
    startupTimer,
    startMessage,
    databaseOwner,
    commandTickets,
    phase = 'handshake';
  const lifecycle = createLifecycle({ process: runtime });
  const send = (type, values = {}) => {
    if (!runtime.connected || !startMessage) return;
    runtime.send(
      { type, protocol, nonce: startMessage.nonce, role: startMessage.role, ...values },
      () => {},
    );
  };
  const memoryReport = () =>
    normalizeNativeMemoryReport({
      pid: runtime.pid,
      main: sampleIsolateMemory(),
      database: databaseOwner?.stats().memory,
      lease: databaseOwner?.processRoles?.stats().memory,
    });
  const providers = () => {
    if (typeof server?.nativeProviderStatus === 'function')
      return providerSnapshot(server.nativeProviderStatus());
    // No false-ready fallback for a binary lacking the read-status contract.
    return null;
  };
  runtime.once('disconnect', () => lifecycle.stop(1));
  const onStart = async (message) => {
    if (message === 'stop') return;
    if (
      initialized &&
      commandTickets &&
      ['command-reserve', 'command-cancel'].includes(message?.type) &&
      message.protocol === protocol &&
      message.nonce === startMessage.nonce &&
      message.role === 'command' &&
      ticketPattern.test(message.ticket || '')
    ) {
      if (message.type === 'command-reserve')
        send('command-reserved', {
          pid: runtime.pid,
          ticket: message.ticket,
          accepted: commandTickets.reserve(message.ticket),
        });
      else commandTickets.cancel(message.ticket);
      return;
    }
    if (
      initialized &&
      startMessage?.role === 'command' &&
      message?.type === 'providers' &&
      message.protocol === protocol &&
      message.nonce === startMessage.nonce &&
      message.role === 'command'
    ) {
      server?.updateNativeProviderStatus(message.providers);
      return;
    }
    if (initialized || message?.type !== 'start' || message.protocol !== protocol) return;
    initialized = true;
    clearTimeout(startupTimer);
    if (
      !['web', 'background', 'command'].includes(message.role) ||
      typeof message.nonce !== 'string' ||
      typeof message.secret !== 'string' ||
      !/^[a-f0-9]{64}$/.test(message.secret) ||
      !message.config ||
      typeof message.config !== 'object' ||
      !validCommandIndex(message)
    ) {
      lifecycle.stop(1);
      return;
    }
    startMessage = message;
    try {
      const managedMemory = message.config.nativeMemoryBudgetVersion === 1;
      const memoryProcess = managedMemory ? message.memoryBudget : null;
      if (managedMemory) memoryBudget = assertNativeMemoryProcess(memoryProcess);
      phase = 'postgres-owner';
      const options = await require('./postgres/initialize.cjs').initializePostgresOwner(
        {
          ...message.config,
          ...(memoryProcess
            ? {
                nativeMemoryProcess: memoryProcess,
                tenantReadCacheBytes: Math.min(
                  message.config.tenantReadCacheBytes ?? memoryProcess.cacheBytes,
                  memoryProcess.cacheBytes,
                ),
              }
            : {}),
          processRole: message.role === 'command' ? 'web' : message.role,
        },
        {
          onFatal: () => {
            send('failed', {
              code: 'POSTGRES_EXECUTOR_FAILED',
              diagnostic: nativeFailureDiagnostic(message.role, phase, {
                code: 'POSTGRES_EXECUTOR_FAILED',
              }),
            });
            lifecycle.stop(1);
          },
        },
      );
      databaseOwner = options.databaseOwner;
      const initializeIdentity =
        message.config.telegramIdentityAutostart ?? message.config.telegramAutostart !== false;
      if (message.role === 'web' || message.role === 'command') {
        options.internalIngressSecret = message.secret;
        // Initialize the same read identity once before readiness. A local
        // preview that disabled identity keeps that setting and makes no call.
        options.telegramIdentityAutostart = false;
      } else delete options.internalIngressSecret;
      if (
        message.role === 'command' &&
        (message.config.postgresRevisionProfile === 3 || memoryProcess)
      )
        commandTickets = createCommandTicketState((ticket, retainedBytes) =>
          send('command-finished', { pid: runtime.pid, ticket, retainedBytes }),
        );
      phase = 'composition';
      server =
        message.role === 'command'
          ? await createCommandServer(options, message.providers, commandTickets)
          : await createServer(options);
      phase = 'lifecycle';
      if (!lifecycle.attach(server)) return;
      server.once('error', (error) => {
        send('failed', {
          code: 'NATIVE_LISTENER_FAILED',
          diagnostic: nativeFailureDiagnostic(message.role, phase, error),
        });
        lifecycle.stop(1);
      });
      const observedMemory = () => {
        try {
          return memoryReport();
        } catch {
          return null;
        }
      };
      const announce = (port) => {
        const memory = memoryBudget ? observedMemory() : null;
        if (memoryBudget && !memory) {
          send('failed', {
            code: 'NATIVE_MEMORY_BUDGET_MISMATCH',
            diagnostic: nativeFailureDiagnostic(message.role, phase, {
              code: 'NATIVE_MEMORY_BUDGET_MISMATCH',
            }),
          });
          lifecycle.stop(1);
          return;
        }
        phase = 'ready';
        send('ready', {
          pid: runtime.pid,
          port,
          backgroundActive: server.backgroundStatus().active,
          providers: message.role === 'web' ? providers() : null,
          ...(memoryBudget ? { memoryBudget, memory } : {}),
        });
        if (memoryBudget) {
          memoryTimer = setInterval(() => {
            const sample = observedMemory();
            // Missing diagnostics never change a live transaction or lease.
            // The last valid sample retains its timestamp and is visibly stale.
            if (sample) send('memory', { pid: runtime.pid, memory: sample });
          }, 1000);
          memoryTimer.unref();
        }
      };
      server.once('close', () => {
        clearInterval(statusTimer);
        clearInterval(memoryTimer);
      });
      if (message.role === 'background') {
        phase = 'background';
        const keepAlive = setInterval(() => {}, 2147483647);
        server.once('close', () => clearInterval(keepAlive));
        server.startBackground();
        if (
          server.backgroundStatus().active !== !message.config.releaseGate ||
          server.address() !== null
        )
          throw Error('Background owner failed to start.');
        announce(null);
      } else {
        if (typeof server.nativeProviderStatus !== 'function')
          throw Error('Native application provider-status contract missing.');
        phase = 'identity';
        if (
          message.role === 'web' &&
          initializeIdentity &&
          server.telegramRuntime.status().configured
        )
          await server.telegramRuntime.initialize();
        phase = 'listener';
        server.listen(0, '127.0.0.1', () => {
          announce(server.address().port);
          if (message.role === 'web') {
            statusTimer = setInterval(() => send('status', { providers: providers() }), 1000);
            statusTimer.unref();
          }
        });
      }
    } catch (error) {
      try {
        databaseOwner?.closeSync();
      } catch {}
      send('failed', {
        code: 'NATIVE_STARTUP_FAILED',
        diagnostic: nativeFailureDiagnostic(message.role, phase, error),
      });
      lifecycle.stop(1);
    }
  };
  // With no start handshake the owned process exits; there is no orphan listener.
  startupTimer = setTimeout(() => lifecycle.stop(1), 30000);
  runtime.on('message', onStart);
}
if (require.main === module) runNativeApplicationChild().catch(() => process.exit(1));
module.exports = { runNativeApplicationChild };
