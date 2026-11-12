const formats = new Map(),
  instants = new Map();
const MAX_FORMATS = 64,
  MAX_INSTANTS = 4096;
function keep(cache, key, value, max) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
  return value;
}
function civilFormat(timeZone) {
  const cacheable = typeof timeZone === 'string' && timeZone.length <= 80;
  if (cacheable && formats.has(timeZone))
    return keep(formats, timeZone, formats.get(timeZone), MAX_FORMATS);
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return cacheable ? keep(formats, timeZone, format, MAX_FORMATS) : format;
}
// Only public civil date/time/zone values are cached; never an appointment or
// identity. Undefined zone is deliberately uncached because host TZ can change.
function startsAt(appointment, timeZone) {
  const cacheable = typeof timeZone === 'string' && timeZone.length <= 80;
  const key = cacheable ? JSON.stringify([appointment.date, appointment.time, timeZone]) : null;
  if (cacheable && instants.has(key)) return keep(instants, key, instants.get(key), MAX_INSTANTS);
  const result = resolveCivilTime(appointment, timeZone);
  return cacheable ? keep(instants, key, result, MAX_INSTANTS) : result;
}
function resolveCivilTime(appointment, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointment.date) || !/^\d{2}:\d{2}$/.test(appointment.time))
    return NaN;
  const [year, month, day] = appointment.date.split('-').map(Number),
    [hour, minute] = appointment.time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const format = civilFormat(timeZone);
  const parts = (value) =>
    Object.fromEntries(
      format
        .formatToParts(value)
        .filter((p) => p.type !== 'literal')
        .map((p) => [p.type, Number(p.value)]),
    );
  let result = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(result);
    result += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  const p = parts(result);
  return p.year === year &&
    p.month === month &&
    p.day === day &&
    p.hour === hour &&
    p.minute === minute
    ? result
    : NaN;
}
module.exports = { startsAt };
