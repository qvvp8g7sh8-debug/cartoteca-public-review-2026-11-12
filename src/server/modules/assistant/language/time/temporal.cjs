const { readDurationMinutes } = require('./spoken-duration.cjs');
const { dateCue, normalizeClockPrefixes, bareClockSpans } = require('./clock-context.cjs');
const { validDate } = require('../../interpretation/intent-schema.cjs');
const { parseSpokenTime } = require('./spoken-time.cjs');
const { normalizeDayOrdinals } = require('./spoken-day.cjs');
const { bookingMonthContext } = require('./booking-month.cjs');
const {
  normalizeNextWeekdays,
  unsupportedRelativeDate,
  nextWeekdayDate,
  unqualifiedWeekday,
} = require('./relative-weekday.cjs');
const normalized = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .trim();
const uncertain = (text) =>
  /(?:^|[\s,;(])(?:или|либо|примерно|около|между|приблизительно)(?=$|[\s,;.)!?])/u.test(text);
function shiftDate(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
function weekStartDate(date) {
  return shiftDate(date, -(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7);
}
function monthAnchor(date, shift = 0) {
  const source = new Date(date + 'T00:00:00Z');
  source.setUTCDate(1);
  source.setUTCMonth(source.getUTCMonth() + shift);
  return source.toISOString().slice(0, 10);
}
const months = [
  'январ',
  'феврал',
  'март',
  'апрел',
  'ма[йя]',
  'июн',
  'июл',
  'август',
  'сентябр',
  'октябр',
  'ноябр',
  'декабр',
];
const days = [
  /понедельник/u,
  /вторник/u,
  /сред[ауы]/u,
  /четверг/u,
  /пятниц[ауы]/u,
  /суббот[ауы]/u,
  /воскресень[ея]/u,
];
function readDateText(
  value,
  clock,
  { clarifyWeekday = false, futureMonth = false, proposeRollover = false } = {},
) {
  const text = normalized(
      normalizeClockSeparators(normalizeNextWeekdays(normalizeDayOrdinals(value))),
    ),
    today = clock.date;
  if (
    !validDate(today) ||
    unsupportedRelativeDate(text) ||
    uncertain(text) ||
    /(?:^|[\s,;(])(?:не|нет|отмена|отмени)(?=$|[\s,;.!?)])/u.test(text)
  )
    return null;
  const nextDate = nextWeekdayDate(text, today);
  if (nextDate === null) return null;
  const relatives = [
    ...text.matchAll(/(?:^|[\s,;(])(послезавтра|завтра|позавчера|вчера|сегодня)(?=$|[\s,.!?;)])/gu),
  ];
  if (relatives.length > 1) return null;
  const relative = relatives.length
    ? shiftDate(
        today,
        { послезавтра: 2, завтра: 1, позавчера: -2, вчера: -1, сегодня: 0 }[relatives[0][1]],
      )
    : null;
  const exactDate = (date) => {
    if (!validDate(date) || (relative && relative !== date) || (nextDate && nextDate !== date))
      return null;
    const weekdays = days
      .map((pattern, index) => (pattern.test(text) ? index : -1))
      .filter((index) => index >= 0);
    return weekdays.length > 1 ||
      (weekdays.length === 1 && (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7 !== weekdays[0])
      ? null
      : date;
  };
  const extraYear = (match) => {
    const head = text.slice(0, match.index);
    const tail = text
      .slice(match.index + match[0].length)
      .replace(/^\s+год(?:а|у)?(?=$|[\s,.!?])/u, '');
    return (
      /(?:^|[\s,;.])\d{4}[\s,;.]*$/u.test(head) || /^[\s,;.]+\d{4}(?!\d)(?=$|[\s,.!?])/u.test(tail)
    );
  };
  const iso = [...text.matchAll(/(?:^|[\s,;(])(\d{4}-\d{2}-\d{2})(?=$|[\s,.!?;)])/gu)];
  const numeric = [
    ...text.matchAll(/(?:^|[\s,;(])(\d{1,2})[./](\d{1,2})[./](\d{4})(?=$|[\s,.!?;)])/gu),
  ];
  const named = [
    ...text.matchAll(
      new RegExp(
        '(?:^|[\\s,;(])(\\d{1,2})\\s+(' +
          months.join('|') +
          ')[а-я]*(?:\\s+(\\d{4})(?!\\d))?(?=$|[\\s,.!?;)])',
        'gu',
      ),
    ),
  ];
  const numbered = [...text.matchAll(/(?:^|[\s,(])(\d{1,4})\s+числа(?=$|[\s,.!?;)])/gu)];
  if (iso.length + numeric.length + named.length + numbered.length > 1) return null;
  if (iso.length) return extraYear(iso[0]) ? null : exactDate(iso[0][1]);
  if (numeric.length) {
    if (extraYear(numeric[0])) return null;
    const date =
      numeric[0][3] + '-' + numeric[0][2].padStart(2, '0') + '-' + numeric[0][1].padStart(2, '0');
    return exactDate(date);
  }
  if (named.length) {
    const match = named[0];
    if (extraYear(match)) return null;
    const month = months.findIndex((pattern) => new RegExp('^' + pattern, 'u').test(match[2])) + 1;
    const year = match[3] || today.slice(0, 4);
    let tail = text.slice(match.index + match[0].length);
    if (match[3]) tail = tail.replace(/^\s+год(?:а|у)?(?=$|\s|[,.!?])/u, '');
    if (
      /^[\s,;.]+(?:\d+(?=$|\s|[,.!?])|(?:две|два|одна|один|тысяч[аи]?|год(?:а|у)?)(?=$|\s))/u.test(
        tail,
      )
    )
      return null;
    if (!match[3] && /(?:^|\s)\d{4}\s+год/u.test(text)) return null;
    const context = futureMonth
      ? bookingMonthContext(month, match[3], today)
      : year + '-' + String(month).padStart(2, '0');
    if (!context) return null;
    const date = context + '-' + match[1].padStart(2, '0');
    const resolved = !match[3] && date < today ? null : exactDate(date);
    if (resolved && proposeRollover && !match[3] && date.slice(0, 4) !== today.slice(0, 4))
      return {
        date: null,
        dateProposal: {
          day: Number(match[1]),
          date: resolved,
          month: { context, inferredYear: true },
        },
      };
    return resolved;
  }
  if (numbered.length) {
    const match = numbered[0],
      day = Number(match[1]),
      date = today.slice(0, 8) + String(day).padStart(2, '0');
    const tail = text.slice(match.index + match[0].length);
    // An unspecified month means the current month only; never roll a past day forward.
    if (
      day < 1 ||
      day > 31 ||
      extraYear(match) ||
      /следующ|прошл|предыдущ/u.test(tail) ||
      new RegExp('(?:^|\\s)(?:' + months.join('|') + ')[а-я]*(?=$|[\\s,.!?])', 'u').test(tail) ||
      /\d{4}\s+год/u.test(tail)
    )
      return null;
    return date < today ? null : exactDate(date);
  }
  if (relative) return exactDate(relative);
  const after = text.match(/через\s+(\d{1,3})\s+(?:день|дня|дней)/u);
  if (after) return Number(after[1]) <= 366 ? exactDate(shiftDate(today, Number(after[1]))) : null;
  if (/через\s+неделю/u.test(text)) return exactDate(shiftDate(today, 7));
  if (nextDate) return exactDate(nextDate);
  const weekday = days.findIndex((pattern) => pattern.test(text));
  if (weekday >= 0) {
    const start = weekStartDate(today),
      candidate = shiftDate(start, weekday),
      thisWeek = /эт(?:ой|у)\s+недел/u.test(text);
    const date = exactDate(thisWeek || candidate >= today ? candidate : shiftDate(candidate, 7));
    if (clarifyWeekday && date === today && !thisWeek && unqualifiedWeekday(text))
      return { date: null, dateWeekday: today };
    return date;
  }
  return null;
}
function parseDateText(value, clock) {
  return readDateText(value, clock);
}
function parseBookingDateText(value, clock) {
  return readDateText(value, clock, { futureMonth: true });
}
function bookingDateReading(value, clock, { futureMonth = false } = {}) {
  const result = readDateText(value, clock, {
    clarifyWeekday: true,
    futureMonth,
    proposeRollover: futureMonth,
  });
  return result && typeof result === 'object' ? result : { date: result };
}
const dashSequence =
  /(?<![\p{L}\p{N}:.,+−–—-])([+−-]?\d{1,4}(?:\s*[-–—:.,]\s*\d{1,4}){1,5})(?=$|[\s,.!?;)])/giu;
function dashClockContext(input, offset, length, minute) {
  const before = input.slice(0, offset),
    after = input.slice(offset + length),
    date = normalizeDayOrdinals(input);
  if (
    /(?:^|[\s,(])(?:номер|код|телефон|кабинет|услуга|услугу|процедура|процедуру)\s*$/iu.test(before)
  )
    return false;
  if (
    /(?:^|[\s,(])(?:в|к|ко|(?:время|начало)(?:\s+приема)?(?:\s+(?:в|на))?)\s*(?:[+−-]\s*)?$/iu.test(
      before,
    )
  )
    return true;
  if (
    /(?:^|[\s,(])(?:на|после|до|между|с|от)\s*(?:[+−-]\s*)?$/iu.test(before) &&
    (Number(minute) === 0 || Number(minute) > 12 || new RegExp(dateCue, 'u').test(date))
  )
    return true;
  return (
    new RegExp(dateCue + '[\\s,]*$', 'u').test(normalizeDayOrdinals(before)) ||
    (/^[\s,;]*$/u.test(before) &&
      new RegExp(dateCue, 'u').test(normalizeDayOrdinals(after).replace(/^[\s,]*(?:на\s+)?/u, '')))
  );
}
// A complete contextual H-MM token is a clock; date-like bare tokens stay ambiguous.
function normalizeClockSeparators(value) {
  const text = normalizeClockPrefixes(value).replace(
    /(?<![\p{L}\p{N}:.,+−–—-])(\d{1,2})\s*[-–—]\s*(\d{2})\s*[-–—]\s*(\d{1,2})\s+числа(?=$|[\s,.!?;)])/giu,
    (match, hour, minute, day, offset, input) =>
      !/(?:[-–—+−]\s*|\d{1,4}\s*[-–—:.,]\s*\d{1,4}\s*(?:[,;]|и|до|по)\s*)$/u.test(
        input.slice(0, offset),
      ) &&
      Number(hour) <= 23 &&
      Number(minute) <= 59 &&
      Number(day) >= 1 &&
      Number(day) <= 31
        ? hour + ':' + minute + ' ' + day + ' числа'
        : match,
  );
  const qualified = text.replace(
    /(?<![\p{L}\p{N}:.,+−–—-])(\d{1,2})\s*[-–—]\s*(\d{2})(?![\d:.,-])(?=\s+(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)(?=$|[\s,.!?;)]))/giu,
    '$1:$2',
  );
  return qualified.replace(new RegExp(dashSequence), (match, token, offset, input) => {
    const clock = token.match(/^(\d{1,2})\s*[-–—]\s*(\d{2})(,\s*.+)?$/u);
    const dateTail =
      clock?.[3] && normalizeDayOrdinals(clock[3].slice(1) + input.slice(offset + token.length));
    if (
      !clock ||
      (dateTail && !new RegExp('^\\s*' + dateCue, 'u').test(dateTail)) ||
      /[-–—+−]\s*$/u.test(input.slice(0, offset)) ||
      !dashClockContext(input, offset, token.length, clock[2])
    )
      return match;
    return clock[1] + ':' + clock[2] + (clock[3] || '');
  });
}
function hasUnparsedDashClock(value) {
  // Call after normalization: remaining dash+meridiem or dash+day is malformed or a range.
  const candidates = String(value || '').matchAll(
    /(?<![\p{L}\p{N}:.,+−–—-])(?:(?:в|на)\s*)?([+−-]?\d{1,4}(?:\s*[-–—:.,]\s*\d{1,4}){1,5})\s+(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью|числа)(?=$|[\s,.!?;)])/giu,
  );
  if ([...candidates].some((match) => /[-–—]/u.test(match[1]))) return true;
  return [...String(value || '').matchAll(new RegExp(dashSequence))].some(
    (match) =>
      /[-–—]/u.test(match[1]) &&
      dashClockContext(
        String(value || ''),
        match.index,
        match[1].length,
        match[1].split(/[-–—:.,]/u)[1],
      ),
  );
}
function parseTimeText(value, { timeContext = false } = {}) {
  const raw = normalized(value)
    .replace(/[.!?]+$/u, '')
    .trim();
  const text = normalizeClockSeparators(raw).replace(
    /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}/g,
    ' ',
  );
  if (
    hasUnparsedDashClock(text) ||
    uncertain(text) ||
    /(?:^|\s)(?:не|нет|отмена|отмени)(?:$|\s|[,!?])/u.test(text)
  )
    return null;
  if (/(?:^|[\s,;])(?:точнее|точней|вернее|исправляю|поправка)(?=$|[\s,:])/u.test(text))
    return null;
  const countedLength = /^на\s+(.+)$/u.exec(text);
  if (
    countedLength &&
    countedLength[1] !== 'час' &&
    /(?:час(?:а|ов)?|мин(?:ут(?:а|ы|у)?)?)(?=$|[\s,.!?;])/u.test(countedLength[1]) &&
    !/(?:^|\s)(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)(?=$|[\s,.!?;])/u.test(text) &&
    readDurationMinutes(countedLength[1]) !== null &&
    !bareClockSpans(text, { timeContext: true }).some(
      (span) => span.start === 0 && span.end === text.length,
    )
  )
    return null;
  const spoken = parseSpokenTime(text);
  if (spoken) return spoken;
  // An unconsumed comma clock must not degrade to a different colon-clock fragment.
  if (/\d\s*,\s*\d/u.test(text)) return null;
  if (
    /^\s*(?:в\s*)?\d{1,2}[:.]\d{2}\s+(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)[.!?]*\s*$/u.test(
      text,
    )
  )
    return null;
  const exact = [...text.matchAll(/(?<![\p{L}\p{N}])([01]?\d|2[0-3])([:.])([0-5]\d)(?![:.\d])/gu)];
  if (exact.length) {
    const wholeDotClock = timeContext && /^(?:(?:в|на|ко?)\s+)?\d{1,2}\.\d{2}$/u.test(raw);
    if (
      exact.length !== 1 ||
      (exact[0][2] === '.' && !wholeDotClock && !/(?:в\s+\d|час|мин|время)/u.test(text))
    )
      return null;
    return exact[0][1].padStart(2, '0') + ':' + exact[0][3];
  }
  if (/полдень/u.test(text)) return '12:00';
  if (/полночь/u.test(text)) return '00:00';
  const time = text.match(
    /^(?:(?:в|на|ко?)\s*)?([01]?\d|2[0-3])(?:\s*час(?:а|ов)?)?(?:\s+([0-5]?\d)\s*мин(?:ут[ауы]?)?)?(?:\s+(утра|утром|дня|днем|вечера|вечером|ночи|ночью))?[,.!?]?$/u,
  );
  if (!time) return null;
  let hour = Number(time[1]);
  const part = time[3] || '';
  if (!part && hour >= 1 && hour <= 6) hour += 12;
  if (part) {
    if (hour > 12) return null;
    if (/^(дн|веч)/u.test(part) && hour < 12) hour += 12;
    if (/^ноч/u.test(part) && hour === 12) hour = 0;
  }
  return String(hour).padStart(2, '0') + ':' + String(Number(time[2] || 0)).padStart(2, '0');
}
function calendarContext(value, clock) {
  const text = normalized(value);
  if (/недел/u.test(text) && !/через\s+неделю/u.test(text)) {
    const shift = /следующ/u.test(text) ? 7 : /прошл|предыдущ/u.test(text) ? -7 : 0;
    return { date: shiftDate(weekStartDate(clock.date), shift), mode: 'week' };
  }
  const namedMonth = text.match(
    new RegExp(
      '(?:^|(?:^|\\s)(?:за|на|в|месяц(?:а|е)?|календарь|расписание|записи)\\s+)(' +
        months.join('|') +
        ')[а-я]*\\s+(\\d{4})(?=$|\\s|[,.!?])',
      'u',
    ),
  );
  if (namedMonth && !parseDateText(text, clock) && !uncertain(text)) {
    const month =
      months.findIndex((pattern) => new RegExp('^' + pattern, 'u').test(namedMonth[1])) + 1;
    const date = namedMonth[2] + '-' + String(month).padStart(2, '0') + '-01';
    if (validDate(date)) return { date, mode: 'month' };
  }
  if (/месяц/u.test(text)) {
    const shift = /следующ/u.test(text) ? 1 : /прошл|предыдущ/u.test(text) ? -1 : 0;
    return { date: monthAnchor(clock.date, shift), mode: 'month' };
  }
  return { date: parseDateText(text, clock) || clock.date, mode: 'day' };
}
module.exports = {
  shiftDate,
  weekStartDate,
  monthAnchor,
  parseDateText,
  parseBookingDateText,
  bookingDateReading,
  normalizeClockSeparators,
  bareClockSpans,
  hasUnparsedDashClock,
  parseTimeText,
  calendarContext,
};
