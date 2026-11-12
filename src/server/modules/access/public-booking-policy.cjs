const { isDeepStrictEqual: same } = require('node:util');
const { fail } = require('../../../shared/errors.cjs');

// Internal command principal, never an account/session role. Its entire authority
// is one server-built scheduled appointment; no editing or reading HTTP boundary.
function assertPublicBookingAppend(current, before, next) {
  const deny = () => {
    throw fail(403, 'Онлайн-запись может только добавить выбранную запись.');
  };
  if (
    !current.organizationId ||
    !current.accountId ||
    !current.appointmentId ||
    before.patients.length > 1 ||
    next.patients.length !== 1 ||
    !same(before.services, next.services)
  )
    deny();
  const old = before.patients[0],
    patient = next.patients[0];
  const added = patient.appointments.at(-1);
  if (
    !added ||
    added.id !== current.appointmentId ||
    added.staffId !== current.accountId ||
    added.status !== 'scheduled' ||
    patient.appointments.length !== (old?.appointments.length || 0) + 1
  )
    deny();
  if (old) {
    if (!same({ ...patient, appointments: patient.appointments.slice(0, -1) }, old)) deny();
  } else if (
    patient.visits.length ||
    patient.createdBy !== current.accountId ||
    Object.keys(patient).some(
      (key) =>
        ![
          'id',
          'name',
          'firstName',
          'lastName',
          'middleName',
          'phone',
          'createdBy',
          'visits',
          'appointments',
        ].includes(key),
    )
  )
    deny();
}
module.exports = { assertPublicBookingAppend };
