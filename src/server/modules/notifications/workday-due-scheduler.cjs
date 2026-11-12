const { zonedDate } = require('../../../shared/time-zone.cjs');
const { startsAt } = require('../../../shared/time-zone-instant.cjs');
const { createDueRunner } = require('./notification-due-runner.cjs');

function createWorkdayDueScheduler(platform, store, clock) {
  const schedule = platform.notificationSchedule;
  function candidate(org, deviceId, after = clock()) {
    if (store.hasEnabledEvents?.(org, 'reminder') === false) return null;
    const device = store.device(deviceId);
    if (!device || device.organization_id !== org || !store.allowed(org)) return null;
    const recipient = store
      .recipients(org, device.account_id, 'reminder')
      .find((row) => row.id === deviceId);
    if (!recipient) return null;
    const zone = platform.organizationTimeZone(org);
    const date = zonedDate(after, zone);
    // Streaming cursor is exhausted/closed synchronously before any yield. Only
    // explicitly configured days are read; no arbitrary future booking horizon.
    for (const group of platform.workSchedules.futureDays(org, [device.account_id], date)) {
      const day = group.days.get(device.account_id);
      if (group.closure?.status === 'closed' || day?.status !== 'working') continue;
      const time = day.intervals.map(([from]) => from).sort()[0];
      if (!time) continue;
      const at = startsAt({ date: group.date, time }, zone);
      if (!(at > after)) continue;
      return {
        device,
        task: {
          entity: group.date,
          dueAt: Math.max(clock(), at - recipient.decoded.preferences.leadMinutes * 60000),
          expiresAt: at,
          value: { date: group.date, startAt: at },
        },
      };
    }
    return null;
  }
  function rebuild(org, deviceId, after = clock()) {
    const next = candidate(org, deviceId, after);
    schedule.replaceTasks('workday', org, deviceId, next ? [next.task] : []);
  }
  function dispatch(task, admit) {
    admit((onEntered) =>
      schedule.transaction(() => {
        onEntered();
        if (!schedule.taskMatches(task)) return;
        const org = task.organization_id,
          deviceId = task.subject;
        const current = candidate(org, deviceId);
        if (!current || current.task.dueAt > clock()) {
          schedule.replaceTasks('workday', org, deviceId, current ? [current.task] : []);
          return;
        }
        const { device, task: planned } = current;
        store.enqueue(
          org,
          device.account_id,
          'reminder',
          { kind: 'workday', ...planned.value },
          JSON.stringify(['workday', org, device.account_id, planned.value.date]),
          planned.expiresAt,
          device.id,
        );
        // Once enqueued, precompute the following explicitly opened day. Existing
        // device/day dedup and fresh before-send checks remain in the Push queue.
        rebuild(org, deviceId, planned.expiresAt);
      }, task.organization_id),
    );
  }
  const runner = createDueRunner({ schedule, kind: 'workday', rebuild, dispatch, clock });
  return {
    // Explicit one-shot maintenance still retires invalid durable tasks. Runtime
    // skips planning entirely while reminders are off; candidate reads no workday.
    schedule: runner.schedule,
    scheduleBatched: (options) =>
      store.hasEnabledEvents?.('', 'reminder') === false
        ? Promise.resolve(true)
        : runner.scheduleBatched(options),
  };
}
module.exports = { createWorkdayDueScheduler };
