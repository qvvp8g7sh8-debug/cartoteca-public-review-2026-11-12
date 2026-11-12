function isActiveAppointment(a) {
  return !a.status || a.status === 'scheduled';
}
function isClosedAppointment(a) {
  return ['cancelled', 'no_show'].includes(a.status);
}
function appointmentStatusLabel(a) {
  return { completed: '✓ Проведено', cancelled: 'Отменена', no_show: 'Не пришёл' }[a.status] || '';
}
function createAppointmentStatuses() {
  return { isActiveAppointment, isClosedAppointment, appointmentStatusLabel };
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = { isActiveAppointment, isClosedAppointment, appointmentStatusLabel };
