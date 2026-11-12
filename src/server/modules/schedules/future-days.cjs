const { validDate } = require('../../../shared/work-schedule.cjs');
const { fail } = require('../../../shared/errors.cjs');

// Internal, streaming read port. A distant explicitly opened day is not hidden
// by an arbitrary booking horizon. No profiles or client details leave this port.
function createFutureDays({ db, open }) {
  return function* futureDays(org, staffIds, from) {
    if (!validDate(from)) throw fail(400, 'Проверьте дату графика.');
    const selected = new Set(staffIds);
    const ids = [...new Set([...selected, 'organization'])];
    const rows = db.prepare(
      `SELECT date,staff_id,value FROM work_schedule_days
       WHERE organization_id=? AND date>=? AND staff_id IN (${ids.map(() => '?').join(',')})
       ORDER BY date,staff_id`,
    );
    let group = null;
    for (const row of rows.iterate(org, from, ...ids)) {
      if (!selected.has(row.staff_id) && row.staff_id !== 'organization') continue;
      if (group && group.date !== row.date) yield group;
      if (!group || group.date !== row.date)
        group = { date: row.date, days: new Map(), closure: null };
      const value = open(row.value);
      const day = { status: value.status, intervals: value.intervals || [] };
      if (row.staff_id === 'organization') group.closure = day;
      else group.days.set(row.staff_id, day);
    }
    if (group) yield group;
  };
}
module.exports = { createFutureDays };
