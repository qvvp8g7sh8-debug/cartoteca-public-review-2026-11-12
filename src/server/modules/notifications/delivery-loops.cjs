// Process-local single-flight ownership. Durable queue leases and the caller's
// process/channel guards remain authoritative before every claim and send.
function createDeliveryLoops() {
  const pending = new Map();
  function start(key, work, onError = () => {}) {
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve()
      .then(work)
      .finally(() => {
        if (pending.get(key) === task) pending.delete(key);
      });
    pending.set(key, task);
    // A managed timer observes each task once; explicit callers can still await
    // the same rejection. A timer tick never piles callbacks onto a hung task.
    void task.catch(onError);
    return task;
  }
  return { start, running: (key) => pending.has(key), any: () => pending.size > 0 };
}
module.exports = { createDeliveryLoops };
