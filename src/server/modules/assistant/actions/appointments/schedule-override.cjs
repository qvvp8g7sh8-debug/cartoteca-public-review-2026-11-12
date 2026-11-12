const { readSteps } = require('../../read-steps.cjs');
const { validDate, minutes } = require('../../../../../shared/work-schedule.cjs');
const { startsAt } = require('../../../../../shared/time-zone-instant.cjs');
function dayKey(values) {
  return values.date + '|' + values.staffId;
}
function exactScheduleKey(values) {
  const start = minutes(values.time);
  return validDate(values.date) &&
    typeof values.staffId === 'string' &&
    values.staffId &&
    Number.isFinite(start) &&
    Number.isSafeInteger(values.duration) &&
    values.duration >= 5 &&
    values.duration <= 1440 &&
    values.duration % 5 === 0 &&
    start + values.duration <= 1440
    ? dayKey(values) + '|' + values.time + '|' + values.duration
    : null;
}
function confirmationMatches(c, confirmation, values) {
  return (
    ['owner', 'salon_admin'].includes(c.current.role) &&
    Boolean(confirmation) &&
    (confirmation === dayKey(values) || confirmation === exactScheduleKey(values))
  );
}
function outsideWorkingHours(info, values) {
  if (!info) return false;
  if (info.status !== 'working') return true;
  if (!exactScheduleKey(values)) return false;
  return !info.workingIntervals.some(
    ([from, to]) =>
      minutes(values.time) >= minutes(from) &&
      minutes(values.time) + values.duration <= minutes(to, true),
  );
}
function pastScheduleTime(c, values, now = Date.now()) {
  return readSteps(function* () {
    if (!values.date || !values.time) return false;
    const instant = startsAt(
      { date: values.date, time: values.time },
      c.assistantReads
        ? yield c.assistantReads.timeZone()
        : c.platform.organizationTimeZone(c.current.organizationId),
    );
    return Number.isFinite(instant) && instant < now;
  }).call(this);
}
module.exports = {
  dayKey,
  exactScheduleKey,
  confirmationMatches,
  outsideWorkingHours,
  pastScheduleTime,
};
