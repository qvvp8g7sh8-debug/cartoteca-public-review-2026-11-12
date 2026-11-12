const { startsAt } = require('../../notifications/appointments.cjs');
const { minutes } = require('../../../../shared/work-schedule.cjs');
function rejectedTimeText(data, dayInfo, { timeZone, now = Date.now(), closedConfirmed = false }) {
  const instant = startsAt({ date: data.date, time: data.time }, timeZone);
  if (Number.isFinite(instant) && instant < now) return 'Это время уже прошло.';
  const inHours =
    (closedConfirmed && dayInfo) ||
    dayInfo?.workingIntervals.some(
      ([from, to]) =>
        minutes(data.time) >= minutes(from) &&
        minutes(data.time) + data.duration <= minutes(to, true),
    );
  return 'В ' + data.time + (inHours ? ' занято.' : ' приём не входит в рабочий график.');
}
module.exports = { rejectedTimeText };
