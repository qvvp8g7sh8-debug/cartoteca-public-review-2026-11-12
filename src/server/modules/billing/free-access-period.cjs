const { zonedClock } = require('../../../shared/time-zone.cjs');

// Informational period only. Payment and entitlement checks remain separate.
function freeAccessPeriod(registeredAt, timeZone, now = new Date()) {
  if (typeof registeredAt !== 'string' || !registeredAt) return null;
  const registration = new Date(registeredAt);
  if (!Number.isFinite(registration.getTime()) || !Number.isFinite(now.getTime())) return null;
  if (registration > now) return null;
  const startDate = zonedClock(registration, timeZone).date;
  const today = zonedClock(now, timeZone).date;
  const [year, month, day] = startDate.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  const endDate = `${year + 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  const ordinal = (date) => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  // The anniversary is the first day outside the period, in the organization zone.
  const remainingDays = Math.max(0, ordinal(endDate) - ordinal(today));
  return { status: remainingDays > 0 ? 'active' : 'ended', startDate, endDate, remainingDays };
}

module.exports = { freeAccessPeriod };
