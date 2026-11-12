const { detectRequestedOperation } = require('../interpretation/requested-operation.cjs');
const { validDate } = require('../interpretation/intent-schema.cjs');
const { dayEvidence } = require('../dialogue/bare-day-proposal.cjs');
const { normalizeDayOrdinals } = require('../language/time/spoken-day.cjs');
const { nextWeekdayPhrase } = require('../language/time/relative-weekday.cjs');
const { parseDateText, calendarContext } = require('../language/time/temporal.cjs');
const { calendarReadTarget } = require('../interpretation/calendar-read-grammar.cjs');
const months = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const monthForms = [
  'январ(?:ь|я)',
  'феврал(?:ь|я)',
  'март(?:а)?',
  'апрел(?:ь|я)',
  'ма(?:й|я)',
  'июн(?:ь|я)',
  'июл(?:ь|я)',
  'август(?:а)?',
  'сентябр(?:ь|я)',
  'октябр(?:ь|я)',
  'ноябр(?:ь|я)',
  'декабр(?:ь|я)',
];
const weekday = '(?:понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[ея])';
const weekdayDate = new RegExp(
  '^(?:(?:в|во)\\s+)?(?:' +
    nextWeekdayPhrase +
    '|(?:(?:этот|эту|это)\\s+)?' +
    weekday +
    '(?:\\s+этой\\s+недели)?)$',
  'u',
);
const prefix = new RegExp(
  '^(?:(?:пожалуйста[,\\s]+|можешь\\s+))*(?:открой(?:те)?|открою|открыть|покажи(?:те)?)\\s+(?:мне\\s+)?' +
    calendarReadTarget +
    '(?=$|[\\s,.!?;:])',
  'u',
);
// The full tail must be one supported civil date/period, not a clock, filter or second task.
function readPeriod(tail, clock) {
  const text = tail.replace(/^(?:на|за)\s*([\d])/u, '$1').replace(/^(?:на|за)\s+/u, '');
  if (!text) return { date: clock.date, mode: 'day' };
  const bare = dayEvidence(text, { dateStep: true });
  if (bare?.whole) {
    const date = clock.date.slice(0, 8) + String(bare.day).padStart(2, '0');
    return validDate(date) ? { date, mode: 'day' } : null;
  }
  const namedText = normalizeDayOrdinals(text);
  const named = new RegExp(
    '^(\\d{1,2})\\s+(' + monthForms.join('|') + ')(?:\\s+(\\d{4})(?:\\s+года?)?)?$',
    'u',
  ).exec(namedText);
  if (named) {
    // Reading a past date is allowed; append the source context year explicitly.
    const date = parseDateText(namedText + (named[3] ? '' : ' ' + clock.date.slice(0, 4)), clock);
    return date ? { date, mode: 'day' } : null;
  }
  if (
    /^\d{4}-\d{2}-\d{2}$/u.test(text) ||
    /^\d{1,2}[./]\d{1,2}[./]\d{4}$/u.test(text) ||
    /^(?:сегодня|завтра|послезавтра|вчера|позавчера|через\s+неделю|через\s+\d{1,3}\s+(?:день|дня|дней))$/u.test(
      text,
    ) ||
    weekdayDate.test(text)
  ) {
    const date = parseDateText(text, clock);
    return date ? { date, mode: 'day' } : null;
  }
  if (
    /^(?:(?:эту|этой|текущую|текущей|следующую|следующей|прошлую|прошлой)\s+)?недел[юи]$/u.test(
      text,
    ) ||
    /^(?:(?:этот|текущий|следующий|прошлый)\s+)?месяц$/u.test(text) ||
    new RegExp('^(?:' + monthForms.join('|') + ')\\s+\\d{4}$', 'u').test(text)
  )
    return calendarContext(text, clock);
  return null;
}
function calendarReadIntent(raw, clock) {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
  const requested = detectRequestedOperation(text),
    match = prefix.exec(text);
  if (requested.intent !== 'calendar' && !requested.ambiguous) return null;
  if (!match && requested.intent !== 'calendar') return null;
  if (
    !match ||
    requested.negated ||
    requested.ambiguous ||
    requested.intent !== 'calendar' ||
    !validDate(clock?.date)
  )
    return { intent: 'help' };
  const tail = text
    .slice(match[0].length)
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
  const period = readPeriod(tail, clock);
  return period ? { intent: 'calendar', ...period } : { intent: 'help' };
}
function calendarDayText(date) {
  return (
    Number(date.slice(8)) + ' ' + months[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4)
  );
}
module.exports = { calendarReadIntent, calendarDayText };
