const { readSteps } = require('./../read-steps.cjs');
const { findAvailability } = require('../actions/availability.cjs');
const { nextDate } = require('../../../../shared/work-schedule.cjs');
const { availabilityAction } = require('../actions/availability-action.cjs');
function slotChoices(slots) {
  return slots.map((slot) => ({
    kind: 'slot',
    value: slot,
    label: slot.date + ' · ' + slot.time + '–' + slot.endTime + ' · ' + slot.staffName,
  }));
}
function captureSearch(result, intent) {
  if (intent?.intent === 'availability') return { intent: structuredClone(intent) };
  const slots = result.slots;
  // Legacy internal callers may have only the displayed options. Keep their bounded envelope.
  return {
    values: {
      from: result.availability?.from || slots.map((slot) => slot.date).sort()[0],
      to:
        result.availability?.to ||
        slots
          .map((slot) => slot.date)
          .sort()
          .at(-1),
      duration: result.availability?.duration || slots[0].duration,
      staffIds: [...new Set(slots.map((slot) => slot.staffId))],
      serviceIds: [...new Set(slots.flatMap((slot) => slot.serviceIds || []))],
      time: slots.map((slot) => slot.time).sort()[0],
      endTime: slots
        .map((slot) => slot.endTime)
        .sort()
        .at(-1),
    },
  };
}
const refreshSearch = readSteps(function* refreshSearch(c, search, clock) {
  const result = search.intent
    ? yield availabilityAction(c, search.intent, clock)
    : yield findAvailability(c, search.values);
  const slots = result.slots || [];
  return {
    step: 'availability',
    input: null,
    prompt:
      result.text ||
      (slots.length
        ? 'Вот актуальные свободные окна. Назовите номер варианта. Время ещё не зарезервировано.'
        : 'По исходным условиям свободных окон больше нет. Начните новый поиск с другой датой или временем.'),
    choices: slotChoices(slots.slice(0, 12)),
  };
});
function requestSlots(
  data,
  after = '',
  { nearest = data.nearestRequested || null, ranges = false } = {},
) {
  if (data.timeRequired && !after && !data.timeWindow) {
    data.seekSlots = false;
    return;
  }
  data.time = null;
  data.roomId = '';
  data.seekSlots = true;
  data.slotAfterTime = after;
  data.rangeSummary = ranges && !nearest;
  data.preferredTime = data.rangeSummary
    ? ''
    : nearest === 'earliest'
      ? '00:00'
      : after || (nearest ? '00:00' : '');
  data.nearestRequested = nearest || null;
  delete data.rangePage;
  if (!data.rangeSummary && !data.timeWindow)
    data.timeWindow = {
      kind: 'any',
      from: '00:00',
      to: '24:00',
      fromInclusive: true,
      toInclusive: false,
    };
  data.timeWindowRequired = false;
  data.timeRequired = false;
}
const slotView = readSteps(function* slotView(c, data) {
  if (!data.staff || !data.date) return null;
  if (!data.duration)
    return {
      step: 'duration',
      prompt: 'Чтобы подобрать свободное окно, назовите длительность, например «сорок пять минут».',
      input: { type: 'number', field: 'duration' },
      choices: [],
    };
  const common = {
    duration: data.duration,
    staffIds: [data.staff.id],
    serviceIds: data.service ? [data.service.id] : [],
  };
  const first = yield findAvailability(c, {
    ...common,
    from: data.date,
    to: data.date,
    limit: 6,
    ...(data.slotAfterTime ? { time: data.slotAfterTime } : {}),
  });
  const remainingDays = Math.min(
    6,
    Math.floor(
      (Date.parse('9999-12-31T12:00:00Z') - Date.parse(data.date + 'T12:00:00Z')) / 86400000,
    ),
  );
  const later =
    first.slots.length < 6 && remainingDays > 0
      ? yield findAvailability(c, {
          ...common,
          from: nextDate(data.date),
          to: nextDate(data.date, remainingDays),
          limit: 6 - first.slots.length,
        })
      : null;
  const slots = [...first.slots, ...(later?.slots || [])];
  return {
    step: 'time',
    prompt: slots.length
      ? 'Вот ближайшие свободные окна на ' +
        data.duration +
        ' мин. Назовите номер варианта или другое точное время. Окно ещё не зарезервировано.'
      : 'На выбранную дату и следующие шесть дней подходящих окон нет. Назовите другое время или скажите «поменяй дату».' +
        (first.availability.scheduleIncomplete || later?.availability.scheduleIncomplete
          ? ' Для части дней ещё не задан рабочий график.'
          : ''),
    input: { type: 'time', field: 'time' },
    choices: slotChoices(slots),
  };
});
module.exports = { requestSlots, slotView, captureSearch, refreshSearch };
