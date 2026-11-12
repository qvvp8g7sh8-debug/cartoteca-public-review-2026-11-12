const { SharedArrayBuffer, Int32Array, Atomics, ArrayBuffer } = globalThis;
const path = require('node:path');
const v8 = require('node:v8');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');
const { createMemoryMailbox, readMemorySample } = require('../native-memory-observation.cjs');

function failure(code, unknown = false) {
  const error = Error('Хранилище временно недоступно.');
  error.code = code;
  error.status = 503;
  if (unknown) error.outcomeUnknown = true;
  return error;
}
function bounded(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
function createTransport(options = {}) {
  const timeoutMs = bounded(options.timeoutMs, 5000, 10, 300000);
  const maxCommandBytes = bounded(
    options.maxCommandBytes,
    64 * 1024 * 1024,
    1024,
    256 * 1024 * 1024,
  );
  const maxReplyBytes = bounded(options.maxReplyBytes, 128 * 1024 * 1024, 1024, 512 * 1024 * 1024);
  const inlineBytes = bounded(options.inlineBytes, 64 * 1024, 1024, 1024 * 1024);
  const mailbox = new SharedArrayBuffer(16 + inlineBytes);
  const state = new Int32Array(mailbox, 0, 4);
  const inline = new Uint8Array(mailbox, 16);
  const channel = new MessageChannel();
  const memoryMailbox = options.nativeMemoryProcess
    ? options.nativeMemoryMailbox || createMemoryMailbox()
    : null;
  function memorySample() {
    try {
      return readMemorySample(memoryMailbox);
    } catch {
      return null;
    }
  }
  const workerFactory = options.workerFactory || ((file, settings) => new Worker(file, settings));
  let ready = false;
  let closed = false;
  let exited = false;
  let poisoned = null;
  let running = false;
  let sequence = 0;
  let calls = 0;
  let activeId = 0;
  let resolveReady;
  let rejectReady;
  let resolveExit;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Constructor callers may compose readiness after creating multiple owners.
  readyPromise.catch(() => {});
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const worker = workerFactory(options.filename || path.join(__dirname, 'driver-worker.cjs'), {
    workerData: {
      connection: options.connection,
      ...(memoryMailbox ? { memoryMailbox, memoryProcess: options.nativeMemoryProcess } : {}),
      ...(options.roleProfile ? { roleProfile: options.roleProfile } : {}),
      mailbox,
      replyPort: channel.port2,
      maxCommandBytes,
      maxReplyBytes,
      statementTimeoutMs: Math.max(1, timeoutMs - Math.min(250, Math.floor(timeoutMs / 10))),
      maxCursors: bounded(options.maxCursors, 16, 1, 128),
    },
    transferList: [channel.port2],
    resourceLimits: options.nativeMemoryProcess?.workerResourceLimits ||
      options.resourceLimits || { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
  });
  channel.port1.unref();
  function poison(error) {
    if (!poisoned) {
      poisoned = error;
      if (typeof options.onFatal === 'function') {
        const event = Object.freeze({
          code: error.code || 'POSTGRES_WORKER_FAILED',
          outcomeUnknown: error.outcomeUnknown === true,
        });
        const scheduled = setTimeout(() => {
          try {
            const pending = options.onFatal(event);
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
          } catch {}
        }, 0);
        scheduled.unref?.();
      }
    }
    rejectReady(poisoned);
    return poisoned;
  }
  function terminate() {
    try {
      const pending = worker.terminate();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {}
  }
  const startupTimer = setTimeout(
    () => {
      poison(failure('POSTGRES_STARTUP_TIMEOUT'));
      terminate();
    },
    bounded(options.startupMs, timeoutMs, 10, 300000),
  );
  startupTimer.unref?.();
  worker.on('message', (message) => {
    if (message?.type === 'ready' && !closed && !poisoned) {
      if (
        memoryMailbox &&
        memorySample()?.heapSizeLimitBytes !==
          options.nativeMemoryProcess.heapCeilingMiB * 1024 * 1024
      ) {
        poison(failure('NATIVE_MEMORY_BUDGET_MISMATCH'));
        terminate();
        return;
      }
      ready = true;
      clearTimeout(startupTimer);
      resolveReady();
    } else if (message?.type === 'fatal') {
      poison(failure(message.code || 'POSTGRES_WORKER_FAILED', running));
    }
  });
  worker.on('error', (error) => {
    poison(
      failure(
        error?.code === 'NATIVE_MEMORY_BUDGET_MISMATCH'
          ? 'NATIVE_MEMORY_BUDGET_MISMATCH'
          : 'POSTGRES_WORKER_FAILED',
        running,
      ),
    );
    terminate();
  });
  worker.on('exit', () => {
    exited = true;
    activeId = 0;
    ready = false;
    clearTimeout(startupTimer);
    if (!closed) poison(failure('POSTGRES_WORKER_EXIT', running));
    channel.port1.close();
    resolveExit();
  });
  function request(command, { mutating = false } = {}) {
    if (closed) throw failure('POSTGRES_CLOSED');
    if (poisoned) throw poisoned;
    if (!ready) throw failure('POSTGRES_NOT_READY');
    if (running) throw failure('POSTGRES_REENTRANT_RPC');
    const bytes = v8.serialize(command);
    if (bytes.length > maxCommandBytes) throw failure('POSTGRES_COMMAND_TOO_LARGE');
    const owned = Uint8Array.from(bytes);
    const id = (sequence = sequence >= 0x7ffffffe ? 1 : sequence + 1);
    const deadline = Date.now() + timeoutMs;
    running = true;
    activeId = id;
    calls++;
    Atomics.store(state, 0, 0);
    Atomics.store(state, 1, 0);
    Atomics.store(state, 2, id);
    Atomics.store(state, 3, 0);
    try {
      worker.postMessage(
        {
          id,
          bytes: owned.buffer,
          sqlDeadline: deadline - Math.min(250, Math.floor(timeoutMs / 10)),
        },
        [owned.buffer],
      );
      while (Atomics.load(state, 0) === 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw failure('POSTGRES_RPC_TIMEOUT', mutating);
        Atomics.wait(state, 0, 0, remaining);
      }
      if (Atomics.load(state, 2) !== id) throw failure('POSTGRES_PROTOCOL_ERROR', mutating);
      const length = Atomics.load(state, 1);
      if (!Number.isSafeInteger(length) || length < 0 || length > maxReplyBytes)
        throw failure('POSTGRES_REPLY_TOO_LARGE', mutating);
      let reply;
      if (Atomics.load(state, 0) === 1) {
        if (length > inline.length) throw failure('POSTGRES_PROTOCOL_ERROR', mutating);
        reply = v8.deserialize(Buffer.from(inline.subarray(0, length)));
      } else if (Atomics.load(state, 0) === 2) {
        let envelope;
        // Port messages are transferred before the worker's SAB completion flag.
        // Polling never needs an event callback on this blocked isolated owner.
        while (!envelope) {
          envelope = receiveMessageOnPort(channel.port1)?.message;
          if (!envelope && Date.now() >= deadline) throw failure('POSTGRES_RPC_TIMEOUT', mutating);
          if (!envelope) Atomics.wait(state, 3, 0, 1);
        }
        if (
          envelope.id !== id ||
          !(envelope.bytes instanceof ArrayBuffer) ||
          envelope.bytes.byteLength !== length
        )
          throw failure('POSTGRES_PROTOCOL_ERROR', mutating);
        reply = v8.deserialize(Buffer.from(envelope.bytes));
      } else throw failure('POSTGRES_PROTOCOL_ERROR', mutating);
      if (reply?.id !== id || typeof reply.ok !== 'boolean')
        throw failure('POSTGRES_PROTOCOL_ERROR', mutating);
      if (!reply.ok) {
        const error = failure(
          reply.error?.code || 'POSTGRES_QUERY_FAILED',
          reply.error?.outcomeUnknown === true,
        );
        error.postgres = true;
        if (typeof reply.error?.channelPoisoned === 'boolean')
          error.channelPoisoned = reply.error.channelPoisoned;
        if (reply.error?.retryableBeforeBegin === true) error.retryableBeforeBegin = true;
        if (
          reply.error?.code === 'POSTGRES_ROLE_AUTHORITY_BUSY' &&
          reply.error?.leaseUnchanged === true &&
          reply.error?.transactionOpen === false &&
          reply.error?.channelPoisoned === false &&
          reply.error?.outcomeUnknown === false
        ) {
          error.leaseUnchanged = true;
          error.outcomeUnknown = false;
        }
        if (typeof reply.error?.transactionOpen === 'boolean')
          error.transactionOpen = reply.error.transactionOpen;
        if (reply.error?.channelPoisoned === true) poison(error);
        if (!poisoned) activeId = 0;
        throw error;
      }
      activeId = 0;
      return reply.value;
    } catch (error) {
      if (!error.postgres || error.outcomeUnknown) {
        poison(error.code ? error : failure('POSTGRES_PROTOCOL_ERROR', mutating));
        Atomics.store(state, 3, 1);
        terminate();
      }
      throw error;
    } finally {
      running = false;
      if (!poisoned) activeId = 0;
    }
  }
  function closeSync() {
    if (closed) return;
    if (ready && !poisoned && !exited) request({ op: 'shutdown' });
    else if (!exited) terminate();
    closed = true;
    clearTimeout(startupTimer);
    rejectReady(failure('POSTGRES_CLOSED'));
  }
  function close() {
    if (!closed) {
      closed = true;
      clearTimeout(startupTimer);
      rejectReady(failure('POSTGRES_CLOSED'));
      if (!exited) {
        Atomics.store(state, 3, 1);
        try {
          worker.postMessage({ close: true });
        } catch {}
        terminate();
      }
    }
    return exitPromise;
  }
  return {
    ready: () =>
      poisoned
        ? Promise.reject(poisoned)
        : closed
          ? Promise.reject(failure('POSTGRES_CLOSED'))
          : readyPromise,
    request,
    closeSync,
    close,
    stats: () => ({
      ready: ready && !closed && !poisoned,
      closed,
      exited,
      poisoned: !!poisoned,
      active: activeId ? 1 : 0,
      calls,
      ...(memoryMailbox ? { memory: memorySample() } : {}),
    }),
  };
}
module.exports = { createTransport, failure };
