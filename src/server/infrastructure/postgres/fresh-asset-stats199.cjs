const fs = require('node:fs');
const { setImmediate } = require('node:timers');

// Only callers already queued before launch can share an observation. A caller
// entering after launch always starts a new batch, even while old IO is pending.
function createFreshAssetStats199({
  lstat = (file, options) => fs.promises.lstat(file, options),
  schedule = setImmediate,
} = {}) {
  let pending = null,
    closed = false;
  const groups = new Set();
  const stopped = () =>
    Object.assign(Error('Encryption asset observation closed'), { status: 503 });
  function launch(group) {
    group.started = true;
    if (pending === group) pending = null;
    if (closed) {
      for (const entry of group.entries.values()) entry.reject(stopped());
      groups.delete(group);
      return;
    }
    const jobs = [...group.entries.values()].map(async (entry) => {
      try {
        const info = await lstat(entry.path, entry.bigint ? { bigint: true } : undefined);
        if (closed) throw stopped();
        entry.resolve(info);
      } catch (error) {
        entry.reject(error);
      }
    });
    void Promise.all(jobs).then(() => groups.delete(group));
  }
  function group() {
    if (!pending || pending.entries.size >= 64) {
      const next = { entries: new Map(), started: false };
      pending = next;
      groups.add(next);
      schedule(() => launch(next));
    }
    return pending;
  }
  return {
    read(requests) {
      if (closed) return Promise.reject(stopped());
      const promises = requests.map(({ path, bigint = false }) => {
        const current = group(),
          key = JSON.stringify([path, bigint]);
        let entry = current.entries.get(key);
        if (!entry) {
          entry = { path, bigint };
          entry.promise = new Promise((resolve, reject) =>
            Object.assign(entry, { resolve, reject }),
          );
          current.entries.set(key, entry);
        }
        return entry.promise;
      });
      return Promise.all(promises);
    },
    close() {
      closed = true;
      for (const current of groups)
        if (!current.started) for (const entry of current.entries.values()) entry.reject(stopped());
      pending = null;
    },
  };
}
module.exports = { createFreshAssetStats199 };
