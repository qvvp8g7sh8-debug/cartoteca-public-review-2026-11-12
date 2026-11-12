const { startsAt } = require('../../../shared/time-zone-instant.cjs');
const { validDate } = require('../../../shared/work-schedule.cjs');
function createWorkdayPush(platform, store, clock = Date.now) {
  function start(org, account, date) {
    if (!validDate(date)) return NaN;
    const { days, closures } = platform.workSchedules.publicDays(org, account, date, date);
    const day = days[date];
    if (closures[date]?.status === 'closed' || day?.status !== 'working') return NaN;
    const time = day.intervals.map(([from]) => from).sort()[0];
    return time ? startsAt({ date, time }, platform.organizationTimeZone(org)) : NaN;
  }
  function schedule(organizations) {
    if (!organizations && store.hasEnabledEvents?.('', 'reminder') === false) return;
    for (const org of organizations || store.reminderOrganizations?.() || store.organizations()) {
      if (store.hasEnabledEvents?.(org, 'reminder') === false || !store.allowed(org)) continue;
      const recipients = store.recipients(org, '', 'reminder');
      if (!recipients.length) continue;
      const now = clock();
      const format = new Intl.DateTimeFormat('sv-SE', {
        timeZone: platform.organizationTimeZone(org),
      });
      const dates = new Set([format.format(now), format.format(now + 120 * 60000)]);
      platform.withWriteLock(() => {
        for (const device of recipients) {
          for (const date of dates) {
            const at = start(org, device.account_id, date);
            if (!(at > now && at - now <= device.decoded.preferences.leadMinutes * 60000)) continue;
            store.enqueue(
              org,
              device.account_id,
              'reminder',
              { kind: 'workday', date, startAt: at },
              JSON.stringify(['workday', org, device.account_id, date]),
              at,
              device.id,
            );
          }
        }
      });
    }
  }
  function current(job) {
    if (store.hasEnabledEvents?.(job.organization_id, 'reminder') === false) return false;
    const ref = job.decoded.reference;
    if (ref?.kind !== 'workday' || job.account_id !== job.decoded.staffId) return false;
    const device = store.device(job.device_id);
    if (
      !device ||
      !device.decoded.enabled ||
      !device.decoded.preferences.events.includes('reminder')
    )
      return false;
    const at = start(job.organization_id, job.account_id, ref.date),
      now = clock();
    return (
      at === ref.startAt && at > now && at - now <= device.decoded.preferences.leadMinutes * 60000
    );
  }
  function scheduleBatch(cursor = '', limit = 10) {
    if (!cursor && store.hasEnabledEvents?.('', 'reminder') === false) return { cursor: '' };
    const page =
      store.reminderOrganizationPage?.(cursor, limit) || store.organizationPage(cursor, limit);
    schedule(page.organizations);
    return { cursor: page.cursor };
  }
  if (platform.notificationSchedule?.enabled) {
    const due = require('./workday-due-scheduler.cjs').createWorkdayDueScheduler(
      platform,
      store,
      clock,
    );
    return { schedule: due.schedule, scheduleBatched: due.scheduleBatched, current };
  }
  return { schedule, scheduleBatch, current };
}
module.exports = { createWorkdayPush };
