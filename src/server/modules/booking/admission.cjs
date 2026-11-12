const { fail } = require('../../../shared/errors.cjs');
const { minutes } = require('../../../shared/work-schedule.cjs');
const { startsAt } = require('../notifications/appointments.cjs');
const { availableRooms } = require('../workspace/policy.cjs');

// Shared admission under platform → cabinet locks. Identity and external
// budgets belong to the calling boundary, not to this occupancy calculation.
function admitRequest(platform, org, storage, input, previewFor, scheduleFor, now) {
  const { key, ...submission } = input;
  const previous = platform.bookingRequests.byKey(org, key, now);
  if (previous) {
    if (JSON.stringify(previous.submission) !== JSON.stringify(submission))
      throw Object.assign(fail(409, 'Этот запрос уже использован для другой заявки.'), {
        code: 'BOOKING_KEY_CONFLICT',
      });
    return previous;
  }
  if (platform.bookingRequests.openCount(org) >= 1000)
    throw fail(429, 'Сначала обработайте накопившиеся заявки.');
  const preview = previewFor();
  let slot = preview.slots.find((s) => s.time === input.time);
  if (input.kind === 'other-time') {
    const settings = platform.onlineBooking.settings(org),
      schedule = scheduleFor();
    const day = schedule.days[input.date],
      start = minutes(input.time),
      end = start + preview.duration;
    if (
      !platform.onlineBooking
        .providers(org, input.serviceIds, storage.readSelected([], input.serviceIds).services)
        .some((m) => m.accountId === input.staffId) ||
      day?.status !== 'working' ||
      schedule.closures[input.date]?.status === 'closed' ||
      !day.intervals.some(([from, to]) => minutes(from) <= start && minutes(to, true) >= end) ||
      startsAt(input, preview.timeZone) < now + settings.minimumLeadMinutes * 60000
    )
      throw Object.assign(fail(409, 'Запросите время внутри открытого рабочего дня.'), {
        code: 'BOOKING_SLOT_UNAVAILABLE',
      });
    const room = availableRooms(platform.workspaceSettings(org), input.staffId)[0];
    if (!room)
      throw Object.assign(fail(409, 'У сотрудника нет доступного кабинета.'), {
        code: 'BOOKING_CONDITIONS_CHANGED',
      });
    slot = {
      date: input.date,
      time: input.time,
      staffId: input.staffId,
      roomId: room.id,
      duration: preview.duration,
    };
  }
  if (!slot)
    throw Object.assign(fail(409, 'Это время уже недоступно. Выберите другое.'), {
      code: 'BOOKING_SLOT_UNAVAILABLE',
    });
  const catalog = storage.readSelected([], input.serviceIds).services;
  const services = input.serviceIds.map((id) => {
    const service = catalog.find((s) => s.id === id);
    return {
      id,
      name: service.name,
      duration: service.duration ?? 60,
      price: service.price ?? null,
    };
  });
  return platform.bookingRequests.create(
    org,
    key,
    { ...submission, ...slot, submission, services },
    platform.onlineBooking.settings(org).reservationMinutes,
    now,
  );
}
module.exports = { admitRequest };
