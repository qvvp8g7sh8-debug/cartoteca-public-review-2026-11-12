const { readSteps } = require('./../read-steps.cjs');
const { findAvailability } = require('../actions/availability.cjs');
const {
  exactScheduleKey,
  confirmationMatches,
  outsideWorkingHours,
  pastScheduleTime,
} = require('../actions/appointments/schedule-override.cjs');
function bookingTuple(data) {
  return { date: data.date, staffId: data.staff?.id, time: data.time, duration: data.duration };
}
const { nextDate, minutes } = require('../../../../shared/work-schedule.cjs');
const { windowBounds, windowLabel } = require('../language/time/booking-time-window.cjs');
const { MAX_SHOWN_SLOTS } = require('../actions/representative-slots.cjs');
const { freeRangeView, MAX_RANGES } = require('../actions/free-range-view.cjs');
const shortDate = (date) =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(date + 'T12:00:00Z'),
  );
function common(data) {
  return {
    duration: data.duration,
    staffIds: [data.staff.id],
    serviceIds: data.service ? [data.service.id] : [],
  };
}
function resetSlotPage(data) {
  delete data.slotCriteria;
  delete data.shownSlots;
  delete data.currentSlots;
  delete data.rangePage;
}
function applyTimeWindow(data, window) {
  data.timeWindow = structuredClone(window);
  data.timeWindowRequired = false;
  data.timeRequired = false;
  data.time = null;
  data.roomId = '';
  data.seekSlots = true;
  data.slotAfterTime = '';
  delete data.preferredTime;
  delete data.rangeSummary;
  delete data.nearestRequested;
  resetSlotPage(data);
}
function periodView(data, info) {
  data.timeSelectionStage = 'period';
  if ((data.rangePage || 0) >= (info?.freeRanges?.length || 0)) delete data.rangePage;
  return freeRangeView(info, {
    duration: data.duration,
    offset: data.rangePage || 0,
    emptyDay: !data.rangeSummary && !data.timeWindow,
  });
}
function closedDayKey(data) {
  return data.date + '|' + data.staff.id;
}
const inspectBookingDay = readSteps(function* inspectBookingDay(c, data) {
  if (
    !data.patient ||
    !data.staff ||
    !data.serviceChosen ||
    !data.date ||
    !data.duration ||
    data.durationSource === 'required'
  )
    return null;
  return (yield findAvailability(c, {
    ...common(data),
    from: data.date,
    to: data.date,
    strategy: 'day',
  })).availability.dayInfo;
});
const closedDayView = readSteps(function* closedDayView(c, data, info) {
  const tuple = bookingTuple(data);
  if (!outsideWorkingHours(info, tuple) || (yield pastScheduleTime(c, tuple))) return null;
  const canOverride = ['owner', 'salon_admin'].includes(c.current.role);
  if (allowsClosedDay(c, data)) return null;
  const working = info.status === 'working';
  const key = working ? exactScheduleKey(tuple) : closedDayKey(data);
  data.timeSelectionStage = 'closedDay';
  return {
    step: 'time',
    phase: 'closedDay',
    prompt: canOverride
      ? working
        ? 'Вне рабочего графика. Записать?'
        : 'День не открыт. Записать?'
      : working
        ? 'Вне рабочего графика. Выберите другое время.'
        : 'День не открыт. Выберите другую дату.',
    input: { type: 'text', field: 'time' },
    choices: canOverride
      ? [{ kind: 'closedDayContinue', value: key, label: 'Да, продолжить' }]
      : [],
    controls: [{ kind: 'otherDate', label: 'Выбрать другую дату' }],
  };
});
function allowsClosedDay(c, data) {
  return confirmationMatches(c, data.closedDayConfirmation, bookingTuple(data));
}
const dateView = readSteps(function* dateView(c, data, clock, view) {
  data.timeSelectionStage = 'date';
  if (!data.staff || !data.serviceChosen || !data.duration || data.durationSource === 'required')
    return view;
  const max = Math.min(
    6,
    Math.floor(
      (Date.parse('9999-12-31T12:00:00Z') - Date.parse(clock.date + 'T12:00:00Z')) / 86400000,
    ),
  );
  const result = yield findAvailability(c, {
    ...common(data),
    from: clock.date,
    to: nextDate(clock.date, max),
    strategy: 'dates',
    limit: 3,
    ...(data.timeWindow ? windowBounds(data.timeWindow) : {}),
    ...(data.time && minutes(data.time) + data.duration <= 1440
      ? {
          time: data.time,
          endTime:
            String(Math.floor((minutes(data.time) + data.duration) / 60)).padStart(2, '0') +
            ':' +
            String((minutes(data.time) + data.duration) % 60).padStart(2, '0'),
        }
      : {}),
  });
  return {
    ...view,
    phase: 'date',
    prompt:
      (data.dateRejection === 'past' ? 'Эта дата уже прошла. ' : '') +
      (result.slots.length
        ? 'На какой день записать?'
        : 'В ближайшие семь дней подходящих окон нет. Назовите другую дату' +
          (data.timeWindow ? ' или измените период.' : '.')),
    choices: result.slots.map((slot) => ({
      kind: 'date',
      value: slot.date,
      label:
        (slot.date === clock.date
          ? 'Сегодня · '
          : slot.date === nextDate(clock.date)
            ? 'Завтра · '
            : '') + shortDate(slot.date),
    })),
    controls: data.timeWindow ? [{ kind: 'otherPeriod', label: 'Изменить период' }] : [],
  };
});
const bookingSlotView = readSteps(function* bookingSlotView(c, data, info) {
  if (data.rangeSummary) {
    // Re-read the selected day with its actual period, rooms and full service duration.
    const current = (yield findAvailability(c, {
      ...common(data),
      from: data.date,
      to: data.date,
      ...(data.timeWindow ? windowBounds(data.timeWindow) : {}),
      strategy: 'day',
    })).availability.dayInfo;
    return periodView(data, current);
  }
  if (!data.timeWindow || data.timeWindowRequired) return periodView(data, info);
  if (!data.duration) return null;
  data.timeSelectionStage = 'slots';
  const criteria = JSON.stringify([
    data.date,
    data.staff.id,
    data.service?.id || '',
    data.duration,
    data.timeWindow,
  ]);
  if (data.slotCriteria !== criteria) {
    resetSlotPage(data);
    data.slotCriteria = criteria;
  }
  const result = yield findAvailability(c, {
    ...common(data),
    from: data.date,
    to: data.date,
    ...windowBounds(data.timeWindow),
    strategy: 'representative',
    limit: data.preferredTime ? 1 : 3,
    shownSlots: data.shownSlots || [],
    ...(data.preferredTime ? { preferredTime: data.preferredTime } : {}),
  });
  data.currentSlots = result.slots.map(({ date, time, staffId }) => ({ date, time, staffId }));
  const period = windowLabel(data.timeWindow);
  const exhausted = !result.slots.length && (data.shownSlots || []).length > 0;
  return {
    step: 'time',
    phase: 'slots',
    prompt: result.slots.length
      ? data.preferredTime
        ? 'Ближайшее свободное время — ' +
          result.slots[0].time +
          '–' +
          result.slots[0].endTime +
          '. Подойдёт?'
        : shortDate(data.date) + ', ' + period + '. Какое время подойдёт?'
      : exhausted
        ? 'Назовите другое время или выберите период.'
        : 'На ' +
          shortDate(data.date) +
          ' в этом периоде подходящих окон нет. Выберите другой период или дату.' +
          (result.availability.scheduleIncomplete
            ? ' Рабочий график на эту дату ещё не задан.'
            : ''),
    input: { type: 'text', field: 'time' },
    choices: result.slots.map((slot) => ({
      kind: 'slot',
      value: slot,
      label: slot.date + ' · ' + slot.time + '–' + slot.endTime + ' · ' + slot.staffName,
    })),
    controls: [
      ...(result.availability.truncated &&
      (data.shownSlots || []).length + result.slots.length < MAX_SHOWN_SLOTS
        ? [{ kind: 'moreSlots', label: 'Ещё время' }]
        : []),
      { kind: 'otherPeriod', label: 'Другой период' },
      { kind: 'otherDate', label: 'Другая дата' },
    ],
  };
});
const bookingTimeView = readSteps(function* bookingTimeView(c, data, clock, view, info) {
  if (view.step === 'date') return yield dateView(c, data, clock, view);
  if (view.step !== 'time' || !data.patient || !data.staff || !data.serviceChosen || !data.date)
    return view;
  if (data.durationSource === 'required' || !data.duration)
    return {
      step: 'duration',
      prompt: 'Сколько минут длится приём?',
      input: { type: 'number', field: 'duration' },
      choices: [],
    };
  if (info && info.status !== 'working') {
    data.timeSelectionStage = 'closedTime';
    return {
      step: 'time',
      phase: 'slots',
      prompt: 'Во сколько записать?',
      input: { type: 'text', field: 'time' },
      choices: [],
      controls: [{ kind: 'otherDate', label: 'Другая дата' }],
    };
  }
  return (yield bookingSlotView(c, data, info)) || view;
});
function bookingControl(data, choice) {
  if (choice.kind === 'moreRanges') {
    data.rangePage = (data.rangePage || 0) + MAX_RANGES;
    return true;
  }
  if (choice.kind === 'moreSlots') {
    data.shownSlots = [...(data.shownSlots || []), ...(data.currentSlots || [])].slice(
      -MAX_SHOWN_SLOTS,
    );
    data.time = null;
    data.roomId = '';
    return true;
  }
  if (choice.kind === 'otherPeriod') {
    delete data.preferredTime;
    delete data.rangeSummary;
    delete data.nearestRequested;
    data.timeWindow = null;
    data.timeWindowRequired = false;
    data.time = null;
    data.timeRequired = false;
    data.roomId = '';
    data.seekSlots = false;
    resetSlotPage(data);
    return true;
  }
  if (choice.kind === 'otherDate') {
    delete data.preferredTime;
    delete data.rangeSummary;
    delete data.nearestRequested;
    data.date = null;
    data.timeRequired = false;
    data.roomId = '';
    data.seekSlots = false;
    resetSlotPage(data);
    return true;
  }
  return false;
}
module.exports = {
  bookingTimeView,
  bookingSlotView,
  applyTimeWindow,
  bookingControl,
  resetSlotPage,
  inspectBookingDay,
  closedDayView,
  allowsClosedDay,
  closedDayKey,
};
