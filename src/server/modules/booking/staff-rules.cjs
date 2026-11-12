// Pure request-local projection. Staff choices inherit organization defaults;
// public links select a staff member, never carry or grant booking rules.
function effectiveStaffRules(settings = {}, staffId = '') {
  const staff = settings.staff?.[staffId] || {};
  const mode = ['any', 'sequential'].includes(staff.mode) ? staff.mode : settings.mode;
  const bookingMode = ['approval', 'classic'].includes(staff.bookingMode)
    ? staff.bookingMode
    : settings.bookingMode;
  return {
    mode: mode === 'sequential' ? 'sequential' : 'any',
    bookingMode: bookingMode === 'classic' ? 'classic' : 'approval',
    minimumLeadMinutes: settings.minimumLeadMinutes ?? 60,
    reservationMinutes: settings.reservationMinutes ?? 30,
  };
}

module.exports = { effectiveStaffRules };
