// Union for the "all employees" calendar, not room availability or permission to book.
function workingIntervalsByDate(records) {
  const dates = new Map();
  const minute = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const label = (value) =>
    String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  for (const { date, day } of records) {
    if (day?.status !== 'working') continue;
    const pairs = dates.get(date) || [];
    pairs.push(...day.intervals.map(([from, to]) => [minute(from), minute(to)]));
    dates.set(date, pairs);
  }
  return Object.fromEntries(
    [...dates].map(([date, pairs]) => {
      const merged = [];
      for (const pair of pairs.sort((a, b) => a[0] - b[0])) {
        const previous = merged.at(-1);
        if (previous && pair[0] <= previous[1]) previous[1] = Math.max(previous[1], pair[1]);
        else merged.push([...pair]);
      }
      return [date, merged.map((pair) => pair.map(label))];
    }),
  );
}
module.exports = { workingIntervalsByDate };
