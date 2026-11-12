const { performance } = require('node:perf_hooks');
const unscoped = Object.freeze({});
function createProcessingQueue({
  concurrency = 2,
  capacity = 4,
  waitMs = 5000,
  maxActivePerScope = concurrency,
  maxPendingPerScope = capacity,
  now = () => performance.now(),
} = {}) {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4 ||
    !Number.isInteger(capacity) ||
    capacity < 0 ||
    capacity > 8 ||
    !Number.isFinite(waitMs) ||
    waitMs < 1 ||
    waitMs > 15000 ||
    !Number.isInteger(maxActivePerScope) ||
    maxActivePerScope < 1 ||
    maxActivePerScope > concurrency ||
    !Number.isInteger(maxPendingPerScope) ||
    maxPendingPerScope < 0 ||
    maxPendingPerScope > capacity
  )
    throw Error('Invalid photo queue configuration');
  const scopes = new Map(),
    pending = new Map(),
    order = [];
  let active = 0,
    queued = 0;
  const busy = () =>
    Object.assign(Error('Обработка фотографий занята. Повторите через несколько секунд.'), {
      status: 503,
      retryAfter: 5,
    });
  const stopped = () => Object.assign(Error('Загрузка фотографии остановлена.'), { status: 408 });
  const cleanup = (key, scope) => {
    if (!scope.active && !scope.queued) scopes.delete(key);
  };
  const eligible = (key) => key === unscoped || scopes.get(key).active < maxActivePerScope;
  function removePending(item) {
    const list = pending.get(item.key),
      index = list?.indexOf(item) ?? -1;
    if (index < 0) return false;
    list.splice(index, 1);
    queued--;
    item.scope.queued--;
    if (!list.length) {
      pending.delete(item.key);
      order.splice(order.indexOf(item.key), 1);
    }
    return true;
  }
  function start(item) {
    clearTimeout(item.timer);
    item.timer = null;
    const check = () => {
      // A delayed timer may not have executed when a worker settles.
      if (now() >= item.deadline) throw busy();
      if (item.cancelled?.()) throw stopped();
    };
    try {
      check();
    } catch (error) {
      item.task = null;
      item.reject(error);
      cleanup(item.key, item.scope);
      return;
    }
    active++;
    item.scope.active++;
    const task = item.task;
    item.task = null;
    Promise.resolve()
      .then(() => {
        check();
        return task();
      })
      .then(item.resolve, item.reject)
      .finally(() => {
        // No timeout releases a running decoder/IO slot before actual settlement.
        active--;
        item.scope.active--;
        cleanup(item.key, item.scope);
        pump();
      });
  }
  function pump() {
    while (active < concurrency && queued) {
      const index = order.findIndex(eligible);
      if (index < 0) break;
      const key = order.splice(index, 1)[0],
        list = pending.get(key),
        item = list.shift();
      if (list.length) order.push(key);
      else pending.delete(key);
      queued--;
      item.scope.queued--;
      start(item);
    }
  }
  function run(task, { scopeKey = null, cancelled } = {}) {
    if (
      typeof task !== 'function' ||
      (scopeKey !== null && (typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > 256))
    )
      return Promise.reject(TypeError('Invalid photo work scope'));
    return new Promise((resolve, reject) => {
      const key = scopeKey === null ? unscoped : scopeKey;
      const scope = scopes.get(key) || { active: 0, queued: 0 };
      const canStart =
        active < concurrency && (key === unscoped || scope.active < maxActivePerScope);
      if (
        !canStart &&
        (queued >= capacity || (key !== unscoped && scope.queued >= maxPendingPerScope))
      )
        return reject(busy());
      scopes.set(key, scope);
      const item = {
        task,
        resolve,
        reject,
        key,
        scope,
        cancelled,
        timer: null,
        deadline: Infinity,
      };
      if (canStart) return start(item);
      item.deadline = now() + waitMs;
      item.timer = setTimeout(() => {
        if (!removePending(item)) return;
        item.timer = null;
        item.task = null;
        item.reject(busy());
        cleanup(key, scope);
        pump();
      }, waitMs);
      let list = pending.get(key);
      if (!list) {
        list = [];
        pending.set(key, list);
        order.push(key);
      }
      list.push(item);
      queued++;
      scope.queued++;
    });
  }
  return {
    run,
    snapshot: () => ({ active, queued, concurrency, capacity }),
    scopeSnapshot: () => ({ scopes: scopes.size, maxActivePerScope, maxPendingPerScope }),
  };
}
module.exports = { createProcessingQueue };
