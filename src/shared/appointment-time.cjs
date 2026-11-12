function validAppointmentTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5][05]$/u.test(value);
}
module.exports = { validAppointmentTime };
