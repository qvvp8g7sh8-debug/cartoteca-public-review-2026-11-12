const { validDate, nextDate } = require('../../../shared/work-schedule.cjs');
const { fail } = require('../../../shared/errors.cjs');

// Trusted read port for online availability; never expose profile permissions,
// membership details or appointment data through the public schedule boundary.
function createPublicDays({ db, open }) {
  const select = db.prepare(
    'SELECT date,value FROM work_schedule_days WHERE organization_id=? AND staff_id=? AND date BETWEEN ? AND ? ORDER BY date',
  );
  return function publicDays(org, staffId, from, to) {
    if (!validDate(from) || !validDate(to) || from > to || to > nextDate(from, 31))
      throw fail(400, 'Выберите период не более месяца.');
    const rows = (id) =>
      Object.fromEntries(
        select.all(org, id, from, to).map((row) => {
          const value = open(row.value);
          return [row.date, { status: value.status, intervals: value.intervals || [] }];
        }),
      );
    return { days: rows(staffId), closures: rows('organization') };
  };
}
module.exports = { createPublicDays };
