const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { validDate } = require('../../../shared/work-schedule.cjs');
const { bookingPreview } = require('./preview.cjs');

function previewRequestTime(platform, token, storage, record, date, now, time) {
  const preview = bookingPreview(
    platform,
    token,
    storage,
    { date, serviceIds: record.serviceIds, staffId: record.staffId },
    now,
    { mode: 'any', atTime: time, excludeRequestId: record.id },
  );
  if (preview.duration !== record.duration)
    throw fail(409, 'Длительность услуг изменилась. Требуется новая заявка.');
  return preview;
}
function requestTimeOptions(c, values, now = Date.now()) {
  if (
    !values ||
    Object.keys(values).some((k) => !['id', 'date'].includes(k)) ||
    typeof values.id !== 'string' ||
    !values.id ||
    values.id.length > 120 ||
    !validDate(values.date)
  )
    throw fail(400, 'Выберите заявку и дату.');
  const storage = c.tenantStore(c.current.organizationId);
  return compoundMutation(c.platform, storage, c.current.organizationId, 'booking', () => {
    c.assertCurrent();
    const actor = c.platform.onlineBooking.actor(c.token),
      org = actor.organizationId;
    if (org !== c.current.organizationId) throw fail(403, 'Кабинет изменился.');
    const record = c.platform.bookingRequests.get(org, values.id, now);
    if (!record) throw fail(404, 'Заявка не найдена.');
    c.platform.onlineBooking.assertRequestPermission(c.token, record.staffId);
    if (!['pending', 'requested', 'expired'].includes(record.status) || record.acceptance)
      throw fail(409, 'Заявка уже обрабатывается. Обновите список.');
    return storage.transaction(() => {
      const preview = previewRequestTime(c.platform, c.token, storage, record, values.date, now);
      return { times: [...new Set(preview.slots.map((s) => s.time))], timeZone: preview.timeZone };
    }, 'DEFERRED');
  });
}
// Explicit manager selection is different from claiming that the client agreed in Telegram.
// Its durable intent pins the chosen time across async preparation and crash recovery.
function chooseAcceptanceTime(platform, token, storage, record, values, now) {
  if (values.date === undefined) return record.acceptance?.selection || null;
  if (record.acceptance) {
    const previous = record.acceptance.selection;
    if (!previous || previous.date !== values.date || previous.time !== values.time)
      throw fail(409, 'Принятие уже начато для другого времени. Повторите прежнее действие.');
    return previous;
  }
  const preview = previewRequestTime(
    platform,
    token,
    storage,
    record,
    values.date,
    now,
    values.time,
  );
  const slot = preview.slots.find((s) => s.time === values.time);
  if (!slot) throw fail(409, 'Время недоступно. Выберите другое.');
  return { date: slot.date, time: slot.time, roomId: slot.roomId, timeZone: preview.timeZone };
}
function acceptanceRecord(record) {
  const selection = record.acceptance?.selection;
  return selection
    ? { ...record, date: selection.date, time: selection.time, roomId: selection.roomId }
    : record;
}
module.exports = { requestTimeOptions, chooseAcceptanceTime, acceptanceRecord };
