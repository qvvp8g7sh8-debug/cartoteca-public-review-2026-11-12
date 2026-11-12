const v8 = require('node:v8');
const { performance } = require('node:perf_hooks');
const { isMainThread, threadId } = require('node:worker_threads');
const { SharedArrayBuffer, BigInt64Array, Atomics } = globalThis;
const MiB = 1024 * 1024;
const fields = [
  'sampleAtMs',
  'pid',
  'threadId',
  'heapSizeLimitBytes',
  'heapUsedBytes',
  'heapTotalBytes',
  'externalBytes',
  'arrayBuffersBytes',
];
function failure() {
  return Object.assign(Error('Native memory limits do not match the process budget.'), {
    code: 'NATIVE_MEMORY_BUDGET_MISMATCH',
  });
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw failure();
  return value;
}
function normalizeSample(value) {
  if (!value || typeof value !== 'object') throw failure();
  const sample = {};
  for (const name of fields) sample[name] = integer(value[name]);
  integer(sample.pid, 1);
  integer(sample.heapSizeLimitBytes, 1);
  if (sample.threadId === 0) sample.rssBytes = integer(value.rssBytes);
  return Object.freeze(sample);
}
// RSS belongs to the whole process. A Worker reports only its own isolate's
// heap/external counters, so consumers must never add Worker RSS to parent RSS.
function sampleIsolateMemory() {
  const memory = process.memoryUsage();
  return normalizeSample({
    sampleAtMs: Date.now(),
    pid: process.pid,
    threadId,
    heapSizeLimitBytes: v8.getHeapStatistics().heap_size_limit,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    ...(isMainThread ? { rssBytes: memory.rss } : {}),
  });
}
function assertNativeMemoryProcess(processPlan, { sample = sampleIsolateMemory } = {}) {
  if (
    processPlan?.version !== 1 ||
    typeof processPlan.identity !== 'string' ||
    !/^(?:gateway|web|background|command(?:-[1-3])?)$/.test(processPlan.identity) ||
    !Number.isSafeInteger(processPlan.heapCeilingMiB) ||
    processPlan.heapCeilingMiB < 1
  )
    throw failure();
  const observed = normalizeSample(sample());
  if (observed.heapSizeLimitBytes !== processPlan.heapCeilingMiB * MiB) throw failure();
  return Object.freeze({
    version: 1,
    identity: processPlan.identity,
    heapSizeLimitBytes: observed.heapSizeLimitBytes,
  });
}
function normalizeNativeMemoryReport(report, { allowWorkerMain = false } = {}) {
  if (!report || typeof report !== 'object') throw failure();
  const pid = integer(report.pid, 1);
  const result = { pid, main: normalizeSample(report.main) };
  if (result.main.pid !== pid || (!allowWorkerMain && result.main.threadId !== 0)) throw failure();
  const threads = new Set([result.main.threadId]);
  for (const name of ['database', 'lease']) {
    result[name] = report[name] == null ? null : normalizeSample(report[name]);
    if (result[name]) {
      if (
        result[name].pid !== pid ||
        result[name].threadId < 1 ||
        threads.has(result[name].threadId)
      )
        throw failure();
      threads.add(result[name].threadId);
    }
  }
  return Object.freeze(result);
}
function createMemoryMailbox() {
  return new SharedArrayBuffer((fields.length + 1) * BigInt64Array.BYTES_PER_ELEMENT);
}
function mailboxView(mailbox) {
  if (
    !(mailbox instanceof SharedArrayBuffer) ||
    mailbox.byteLength !== (fields.length + 1) * BigInt64Array.BYTES_PER_ELEMENT
  )
    throw failure();
  return new BigInt64Array(mailbox);
}
function publishMemorySample(mailbox) {
  const view = mailboxView(mailbox),
    sample = sampleIsolateMemory();
  const sequence = Atomics.load(view, 0);
  Atomics.store(view, 0, sequence + 1n);
  fields.forEach((name, index) => Atomics.store(view, index + 1, BigInt(sample[name])));
  Atomics.store(view, 0, sequence + 2n);
  return sample;
}
function readMemorySample(mailbox) {
  const view = mailboxView(mailbox);
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = Atomics.load(view, 0);
    if (!before || before % 2n) continue;
    const sample = {};
    fields.forEach((name, index) => (sample[name] = Number(Atomics.load(view, index + 1))));
    if (Atomics.load(view, 0) === before) {
      try {
        return normalizeSample(sample);
      } catch {
        return null;
      }
    }
  }
  return null;
}
function startMemorySampling(processPlan, mailbox, { now = () => performance.now() } = {}) {
  if (!processPlan) return null;
  if (typeof now !== 'function') throw failure();
  const attestation = assertNativeMemoryProcess(processPlan);
  publishMemorySample(mailbox);
  let lastAttemptAt = now();
  function collect(at) {
    // Failed telemetry attempts are throttled too; the last valid mailbox stays intact.
    lastAttemptAt = at;
    return publishMemorySample(mailbox);
  }
  // Explicit publication and the timer stay forced. Startup attestation above is strict.
  const publish = () => {
    try {
      return collect(now());
    } catch {
      return null;
    }
  };
  // SQL replies may share the most recent sample; telemetry is not work admission.
  const publishIfDue = () => {
    try {
      const at = now();
      return at - lastAttemptAt >= 1000 ? collect(at) : null;
    } catch {
      return null;
    }
  };
  const timer = setInterval(publish, 1000);
  timer.unref();
  return Object.freeze({ attestation, publish, publishIfDue, close: () => clearInterval(timer) });
}
module.exports = {
  sampleIsolateMemory,
  assertNativeMemoryProcess,
  normalizeNativeMemoryReport,
  createMemoryMailbox,
  publishMemorySample,
  readMemorySample,
  startMemorySampling,
};
