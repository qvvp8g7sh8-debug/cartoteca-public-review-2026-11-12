const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
function fingerprint(appointment, timeZone = 'Europe/Moscow') {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        appointment.id,
        appointment.date,
        appointment.time,
        appointment.duration || 60,
        appointment.staffId || '',
        timeZone,
      ]),
    )
    .digest('hex');
}
function serviceFingerprint(appointment) {
  const services = appointment.serviceItems?.length
    ? appointment.serviceItems.map((item) => [item.id, item.name])
    : appointment.service || '';
  return crypto.createHash('sha256').update(JSON.stringify(services)).digest('hex');
}
const CLIENT_NOTIFICATION_EVENTS = Object.freeze(['reminder', 'created', 'moved', 'cancelled']);
function clientNotificationEvents(value, strict = false) {
  if (value === undefined) return ['reminder'];
  if (
    !Array.isArray(value) ||
    value.some((kind) => !CLIENT_NOTIFICATION_EVENTS.includes(kind)) ||
    new Set(value).size !== value.length
  ) {
    if (strict) throw fail(400, 'Выберите события уведомлений.');
    return ['reminder'];
  }
  return CLIENT_NOTIFICATION_EVENTS.filter((kind) => value.includes(kind));
}
function settingsRule(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw fail(400, 'Некорректные настройки уведомлений.');
  if (
    typeof values.enabled !== 'boolean' ||
    !Number.isSafeInteger(values.leadMinutes) ||
    values.leadMinutes < 15 ||
    values.leadMinutes > 20160
  )
    throw fail(400, 'Напоминание: от 15 минут до 14 дней.');
  if (typeof values.timeZone !== 'string' || values.timeZone.length > 80)
    throw fail(400, 'Укажите часовой пояс.');
  try {
    new Intl.DateTimeFormat('ru', { timeZone: values.timeZone });
  } catch {
    throw fail(400, 'Неизвестный часовой пояс.');
  }
  if (values.showServices !== undefined && typeof values.showServices !== 'boolean')
    throw fail(400, 'Показ услуг должен быть включён или выключен.');
  return {
    enabled: values.enabled,
    leadMinutes: values.leadMinutes,
    timeZone: values.timeZone,
    showServices: values.showServices !== false,
    events: clientNotificationEvents(values.events, true),
  };
}
const { startsAt } = require('../../../shared/time-zone-instant.cjs');
module.exports = {
  fingerprint,
  serviceFingerprint,
  settingsRule,
  startsAt,
  CLIENT_NOTIFICATION_EVENTS,
  clientNotificationEvents,
};
