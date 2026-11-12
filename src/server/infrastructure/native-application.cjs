const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { nativeCommandOwnerCount } = require('./native-command-routes.cjs');
const { ticketPattern } = require('./native-command-ticket.cjs');
const { nativeFailureDiagnostic } = require('./native-application-diagnostics.cjs');
const {
  configuredNativeMemoryBudget,
  nativeMemoryProcess,
  assertNativeMemoryEnvironment,
} = require('./native-memory-budget.cjs');

const protocol = 'cartoteca-native-application-v1';
const entry = path.join(__dirname, 'native-application-child.cjs');
function bounded(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw Error('Invalid native application resource bound.');
  return value;
}
function plainConfiguration(value, depth = 0, budget = { entries: 0 }) {
  if (++budget.entries > 4096 || depth > 12) throw Error('Native configuration is too large.');
  if (value === undefined || value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    throw Error('Native configuration must contain serializable options only.');
  for (const item of Object.values(value)) plainConfiguration(item, depth + 1, budget);
}
function providerSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (value, maximum = 256) =>
    typeof value === 'string' && value.length <= maximum ? value : '';
  const provider = (row) => ({
    configured: row?.configured === true,
    connected: row?.connected === true,
    botId: text(row?.botId),
  });
  return {
    telegram: {
      configured: value.telegram?.configured === true,
      connected: value.telegram?.connected === true,
      username: text(value.telegram?.username, 64),
      botId: text(value.telegram?.botId),
      error: value.telegram?.error ? 'Telegram temporarily unavailable.' : '',
    },
    providers: {
      telegram: provider(value.providers?.telegram),
      max: provider(value.providers?.max),
    },
    timestamp: Date.now(),
  };
}

