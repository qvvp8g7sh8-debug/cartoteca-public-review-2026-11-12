const { parseDateText } = require('./temporal.cjs');
const { normalizeDayOrdinals } = require('./spoken-day.cjs');
const { spokenNumber } = require('./spoken-number.cjs');
const { validDate } = require('../../interpretation/intent-schema.cjs');
const { normalizeNextWeekdays, wholeNextWeekday } = require('./relative-weekday.cjs');
const MONTH =
  '(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)';
const NAMED_DATE = new RegExp('^\\d{1,2} ' + MONTH + '(?: \\d{4}(?: года?)?)?$', 'u');
const WEEKDAY =
  /^(?:(?:в|во|на) )?(?:(этот|эта|эту|это|этой) )?(понедельник|вторник|среда|среду|среды|четверг|пятница|пятницу|пятницы|суббота|субботу|субботы|воскресенье|воскресенья)( на этой неделе)?$/u;
function wholeDateAnswer(value, clock, readDate = parseDateText) {
  if (typeof value !== 'string' || value.length > 160 || !validDate(clock?.date)) return null;
  let text = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  // Consume only these fixed courtesy words, never a partial date hidden in a command.
  text = text
    .replace(/^пожалуйста(?:,\s*|\s+)/u, '')
    .replace(/(?:,\s*|\s+)пожалуйста$/u, '')
    .replace(/^(?:на|дата) /u, '')
    .trim();
  if (!text) return null;
  text = normalizeNextWeekdays(normalizeDayOrdinals(text));
  let candidate = null;
  if (
    /^(?:сегодня|завтра|послезавтра|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})$/u.test(text) ||
    NAMED_DATE.test(text)
  )
    candidate = text;
  if (wholeNextWeekday(text)) candidate = text;
  const weekday = WEEKDAY.exec(text);
  if (weekday) {
    // Explicit 'this Wednesday' must stay in the current week, including a past-day rejection.
    candidate = weekday[2] + (weekday[1] || weekday[3] ? ' на этой неделе' : '');
  }
  if (!candidate && text.endsWith(' числа')) {
    // Existing ordinal normalization requires a month lookahead. January is a lexical
    // sentinel only; parseDateText still receives 'N числа' with the real current month.
    const numbered = normalizeDayOrdinals(text.slice(0, -6) + ' января');
    const day = /^(\d{1,2}) января$/u.exec(numbered);
    if (day) candidate = day[1] + ' числа';
  }
  if (!candidate && text === 'через неделю') candidate = text;
  if (!candidate) {
    const relative = /^через (.+) (?:день|дня|дней)$/u.exec(text);
    const days = relative ? spokenNumber(relative[1], 366) : null;
    if (days !== null && days >= 1) candidate = 'через ' + days + ' дней';
  }
  if (!candidate) return null;
  const date = readDate(candidate, clock);
  return date && validDate(date) && date >= clock.date ? date : null;
}
module.exports = { wholeDateAnswer };
