// Calendar dates/times are civil values in the organization zone, not device instants.
const zonedFormatters = new Map();
const MAX_ZONED_FORMATTERS = 64;
function zonedFormatter(kind, timeZone) {
  // Non-string/implicit host zones retain Intl coercion and host-TZ semantics.
  const cacheable = typeof timeZone === 'string' && timeZone.length <= 80,
    key = cacheable ? kind + ':' + timeZone : null;
  if (cacheable && zonedFormatters.has(key)) {
    const value = zonedFormatters.get(key);
    zonedFormatters.delete(key);
    zonedFormatters.set(key, value);
    return value;
  }
  const formatter =
    kind === 'clock'
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
      : new Intl.DateTimeFormat('sv-SE', { timeZone });
  // Construction failures are never remembered. Only fixed options and public
  // timezone strings are retained; no date, tenant, actor or authority is cached.
  if (cacheable) {
    if (zonedFormatters.size >= MAX_ZONED_FORMATTERS)
      zonedFormatters.delete(zonedFormatters.keys().next().value);
    zonedFormatters.set(key, formatter);
  }
  return formatter;
}
function zonedClock(instant, timeZone = 'Europe/Moscow') {
  const parts = zonedFormatter('clock', timeZone).formatToParts(instant);
  const get = (type) => parts.find((part) => part.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}
function zonedDate(instant, timeZone) {
  return zonedFormatter('date', timeZone).format(instant);
}
function createZonedClock() {
  return { zonedClock };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { zonedClock, zonedDate };
