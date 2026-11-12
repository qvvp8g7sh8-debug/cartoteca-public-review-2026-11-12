const { retainValueBytes, readValueBytes } = require('./retained-value-bytes138.cjs');
// Month markers retain only owned bytes. Each caller gets a fresh frozen value;
// the caller still supplies its current snapshot/revision and audience.
function createCalendarProjection({ indexes, budget, owner }) {
  let cached = null;
  const token = {};
  const freeze = (rows) => Object.freeze(rows.map(Object.freeze));
  return (revision, from, to, staffId = '') => {
    const key = JSON.stringify([revision, from, to, staffId]);
    if (cached?.key === key) {
      budget.touch(token);
      return freeze(readValueBytes(cached.data));
    }
    const groups = new Map();
    for (const a of indexes.appointments(from, to, { includeNames: false, staffId })) {
      if (a.date < from || a.date > to) continue;
      const group = JSON.stringify([a.date, a.staffId || '', a.roomId || '']);
      if (!groups.has(group))
        groups.set(group, {
          date: a.date,
          staffId: a.staffId || '',
          roomId: a.roomId || '',
          count: 0,
        });
      groups.get(group).count++;
    }
    const rows = freeze([...groups.values()]),
      data = retainValueBytes(rows);
    if (
      budget.retain(
        token,
        data.byteLength + Buffer.byteLength(key) + 64,
        () => {
          cached = null;
        },
        owner,
      )
    )
      cached = { key, data };
    return rows;
  };
}
module.exports = { createCalendarProjection };
