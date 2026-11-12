const { fail } = require('../../../shared/errors.cjs');
const { deliveryPreference } = require('./delivery-selection.cjs');

function createDeliveryPreferences(c) {
  const { db, open, seal, transaction, audit } = c;
  function read(org, patient, appointment = '') {
    const row = db
      .prepare(
        'SELECT revision,value FROM notification_preferences WHERE organization_id=? AND patient_id=? AND appointment_id=?',
      )
      .get(org, patient, appointment);
    if (row) return { ...open(row.value), revision: row.revision };
    const legacy =
      !appointment &&
      db
        .prepare('SELECT 1 FROM telegram_links WHERE organization_id=? AND patient_id=?')
        .get(org, patient);
    return {
      preference: legacy ? 'telegram' : 'auto',
      revision: 0,
      changedAt: null,
      source: legacy ? 'legacy' : 'default',
    };
  }
  // Caller must gate this store behind a working delivery coordinator, authorize under lock,
  // and invalidate unsent work there. Persistence alone must never pretend delivery was switched.
  function save(
    { org, patient, appointment = '', preference, expectedRevision, stamp = '', actor },
    authorize,
    now = Date.now(),
    onChange = () => {},
  ) {
    deliveryPreference(preference);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      typeof appointment !== 'string' ||
      appointment.length > 120 ||
      typeof stamp !== 'string' ||
      stamp.length > 128
    )
      throw fail(400, 'Проверьте выбор способа связи.');
    return transaction(() => {
      authorize();
      const previous = read(org, patient, appointment);
      if (previous.revision !== expectedRevision)
        throw fail(409, 'Способ связи уже изменён. Обновите карточку.');
      if (previous.preference === preference && previous.stamp === stamp) return previous;
      const revision = previous.revision + 1;
      const value = { preference, stamp, source: 'staff', changedBy: actor, changedAt: now };
      db.prepare(
        'INSERT INTO notification_preferences VALUES(?,?,?,?,?) ON CONFLICT(organization_id,patient_id,appointment_id) DO UPDATE SET revision=excluded.revision,value=excluded.value',
      ).run(org, patient, appointment, revision, seal(value));
      const coordinated = onChange({ ...value, revision });
      if (coordinated && typeof coordinated.then === 'function')
        throw Error('Asynchronous preference coordination is not allowed.');
      audit('notification_preference_changed', actor, org, {
        patientId: patient,
        appointmentId: appointment,
        channel: preference,
      });
      return { ...value, revision };
    });
  }
  return { read, save };
}
module.exports = { createDeliveryPreferences };
