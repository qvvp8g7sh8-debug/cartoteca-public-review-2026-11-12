// Outbound only. New work from another process is discovered within 5 seconds;
// positive work always goes through the original fresh claim/ACL/lease guards.
function createQueueIdleProbe({ clock = Date.now, fastMs = 250, subscribe } = {}) {
  let nextAt = 0,
    emptyCount = 0,
    lastAt = -Infinity,
    unsubscribe,
    generation = 0,
    wakeEpoch = 0,
    probeEpoch = 0;
  function wake() {
    wakeEpoch++;
    nextAt = 0;
    emptyCount = 0;
  }
  function ready() {
    if (!unsubscribe && subscribe) {
      const captured = generation;
      unsubscribe = subscribe(() => {
        if (captured === generation) wake();
      });
    }
    const now = clock();
    if (!Number.isFinite(now)) return false;
    if (now < lastAt) wake();
    lastAt = now;
    if (now < nextAt) return false;
    probeEpoch = wakeEpoch;
    return true;
  }
  return {
    ready,
    wake,
    capture: () => ({ generation, wakeEpoch }),
    active(captured) {
      if (captured && captured.generation !== generation) return captured;
      wake();
      probeEpoch = wakeEpoch;
      return { generation, wakeEpoch };
    },
    empty(dueAt, captured) {
      if (captured && (captured.generation !== generation || captured.wakeEpoch !== wakeEpoch))
        return;
      if (probeEpoch !== wakeEpoch) return; // An enqueue woke this probe while its claim awaited admission.
      const now = clock();
      if (!Number.isFinite(now)) return;
      const delay = Math.min(5000, fastMs * 2 ** Math.min(emptyCount++, 5));
      nextAt = now + delay;
      if (Number.isFinite(dueAt) && dueAt > now) nextAt = Math.min(nextAt, dueAt);
    },
    close() {
      generation++;
      unsubscribe?.();
      unsubscribe = undefined;
      wake();
      probeEpoch = wakeEpoch;
    },
  };
}
function createQueueNextDue(db, table) {
  if (!['notification_channel_jobs', 'staff_notification_jobs', 'staff_max_jobs'].includes(table))
    throw Error('Unknown outbound queue.');
  // Closed status/index ranges only, never organizations, recipients or payloads.
  // Include lease alarms: a later pending job cannot hide earlier recovery.
  const query =
    db.prepare(`SELECT min(next_at) AS wake_at FROM ${table} WHERE status='pending' AND next_at>?
    UNION ALL SELECT min(lease_until) AS wake_at FROM ${table} WHERE status='reserved' AND lease_until>?
    UNION ALL SELECT min(lease_until) AS wake_at FROM ${table} WHERE status='sending' AND lease_until>?`);
  return (now) => {
    const times = query
      .all(now, now, now)
      .map((row) => row.wake_at)
      .filter((value) => value !== null && value !== undefined)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > now);
    return times.length ? Math.min(...times) : null;
  };
}
module.exports = { createQueueIdleProbe, createQueueNextDue };