// Exactly one stateful assistant/web owner and one independent background owner.
// Prepared v2 adds one manual owner; v3 adds exactly two, never a web pool.
// No request is replayed across process death; durable operation receipts remain
// the application's authority for writes whose response was interrupted.
async function startNativeApplication({
  config,
  environment = process.env,
  startupTimeoutMs = 30000,
  shutdownTimeoutMs = 3000,
  killGraceMs = 1000,
  webHeapMiB,
  backgroundHeapMiB,
  commandHeapMiB,
  spawn = fork,
} = {}) {
  if (
    !config ||
    typeof config !== 'object' ||
    ((config.production || config.releaseGate) &&
      !require('./postgres/connection.cjs').productionPostgresProfile(config))
  )
    throw Error('Native isolation is an explicit local profile.');
  plainConfiguration(config);
  const commandCount = nativeCommandOwnerCount(config);
  const commandEnabled = commandCount > 0;
  const memoryBudget = configuredNativeMemoryBudget(config, commandCount);
  if (memoryBudget) {
    if ([webHeapMiB, backgroundHeapMiB, commandHeapMiB].some((value) => value !== undefined))
      throw Object.assign(Error('Managed memory cannot use independent heap overrides.'), {
        code: 'NATIVE_MEMORY_FLAGS_CONFLICT',
      });
    assertNativeMemoryEnvironment(environment);
  } else {
    if (webHeapMiB === undefined) webHeapMiB = 768;
    if (backgroundHeapMiB === undefined) backgroundHeapMiB = 256;
    if (commandHeapMiB === undefined) commandHeapMiB = webHeapMiB;
    bounded(webHeapMiB, 64, 2048);
    bounded(backgroundHeapMiB, 64, 1024);
    bounded(commandHeapMiB, 64, 2048);
  }
  bounded(startupTimeoutMs, 100, 60000);
  bounded(shutdownTimeoutMs, 100, 10000);
  bounded(killGraceMs, 100, 5000);
  const owner = new EventEmitter(),
    nonce = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const commandSecrets = Array.from({ length: commandCount }, () =>
    randomBytes(32).toString('hex'),
  );
  const commandEndpoints = [];
  const records = new Map();
  let state = 'starting',
    endpoint,
    snapshot = null,
    closePromise,
    startTimer,
    lastFailure = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const publicError = () =>
    Object.assign(Error('Native application owner is unavailable.'), {
      code: 'NATIVE_APPLICATION_UNAVAILABLE',
      ...(lastFailure ? { diagnostic: { ...lastFailure } } : {}),
    });
  const complete = () => [...records.values()].every((record) => record.exited);
  function fail(diagnostic) {
    if (state === 'closing' || state === 'closed' || state === 'failed') return;
    if (diagnostic)
      lastFailure = nativeFailureDiagnostic(diagnostic.role, diagnostic.phase, {
        code: diagnostic.cause,
      });
    const wasReady = state === 'ready';
    state = 'failed';
    clearTimeout(startTimer);
    rejectReady(publicError());
    if (wasReady) owner.emit('failed', publicError());
    void close().catch(() => {});
  }
  function launch(role, commandIndex = 0) {
    const identity = role === 'command' && commandIndex ? 'command-' + commandIndex : role;
    const memoryPlan = memoryBudget ? nativeMemoryProcess(memoryBudget, identity) : null;
    const child = spawn(entry, [], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...environment },
      execArgv: memoryPlan
        ? [...memoryPlan.execArgv]
        : [
            '--max-old-space-size=' +
              (role === 'web'
                ? webHeapMiB
                : role === 'command'
                  ? commandHeapMiB
                  : backgroundHeapMiB),
          ],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    const record = {
      role,
      child,
      pid: child.pid,
      ready: false,
      exited: false,
      code: null,
      signal: null,
      commandLease: null,
      memoryBudget: null,
      memory: null,
    };
    const memoryFailure = () =>
      fail({ role, phase: 'handshake', cause: 'NATIVE_MEMORY_ATTESTATION' });
    const reportMemory = (report) => {
      const value = require('./native-memory-observation.cjs').normalizeNativeMemoryReport(report);
      if (!value || value.pid !== child.pid) throw Error('Native memory report identity mismatch.');
      return value;
    };
    records.set(identity, record);
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      record.exited = true;
      record.code = Number.isInteger(code) ? code : null;
      record.signal = typeof signal === 'string' ? signal : null;
      owner.emit('childExit');
      if (state === 'starting' || state === 'ready') fail();
    });
    child.on('message', (message) => {
      if (
        !message ||
        message.protocol !== protocol ||
        message.nonce !== nonce ||
        message.role !== role
      )
        return;
      if (message.type === 'failed')
        return fail(
          nativeFailureDiagnostic(role, message.diagnostic?.phase, {
            code: message.diagnostic?.cause || message.code,
          }),
        );
      if (['command-reserved', 'command-finished'].includes(message.type)) {
        const lease = record.commandLease;
        if (
          role !== 'command' ||
          !record.ready ||
          message.pid !== child.pid ||
          !lease ||
          message.ticket !== lease.ticket
        )
          return;
        if (message.type === 'command-reserved') {
          if (message.accepted !== true) return fail();
          lease.reserved = true;
          lease.accept();
        } else if (lease.reserved) {
          record.commandLease = null;
          lease.finish({ retainedBytes: message.retainedBytes });
        }
        return;
      }
      if (message.type === 'memory') {
        if (!memoryPlan || !record.ready || state !== 'ready' || message.pid !== child.pid) return;
        try {
          record.memory = reportMemory(message.memory);
        } catch {
          memoryFailure();
        }
        return;
      }
      if (message.type === 'status') {
        if (role === 'web' && record.ready && state === 'ready') {
          snapshot = providerSnapshot(message.providers);
          for (const command of records.values())
            if (command.role === 'command' && command.ready && !command.exited)
              command.child.send(
                { type: 'providers', protocol, nonce, role: 'command', providers: snapshot },
                (error) => {
                  if (error) fail();
                },
              );
          owner.emit('status', owner.providerStatus());
        }
        return;
      }
      if (
        message.type !== 'ready' ||
        record.ready ||
        state !== 'starting' ||
        message.pid !== child.pid
      )
        return;
      if (memoryPlan) {
        const observed = message.memoryBudget;
        if (
          observed?.version !== 1 ||
          observed.identity !== identity ||
          observed.heapSizeLimitBytes !== memoryPlan.heapCeilingMiB * 1024 * 1024
        )
          return memoryFailure();
        record.memoryBudget = Object.freeze({
          version: 1,
          identity,
          heapSizeLimitBytes: observed.heapSizeLimitBytes,
        });
        if (message.memory !== undefined) {
          try {
            record.memory = reportMemory(message.memory);
          } catch {
            return memoryFailure();
          }
        }
      }
      if (role === 'background') {
        if (message.port !== null || message.backgroundActive !== !config.releaseGate)
          return fail();
        record.ready = true;
        try {
          launch('web');
        } catch {
          fail();
        }
      } else {
        if (
          !Number.isSafeInteger(message.port) ||
          message.port < 1 ||
          message.port > 65535 ||
          message.backgroundActive !== false
        )
          return fail();
        record.ready = true;
        if (role === 'web') {
          endpoint = Object.freeze({
            host: '127.0.0.1',
            port: message.port,
            transportToken: secret,
          });
          snapshot = providerSnapshot(message.providers);
          if (commandEnabled) {
            if (!snapshot) return fail();
            try {
              launch('command', 0);
            } catch {
              fail();
            }
            return;
          }
        } else {
          commandEndpoints[commandIndex] = Object.freeze({
            host: '127.0.0.1',
            port: message.port,
            transportToken: commandSecrets[commandIndex],
          });
          if (commandIndex + 1 < commandCount) {
            try {
              launch('command', commandIndex + 1);
            } catch {
              fail();
            }
            return;
          }
          if (commandEndpoints.filter(Boolean).length !== commandCount) return;
        }
        state = 'ready';
        clearTimeout(startTimer);
        resolveReady(owner);
      }
    });
    child.send(
      {
        type: 'start',
        protocol,
        nonce,
        role,
        config,
        ...(memoryPlan ? { memoryBudget: memoryPlan } : {}),
        secret: role === 'command' ? commandSecrets[commandIndex] : secret,
        ...(role === 'command' ? { providers: snapshot, commandIndex } : {}),
      },
      (error) => {
        if (error) fail();
      },
    );
  }
  function waitForExit(milliseconds) {
    if (complete()) return Promise.resolve();
    return new Promise((resolve) => {
      const finished = () => {
        if (complete()) cleanup();
      };
      const timer = setTimeout(cleanup, milliseconds);
      function cleanup() {
        clearTimeout(timer);
        owner.off('childExit', finished);
        resolve();
      }
      owner.on('childExit', finished);
      finished();
    });
  }
  function close() {
    if (closePromise) return closePromise;
    if (state === 'starting') rejectReady(publicError());
    state = 'closing';
    clearTimeout(startTimer);
    closePromise = (async () => {
      for (const record of records.values()) {
        const { child, exited } = record;
        if (record.commandLease) {
          record.commandLease.reject(publicError());
          record.commandLease = null;
        }
        if (exited) continue;
        try {
          if (child.connected) child.send('stop', () => {});
          else child.kill();
        } catch {}
      }
      await waitForExit(shutdownTimeoutMs);
      for (const { child, exited } of records.values())
        if (!exited) {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      await waitForExit(killGraceMs);
      if (!complete()) {
        state = 'failed';
        throw publicError();
      }
      state = 'closed';
    })();
    return closePromise;
  }
  owner.endpoint = () => {
    if (state !== 'ready') throw publicError();
    return endpoint;
  };
  owner.commandEndpoint = (index = 0) => {
    if (
      state !== 'ready' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= commandCount ||
      !commandEndpoints[index]
    )
      throw publicError();
    return commandEndpoints[index];
  };
  owner.commandEndpoints = () => {
    if (state !== 'ready' || !commandEnabled) throw publicError();
    return Object.freeze([...commandEndpoints]);
  };
  owner.reserveCommand = (index, ticket) => {
    if (
      state !== 'ready' ||
      (commandCount < 2 && !(commandCount === 1 && memoryBudget)) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= commandCount ||
      !ticketPattern.test(ticket || '')
    )
      throw publicError();
    const record = records.get(index ? 'command-' + index : 'command');
    if (!record?.ready || record.exited || record.commandLease) throw publicError();
    let accept, finish, rejectReady, rejectDone;
    const ready = new Promise((resolve, reject) => {
      accept = resolve;
      rejectReady = reject;
    });
    const completed = new Promise((resolve, reject) => {
      finish = resolve;
      rejectDone = reject;
    });
    ready.catch(() => {});
    completed.catch(() => {});
    const sendTicket = (type) => {
      try {
        record.child.send({ type, protocol, nonce, role: 'command', ticket }, (error) => {
          if (error) fail();
        });
      } catch {
        fail();
      }
    };
    record.commandLease = {
      ticket,
      reserved: false,
      accept,
      finish,
      reject(error) {
        rejectReady(error);
        rejectDone(error);
      },
    };
    sendTicket('command-reserve');
    return {
      ready,
      completed,
      cancel: () => {
        if (state === 'ready' && record.commandLease?.ticket === ticket)
          sendTicket('command-cancel');
      },
    };
  };
  owner.providerStatus = () => (snapshot ? structuredClone(snapshot) : null);
  owner.status = owner.stats = () => ({
    state,
    ...(memoryBudget ? { memoryBudget } : {}),
    ...(lastFailure ? { failure: { ...lastFailure } } : {}),
    application: records.has('web') ? publicRecord(records.get('web')) : null,
    background: records.has('background') ? publicRecord(records.get('background')) : null,
    ...(commandEnabled
      ? { command: records.has('command') ? publicRecord(records.get('command')) : null }
      : {}),
    ...(commandCount >= 2 || (commandCount === 1 && memoryBudget)
      ? { commands: [...records.values()].filter((r) => r.role === 'command').map(publicRecord) }
      : {}),
  });
  owner.close = close;
  function publicRecord(record) {
    return {
      role: record.role,
      pid: record.pid,
      ready: record.ready,
      exited: record.exited,
      code: record.code,
      signal: record.signal,
      ...(memoryBudget
        ? {
            memoryBudget: record.memoryBudget,
            memory: record.memory ? structuredClone(record.memory) : null,
          }
        : {}),
    };
  }
  startTimer = setTimeout(fail, startupTimeoutMs);
  try {
    launch('background');
  } catch {
    fail();
  }
  try {
    return await ready;
  } catch (error) {
    // Rejected startup does not abandon a still-running background sibling.
    try {
      await close();
    } catch {}
    throw error;
  }
}
module.exports = { startNativeApplication, providerSnapshot };
