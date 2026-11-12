const { clientCardCommand, unsupportedCardObject } = require('./client-card-grammar.cjs');
const { normalizeIntent, validDate } = require('./intent-schema.cjs');
const { intentRequestConstraints } = require('./intent-request-duration.cjs');
const {
  localManagementIntent,
} = require('../actions/appointments/appointment-management-intent.cjs');
const { detectRequestedOperation } = require('./requested-operation.cjs');
const { calendarReadIntent } = require('../actions/calendar-read-request.cjs');
const {
  parseDateText,
  parseTimeText,
  calendarContext,
  shiftDate,
  monthAnchor,
} = require('../language/time/temporal.cjs');
function staffQuery(text) {
  const match = text.match(
    /(?:^|\s)(?:у|к)\s+(.+?)(?=\s+(?:на|в|с|завтра|сегодня|послезавтра|для)\s|$)/iu,
  );
  return match?.[1]?.trim() || '';
}
function demoIntent(value, clock) {
  const text = value.trim().replace(/^(?:пожалуйста[,\s]+|можешь\s+)/iu, ''),
    lower = text.toLowerCase().replace(/ё/g, 'е');
  if (unsupportedCardObject(text)) return { intent: 'help' };
  const calendar = calendarReadIntent(text, clock);
  if (calendar) return calendar;
  const management = localManagementIntent(text, clock);
  if (management) return management;
  if (/(?:^|\s)(?:не|удали)(?:$|\s)/u.test(lower)) return { intent: 'help' };
  const date = parseDateText(text, clock),
    time = parseTimeText(text);
  const requested = detectRequestedOperation(text);
  const booking =
    requested.intent === 'prepareAppointment' ||
    /^(?:запиши|записать|новая запись|создай запись|подготовь запись|подготовь форму записи)/u.test(
      lower,
    );
  const constraints = intentRequestConstraints({ intent: 'prepareAppointment' }, text);
  const duration = constraints.duration;
  const staff = staffQuery(text),
    period = calendarContext(text, clock);
  if (!booking && /свободн|окн[оа]|когда\s+(?:можно|есть)/u.test(lower)) {
    if (constraints.requireDuration) return { intent: 'help' };
    const dates = (text.match(/\d{4}-\d{2}-\d{2}/g) || []).filter(validDate);
    const from = dates[0] || date || period.date;
    const to =
      dates[1] ||
      (period.mode === 'month'
        ? shiftDate(monthAnchor(from, 1), -1)
        : period.mode === 'week' || !date
          ? shiftDate(from, 6)
          : from);
    const window = text.match(/(?:^|\s)с\s+([0-2]?\d:[0-5]\d)\s+до\s+([0-2]?\d:[0-5]\d)/iu);
    return normalizeIntent({
      intent: 'availability',
      date: from,
      endDate: to,
      ...(staff ? { staffQuery: staff } : {}),
      ...(duration ? { duration } : {}),
      ...(window
        ? { time: window[1].padStart(5, '0'), endTime: window[2].padStart(5, '0') }
        : time
          ? { time }
          : {}),
    });
  }
  const card = clientCardCommand(text, { allowSearchClient: false });
  if (card)
    return normalizeIntent({
      intent: 'clientCard',
      ...(card.query ? { query: card.query } : {}),
    });
  const search = text.match(/^(?:найди|найти|покажи клиента|поиск(?:\s+клиента)?)\s*(.*)$/iu);
  if (search)
    return normalizeIntent({
      intent: 'clients',
      ...(search[1].trim() ? { query: search[1].trim() } : {}),
    });
  if (booking) {
    const query = (
      requested.intent === 'prepareAppointment' ? requested.sourceWithoutCommand : text
    )
      .trim()
      .replace(
        /^(?:запиши|записать|новая запись|создай запись|подготовь запись|подготовь форму записи)\s*/iu,
        '',
      )
      .replace(/^(?:клиента|для)\s+/iu, '')
      .split(/\s+(?:на|к|у|завтра|послезавтра|сегодня|в\s+\d|\d{4}-)/iu)[0]
      .trim();
    return normalizeIntent({
      intent: 'prepareAppointment',
      ...(query ? { query } : {}),
      ...(date ? { date } : {}),
      ...(time ? { time } : {}),
      ...(staff ? { staffQuery: staff } : {}),
      ...(duration ? { duration } : {}),
    });
  }
  if (/календар|расписан|записи|прием|(?:покажи|открой).*(?:недел|месяц)/u.test(lower)) {
    if (
      period.mode === 'day' &&
      !date &&
      /\d|пят|понедель|вторник|сред|четверг|суббот|воскрес|следующ/u.test(lower)
    )
      return { intent: 'help' };
    return normalizeIntent({
      intent: 'calendar',
      date: period.date,
      ...(period.mode !== 'day' ? { mode: period.mode } : {}),
      ...(staff ? { staffQuery: staff } : {}),
    });
  }
  return { intent: 'help' };
}
module.exports = { demoIntent };
