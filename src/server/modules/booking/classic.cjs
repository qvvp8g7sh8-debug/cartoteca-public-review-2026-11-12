const { fail } = require('../../../shared/errors.cjs');
const { patientFullName, patientNameParts } = require('../../../shared/patient-names.cjs');
const { matchingContacts } = require('./contacts.cjs');
const { admitRequest } = require('./admission.cjs');
const { calculateBookingPreview } = require('./preview.cjs');
const { duration } = require('../cabinet/validation.cjs');
const { assertChange } = require('../cabinet/mutation-policy.cjs');
const { writeCabinetMutation } = require('../cabinet/mutation-write.cjs');
const { classicReceipt, writeClassicReceipt } = require('./classic-receipts.cjs');
const { writeClassicConfirmation } = require('./classic-confirmation.cjs');
function destination(storage, record, org) {
  const matches = matchingContacts(storage, record.phone, org);
  const conflict = () => {
    throw Object.assign(
      fail(
        409,
        'Не удалось автоматически оформить запись. Свяжитесь с организацией для уточнения контактов.',
      ),
      { code: 'BOOKING_CONTACT_CONFLICT' },
    );
  };
  if (matches.length > 1) conflict();
  if (!matches.length) return record.patientId;
  const names = patientNameParts(matches[0]);
  const clean = (value) =>
    String(value || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLocaleLowerCase('ru-RU');
  for (const [field, stored] of [
    ['firstName', names.first],
    ['lastName', names.last],
    ['middleName', names.middle],
  ])
    if (record[field] && stored && clean(record[field]) !== clean(stored)) conflict();
  return matches[0].id;
}

// Synchronous command under the caller's platform lock. No fabricated owner
// session, images, network delivery, or public access to a clinical card.
function bookClassic(context, org, input, now) {
  const { platform } = context,
    storage = context.tenantStore(org);
  const schedule = platform.notificationSchedule;
  if (schedule?.enabled) {
    if (!context.notificationIntent)
      throw Error('Classic booking requires durable notification intent.');
    schedule.assertIntent(context.notificationIntent);
  }
  const receipt = classicReceipt(storage, org, input);
  if (receipt) return receipt;
  if (input.kind !== 'reserve') throw fail(400, 'Выберите свободное время для записи.');
  let record, result, patientId;
  storage.transaction(() => {
    record = admitRequest(
      platform,
      org,
      storage,
      input,
      () =>
        calculateBookingPreview(
          platform,
          org,
          storage,
          { date: input.date, serviceIds: input.serviceIds, staffId: input.staffId },
          now,
          {},
          (id) => platform.workSchedules.publicDays(org, id, input.date, input.date),
        ),
      () => platform.workSchedules.publicDays(org, input.staffId, input.date, input.date),
      now,
    );
    if (record.status !== 'pending')
      throw Object.assign(fail(409, 'Запрос уже обработан. Свяжитесь с организацией.'), {
        code: 'BOOKING_REQUEST_PROCESSED',
      });
    patientId = destination(storage, record, org);
    const current = {
      role: 'public_booking',
      organizationId: org,
      accountId: record.staffId,
      appointmentId: record.appointmentId,
    };
    const before = storage.readSelected([patientId], record.serviceIds);
    const prior = before.patients[0];
    const patient = prior
      ? structuredClone(prior)
      : {
          id: patientId,
          firstName: record.firstName,
          lastName: record.lastName,
          middleName: record.middleName,
          phone: record.phone,
          createdBy: record.staffId,
          visits: [],
          appointments: [],
        };
    if (!prior) patient.name = patientFullName(patient);
    const serviceItems = record.serviceIds.map((id) => {
      const service = before.services.find((s) => s.id === id);
      if (!service)
        throw Object.assign(fail(409, 'Услуга больше недоступна.'), {
          code: 'BOOKING_CONDITIONS_CHANGED',
        });
      return {
        id,
        name: service.name,
        category: service.category || 'other',
        duration: duration(service.duration ?? 60),
        price: service.price,
      };
    });
    patient.appointments.push({
      id: record.appointmentId,
      date: record.date,
      time: record.time,
      duration: record.duration,
      staffId: record.staffId,
      roomId: record.roomId,
      status: 'scheduled',
      serviceItems,
      service: serviceItems.map((s) => s.name).join(', '),
      notes: record.comment || '',
    });
    const next = { ...before, patients: [patient] };
    assertChange(platform, current, before, next, storage, true, '', {
      id: record.id,
      appointmentId: record.appointmentId,
    });
    platform.bookingRequests.prepareAcceptance(org, record.id, record.revision, patientId, now);
    writeCabinetMutation(platform, org, storage, before, next, {
      patients: [patientId],
      services: [],
    });
    writeClassicConfirmation(
      platform,
      storage,
      patientId,
      patient.appointments.at(-1),
      platform.organizationTimeZone(org),
      now,
    );
    result = {
      status: 'booked',
      date: record.date,
      time: record.time,
      duration: record.duration,
      expiresAt: null,
    };
    // Same cabinet commit as the appointment. If the later platform commit
    // fails, the signed form still recovers this exact receipt without rebooking,
    // including after staff edit/delete the original appointment/card.
    writeClassicReceipt(storage, org, input, result, now);
    storage.set('booking-accepted:' + record.id, true);
    if (schedule?.enabled) schedule.assertIntent(context.notificationIntent);
  });
  context.notificationCoordinator?.booked(org, patientId, record.appointmentId);
  platform.bookingRequests.finish(org, record.id, record.revision, 'accepted', now);
  return result;
}
module.exports = { bookClassic, classicReceipt };
