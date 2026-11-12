const { validDate } = require('../../../shared/work-schedule.cjs');
const { fail } = require('../../../shared/errors.cjs');
function requestInput(values) {
  const fields = [
    'key',
    'challenge',
    'date',
    'time',
    'serviceIds',
    'staffId',
    'kind',
    'firstName',
    'lastName',
    'middleName',
    'phone',
    'comment',
    'consent',
    'privacyConsentVersion',
    'bookingMode',
  ];
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.keys(values).some((k) => !fields.includes(k))
  )
    throw fail(400, 'Некорректная заявка.');
  const text = (key, max = 120) => {
    const value = values[key] ?? '';
    if (
      typeof value !== 'string' ||
      value.length > max ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    )
      throw fail(400, 'Проверьте контактные данные.');
    return value.trim().replace(/\s+/g, ' ');
  };
  const key = text('key'),
    date = text('date'),
    time = text('time'),
    staffId = text('staffId'),
    kind = text('kind');
  const firstName = text('firstName'),
    lastName = text('lastName'),
    middleName = text('middleName'),
    phone = text('phone', 40),
    comment = text('comment', 1000);
  const digits = phone.replace(/\D/g, '');
  if (values.bookingMode !== undefined && !['approval', 'classic'].includes(values.bookingMode))
    throw fail(400, 'Проверьте вид онлайн-записи.');
  if (
    key.length < 16 ||
    !validDate(date) ||
    !/^([01]\d|2[0-3]):[0-5][05]$/.test(time) ||
    !staffId ||
    !['reserve', 'other-time'].includes(kind) ||
    !firstName ||
    digits.length < 10 ||
    digits.length > 15 ||
    !/^[+\d\s().-]+$/.test(phone) ||
    values.consent !== true ||
    !Array.isArray(values.serviceIds) ||
    !values.serviceIds.length ||
    values.serviceIds.length > 10 ||
    values.serviceIds.some((id) => typeof id !== 'string' || !id || id.length > 120) ||
    new Set(values.serviceIds).size !== values.serviceIds.length
  )
    throw fail(400, 'Укажите имя, телефон, услуги, время и согласие на обработку заявки.');
  return {
    key,
    ...(values.challenge !== undefined ? { challenge: text('challenge') } : {}),
    date,
    time,
    staffId,
    kind,
    serviceIds: [...values.serviceIds].sort(),
    firstName,
    lastName,
    middleName,
    phone,
    comment,
    consent: true,
    ...(values.bookingMode !== undefined ? { bookingMode: values.bookingMode } : {}),
    ...(values.privacyConsentVersion !== undefined
      ? { privacyConsentVersion: text('privacyConsentVersion', 80) }
      : {}),
  };
}
function requestView(record) {
  const {
    id,
    revision,
    status,
    createdAt,
    expiresAt,
    date,
    time,
    duration,
    staffId,
    roomId,
    kind,
    firstName,
    lastName,
    middleName,
    phone,
    comment,
    services,
    proposal,
    originalWish,
  } = record;
  return {
    id,
    revision,
    status,
    createdAt,
    expiresAt,
    date: record.acceptance?.selection?.date || date,
    time: record.acceptance?.selection?.time || time,
    duration,
    staffId,
    roomId: record.acceptance?.selection?.roomId || roomId,
    kind,
    firstName,
    lastName,
    middleName,
    phone,
    comment,
    services,
    ...(proposal ? { proposal: { state: proposal.state, expiresAt: proposal.expiresAt } } : {}),
    ...(originalWish ? { originalWish: { date: originalWish.date, time: originalWish.time } } : {}),
  };
}
module.exports = { requestInput, requestView };
