function createReadScheduler(state) {
  const queue = [],
    shared = new Map(),
    active = new Set(),
    failures = new Map();
  const rank = { assistant: -1, user: 0, calendar: 1, background: 2 };
  let sequence = 0,
    cancelling = false;
  const interrupted = () =>
    Object.assign(new Error('Чтение прервано. Повторите загрузку.'), { outcomeUnknown: false });
  function pump() {
    if (cancelling) return;
    while (active.size < 4) {
      const index = queue.findIndex(
        (job) =>
          job.priority !== 'background' ||
          ![...active].some((entry) => entry.priority === 'background'),
      );
      if (index < 0) return;
      const job = queue.splice(index, 1)[0];
      active.add(job);
      try {
        Promise.resolve(job.run(job.controller.signal)).then(
          (value) => complete(job, null, value),
          (error) => complete(job, error),
        );
      } catch (error) {
        complete(job, error);
      }
    }
  }
  function complete(job, error, value) {
    active.delete(job);
    finish(job, error, value);
    pump();
  }
  function finish(job, error, value) {
    if (job.finished) return;
    job.finished = true;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.cancel);
    if (job.key && shared.get(job.key) === job) shared.delete(job.key);
    if (job.priority === 'background' && job.key) {
      if (error && (!job.cancelled || job.timedOut)) {
        const count = Math.min(5, (failures.get(job.key)?.count || 0) + 1);
        failures.set(job.key, { count, until: Date.now() + Math.min(60000, 1000 * 2 ** count) });
        if (failures.size > 100) failures.delete(failures.keys().next().value);
      } else if (!error) failures.delete(job.key);
    }
    if (error) job.reject(error);
    else job.resolve(value);
    pump();
  }
  function scheduleRead(run, { priority = 'user', key = '', signal, timeoutMs = 20000 } = {}) {
    if (signal?.aborted) return Promise.reject(interrupted());
    if (shared.has(key) && key) {
      const job = shared.get(key);
      if (rank[priority] < rank[job.priority]) {
        job.priority = priority;
        queue.sort((a, b) => rank[a.priority] - rank[b.priority] || a.sequence - b.sequence);
        pump();
      }
      return job.promise;
    }
    if (priority === 'background' && failures.get(key)?.until > Date.now())
      return Promise.reject(new Error('Фоновое чтение отложено после ошибки связи.'));
    const job = {
      run,
      priority,
      key,
      signal,
      sequence: sequence++,
      controller: new AbortController(),
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.cancel = () => {
      job.cancelled = true;
      job.controller.abort();
      finish(job, interrupted());
      pump();
    };
    job.timer = setTimeout(() => {
      job.timedOut = true;
      job.cancel();
    }, timeoutMs);
    signal?.addEventListener('abort', job.cancel, { once: true });
    if (key) shared.set(key, job);
    queue.push(job);
    queue.sort((a, b) => rank[a.priority] - rank[b.priority] || a.sequence - b.sequence);
    pump();
    return job.promise;
  }
  function cancelReadTasks() {
    // Cancel queued work first so finishing an active transport cannot start it.
    cancelling = true;
    for (const job of [...queue, ...active]) job.cancel();
    cancelling = false;
  }
  if (typeof window !== 'undefined') window.addEventListener?.('pagehide', cancelReadTasks);
  return { scheduleRead, cancelReadTasks };
}
