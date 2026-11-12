const { fail } = require('../../../shared/errors.cjs');
const RESERVATION_MINUTES = 30;
function validateReservation(
  { organizationId, staffId, startsAt, durationMinutes },
  now = Date.now(),
) {
  const start = Date.parse(startsAt);
  if (
    !organizationId ||
    !staffId ||
    !Number.isFinite(start) ||
    start <= now ||
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 1440 ||
    durationMinutes % 5
  )
    throw fail(400, 'Некорректные параметры записи.');
  return {
    organizationId,
    staffId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + durationMinutes * 60000).toISOString(),
    expiresAt: new Date(now + RESERVATION_MINUTES * 60000).toISOString(),
    status: 'pending',
  };
}
function mayConfirm(role) {
  return ['owner', 'salon_admin'].includes(role);
}
module.exports = { RESERVATION_MINUTES, validateReservation, mayConfirm };
