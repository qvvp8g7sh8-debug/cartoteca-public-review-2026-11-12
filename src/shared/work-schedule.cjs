// Civil dates and wall-clock minutes in the organization's timezone, not the device's.
function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '0001-01-01')
    return false;
  const parsed = new Date(date + 'T12:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
function nextDate(date, offset = 1) {
  const parsed = new Date(date + 'T12:00:00Z');
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}
function minutes(time, end = false) {
  if (end && time === '24:00') return 1440;
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
function normalizeDay(values, fail) {
  if (!values || !['working', 'closed', 'reset'].includes(values.status))
    throw fail(400, 'Выберите рабочий день, выходной или сброс настройки.');
  if (values.status !== 'working') return { status: values.status, intervals: [] };
  if (!Array.isArray(values.intervals) || !values.intervals.length || values.intervals.length > 8)
    throw fail(400, 'Укажите от одного до восьми рабочих интервалов.');
  const intervals = values.intervals
    .map((pair) => {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !Number.isFinite(minutes(pair[0])) ||
        !Number.isFinite(minutes(pair[1], true)) ||
        minutes(pair[0]) >= minutes(pair[1], true)
      )
        throw fail(400, 'Начало рабочего интервала должно быть раньше окончания.');
      return [...pair];
    })
    .sort((a, b) => minutes(a[0]) - minutes(b[0]));
  if (
    intervals.some(
      (pair, index) => index && minutes(pair[0]) < minutes(intervals[index - 1][1], true),
    )
  )
    throw fail(400, 'Рабочие интервалы не должны пересекаться.');
  return { status: 'working', intervals };
}
// Schedule management keeps its former unset-day policy; manual admission opts in.
function bookingWarning(
  appointment,
  dayAt,
  closureAt,
  { warnUnset = false, compact = false } = {},
) {
  let date = appointment.date,
    start = minutes(appointment.time),
    remaining = Number(appointment.duration);
  if (
    !validDate(date) ||
    !Number.isFinite(start) ||
    !Number.isInteger(remaining) ||
    remaining < 1 ||
    remaining > 1440
  )
    return compact
      ? 'Проверьте дату и время'
      : 'Укажите другую дату и время записи; проверьте длительность.';
  while (remaining > 0) {
    const end = Math.min(1440, start + remaining),
      day = dayAt(date),
      closure = closureAt(date);
    if (closure?.status === 'closed')
      return compact ? 'Организация закрыта' : 'Организация закрыта в выбранную дату.';
    if (day?.status === 'closed')
      return compact ? 'Выходной сотрудника' : 'У сотрудника выходной в выбранную дату.';
    if (warnUnset && (!day || day.status === 'unset'))
      return compact
        ? 'График не задан'
        : 'День не настроен для записи: рабочие часы сотрудника не заданы.';
    if (
      day?.status === 'working' &&
      !day.intervals.some((pair) => start >= minutes(pair[0]) && end <= minutes(pair[1], true))
    )
      return compact
        ? 'Вне графика'
        : 'Запись выходит за рабочие часы сотрудника или попадает на перерыв.';
    remaining -= end - start;
    start = 0;
    date = nextDate(date);
  }
  return '';
}
function createAppointmentScheduleMath() {
  const appointmentScheduleWarning = (appointment, days, closures) =>
    bookingWarning(
      appointment,
      (date) => days[date],
      (date) => closures[date],
      { warnUnset: true },
    );
  const appointmentScheduleHint = (appointment, days, closures) =>
    bookingWarning(
      appointment,
      (date) => days[date],
      (date) => closures[date],
      { warnUnset: true, compact: true },
    ) || 'По графику';
  return { appointmentScheduleWarning, appointmentScheduleHint };
}
if (typeof module !== 'undefined')
  module.exports = { validDate, nextDate, minutes, normalizeDay, bookingWarning };
