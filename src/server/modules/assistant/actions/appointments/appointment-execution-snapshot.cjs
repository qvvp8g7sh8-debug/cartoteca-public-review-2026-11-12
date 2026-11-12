const { isDeepStrictEqual } = require('node:util');
const { fail } = require('../../../../../shared/errors.cjs');
const { duration } = require('../../../cabinet/validation.cjs');
const { cabinetForUser } = require('../../../access/cabinet-policy.cjs');
const { references, describe } = require('../../dialogue/dialogue-options.cjs');
const { clientChoiceMetadata } = require('../../dialogue/client-choice-names.cjs');
const { verifyAvailability } = require('../availability.cjs');
const { allowsClosedDay } = require('../../dialogue/dialogue-booking-time.cjs');
const { previewConfirmation } = require('./preview-confirmation.cjs');
const { windowBounds } = require('../../language/time/booking-time-window.cjs');
const { minutes } = require('../../../../../shared/work-schedule.cjs');
const { zonedClock } = require('../../../../../shared/time-zone.cjs');
const { unavailableExecutionTime } = require('./appointment-time-input.cjs');
function serviceSnapshot(c, data) {
  if (!data.serviceChosen || !data.service?.id)
    throw fail(409, 'Выберите услугу из каталога перед автоматической записью.');
  const service = c
    .tenantStore(c.current.organizationId)
    .readSelected([], [data.service.id])
    .services.find((row) => row.id === data.service.id);
  if (!service) throw fail(409, 'Услуга больше недоступна. Уточните запись.');
  return {
    id: service.id,
    name: service.name,
    category: service.category || 'other',
    duration: duration(service.duration ?? 60),
    price: service.price,
  };
}
function executionSnapshot(c, entry, now) {
  c.assertCurrent();
  const data = structuredClone(entry.data),
    original = structuredClone(data);
  const context = references(c, data);
  if (!isDeepStrictEqual(data, original) || describe(c, data, context).step !== 'review')
    throw fail(409, 'Данные записи изменились. Уточните запись ещё раз.');
  const storage = c.tenantStore(c.current.organizationId);
  const patient = cabinetForUser(c.current, storage.readSelected([data.patient.id])).patients.find(
    (row) => row.id === data.patient.id,
  );
  if (!patient) throw fail(403, 'Клиент больше недоступен.');
  const values = {
    date: data.date,
    time: data.time,
    duration: data.duration,
    staffId: data.staff.id,
    serviceIds: data.service ? [data.service.id] : [],
    ...(data.roomId ? { roomId: data.roomId } : {}),
    ...(allowsClosedDay(c, data) ? { allowClosedDay: true } : {}),
  };
  if (data.timeWindow) {
    const bounds = windowBounds(data.timeWindow);
    if (
      !bounds ||
      minutes(data.time) < minutes(bounds.time) ||
      minutes(data.time) + data.duration > minutes(bounds.endTime, true)
    )
      throw fail(409, 'Приём не помещается в выбранный период.');
  }
  const slot = verifyAvailability(c, values, now);
  if (!slot) throw unavailableExecutionTime('Это время уже недоступно. Выберите другое время.');
  const service = serviceSnapshot(c, data);
  const appointment = {
    id: 'a' + entry.id,
    date: slot.date,
    time: slot.time,
    duration: slot.duration,
    staffId: slot.staffId,
    roomId: slot.roomId || '',
    status: 'scheduled',
    serviceItems: [service],
    service: service.name,
    notes: '',
  };
  return {
    data,
    patientStamp: clientChoiceMetadata(patient).clientNameStamp,
    service,
    appointment,
    revision: storage.get('revision', 0),
    timeZone: c.platform.organizationTimeZone(c.current.organizationId),
    text: previewConfirmation(
      data,
      slot,
      zonedClock(new Date(now), c.platform.organizationTimeZone(c.current.organizationId)),
      c.current,
    ).replace(/^Подготовил запись:/u, 'Записал:'),
  };
}
function assertExecutionSnapshot(c, entry, captured, now) {
  c.assertCurrent();
  if (!isDeepStrictEqual(entry.data, captured.data))
    throw fail(409, 'Подготовка изменилась. Уточните запись ещё раз.');
  const data = captured.data;
  const storage = c.tenantStore(c.current.organizationId);
  // The caller already holds the cabinet IMMEDIATE transaction. readSelected
  // joins that snapshot; directory/readServices helpers start their own reads.
  const patient = cabinetForUser(c.current, storage.readSelected([data.patient.id])).patients.find(
    (row) => row.id === data.patient.id,
  );
  if (!patient || clientChoiceMetadata(patient).clientNameStamp !== captured.patientStamp)
    throw fail(409, 'Клиент изменился или больше недоступен. Уточните запись ещё раз.');
  const service = serviceSnapshot(c, data);
  const timeZone = c.platform.organizationTimeZone(c.current.organizationId);
  if (timeZone !== captured.timeZone || !isDeepStrictEqual(service, captured.service))
    throw fail(409, 'Услуга или часовой пояс изменились. Уточните запись ещё раз.');
  if (data.timeWindow) {
    const bounds = windowBounds(data.timeWindow);
    if (
      !bounds ||
      minutes(data.time) < minutes(bounds.time) ||
      minutes(data.time) + data.duration > minutes(bounds.endTime, true)
    )
      throw fail(409, 'Приём не помещается в выбранный период.');
  }
  // Availability needs only the selected service. Do not widen transaction()
  // semantics or call the standalone full-catalog read inside this writer.
  const selectedStorage = {
    ...storage,
    readServices: () => storage.readSelected([], [data.service.id]).services,
  };
  const scoped = {
    ...c,
    tenantStore(org) {
      if (org !== c.current.organizationId) throw fail(403, 'Кабинет изменился.');
      return selectedStorage;
    },
  };
  const slot = verifyAvailability(
    scoped,
    {
      date: data.date,
      time: data.time,
      duration: data.duration,
      staffId: data.staff.id,
      serviceIds: [data.service.id],
      ...(captured.appointment.roomId ? { roomId: captured.appointment.roomId } : {}),
      ...(allowsClosedDay(c, data) ? { allowClosedDay: true } : {}),
    },
    now,
  );
  if (
    !slot ||
    ['date', 'time', 'duration', 'staffId', 'roomId'].some(
      (field) => (slot[field] || '') !== (captured.appointment[field] || ''),
    )
  )
    throw unavailableExecutionTime('Время или кабинет изменились. Уточните запись ещё раз.');
  c.assertCurrent();
}
module.exports = { executionSnapshot, assertExecutionSnapshot };
