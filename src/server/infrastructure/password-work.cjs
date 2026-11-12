const { performance } = require('node:perf_hooks');
const { fail } = require('../../shared/errors.cjs');

// Process-wide admission bounds native scrypt work and leaves default libuv
// threads available for file I/O. Password parameters and outputs never change.
function createPasswordWork({
  concurrency = 2,
  capacity = 32,
  perCredentialCapacity = 2,
  waitMs = 1000,
  timers = { set: setTimeout, clear: clearTimeout },
  now = () => performance.now(),
} = {}) {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 0 ||
    capacity > 64 ||
    !Number.isSafeInteger(perCredentialCapacity) ||
    perCredentialCapacity < 1 ||
    perCredentialCapacity > 8 ||
    !Number.isSafeInteger(waitMs) ||
    waitMs < 1 ||
    waitMs > 5000
  )
    throw Error('Invalid password work budget.');
  const waiting = [],
    credentials = new Map();
  let active = 0;
  const totals = {
    started: 0,
    completed: 0,
    failed: 0,
    refused: 0,
    timedOut: 0,
    peakActive: 0,
    peakQueued: 0,
  };
  const busy = () =>
    Object.assign(fail(503, 'Сервер проверяет другие входы. Повторите через секунду.'), {
      code: 'AUTH_WORK_CAPACITY',
      retryAfter: 1,
    });
  function releaseKey(item) {
    const count = credentials.get(item.key) - 1;
    if (count) credentials.set(item.key, count);
    else credentials.delete(item.key);
    item.key = null;
  }
  function expire(item) {
    if (item.timer !== null) timers.clear(item.timer);
    item.timer = null;
    item.task = null;
    releaseKey(item);
    totals.timedOut++;
    item.reject(busy());
  }
  function start(item) {
    // A delayed timer must not admit expired work when another task settles.
    if (now() >= item.deadline) {
      expire(item);
      if (waiting.length) start(waiting.shift());
      return;
    }
    if (item.timer !== null) timers.clear(item.timer);
    item.timer = null;
    active++;
    totals.started++;
    totals.peakActive = Math.max(totals.peakActive, active);
    const task = item.task;
    item.task = null;
    const finish = () => {
      active--;
      releaseKey(item);
      if (waiting.length) start(waiting.shift());
    };
    Promise.resolve()
      .then(task)
      .then(
        (value) => {
          totals.completed++;
          finish();
          item.resolve(value);
        },
        (error) => {
          totals.failed++;
          finish();
          item.reject(error);
        },
      );
  }
  function run(task, { key = {} } = {}) {
    if (typeof task !== 'function') return Promise.reject(TypeError('Expected password work.'));
    if (
      (credentials.get(key) || 0) >= perCredentialCapacity ||
      (active >= concurrency && waiting.length >= capacity)
    ) {
      totals.refused++;
      return Promise.reject(busy());
    }
    return new Promise((resolve, reject) => {
      const item = { task, key, resolve, reject, timer: null, deadline: Infinity };
      credentials.set(key, (credentials.get(key) || 0) + 1);
      if (active < concurrency) return start(item);
      item.deadline = now() + waitMs;
      item.timer = timers.set(() => {
        const index = waiting.indexOf(item);
        if (index < 0) return;
        waiting.splice(index, 1);
        expire(item);
      }, waitMs);
      waiting.push(item);
      totals.peakQueued = Math.max(totals.peakQueued, waiting.length);
    });
  }
  return {
    run,
    stats: () => ({
      ...totals,
      active,
      queued: waiting.length,
      credentialGroups: credentials.size,
      concurrency,
      capacity,
      perCredentialCapacity,
      waitMs,
    }),
  };
}
const passwordWork = createPasswordWork();
module.exports = { createPasswordWork, passwordWork };
