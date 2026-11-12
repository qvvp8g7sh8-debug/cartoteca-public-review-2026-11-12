const {
  bareDayProposal,
  bareDaySignal,
  inheritMonthContext,
} = require('../../dialogue/bare-day-proposal.cjs');
const { fail } = require('../../../../../shared/errors.cjs');
const {
  nextWeekdayPhrase,
  normalizeNextWeekdays,
  unsupportedRelativeDate,
} = require('./relative-weekday.cjs');
const {
  parseDateText,
  bookingDateReading,
  parseTimeText,
  normalizeClockSeparators,
  hasUnparsedDashClock,
  bareClockSpans,
} = require('./temporal.cjs');
const { normalizeDayOrdinals, monthWord: month } = require('./spoken-day.cjs');
const { spokenNumber } = require('./spoken-number.cjs');
const { clockMinute, zeroClockParts } = require('./clock-minute.cjs');
const { fieldUncertainty } = require('./temporal-field-uncertainty.cjs');
const {
  temporalCorrectionScope,
  mergeTemporalCorrection,
} = require('./temporal-correction-scope.cjs');
const dateStart = new RegExp('^\\d{1,4}\\s*(?:' + month + '|числа)(?=$|[\\s,.!?])', 'u');
const dateSignal = new RegExp(
  '(?:^|[\\s,;(])(?:\\d{4,6}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4,6}|\\d{1,2}\\s*' +
    month +
    '|\\d{1,4}(?:\\s*[-–—:.,]\\s*\\d{1,4}){0,5}\\s+числа|послезавтра|завтра|позавчера|вчера|сегодня|понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[ея]|через\\s+(?:\\d{1,3}\\s+(?:день|дня|дней)|неделю))(?=$|[\\s,.!?;)])',
  'u',
);
const part = '(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)';
const formatted = new RegExp('^(\\d{1,2}[:.]\\d{2})(?!\\d|\\.\\d)(?:\\s+' + part + ')?', 'u');
const comma = new RegExp(
  '^\\d{1,2}\\s*,\\s*\\d{1,2}(?:\\s*,\\s*\\d{1,2}\\s*,\\s*\\d{1,2})?(?:\\s+' + part + ')?',
  'u',
);
const startsClock =
  /^(?:\d+(?=$|[\s,:.])|ноль|нуль|один|одна|дв[ае]|три|четыр|пят|шест|сем|восем|девят|десят|одиннад|двенад|тринад|четырнад|пятнад|шестнад|семнад|восемнад|девятнад|двадцать|час|пол|четверть|без)/u;
const qualitativeClock =
  /(?:^|[\s,(])(?:(?:после|до)\s+обеда|наутро|утром|вечером|ночью|днем|(?:на|в)\s+(?:утро|вечер|ночь))(?=$|[\s,.!?)])/u;
const correction =
  /(?:^|[\s,;(])(?:нет|точнее|точней|вернее|исправляю|поправка|лучше|вместо)(?=$|[\s,;:.)!?])/u;
function temporalBounds(text) {
  const bounded = new Set();
  const prefix =
    /(?:^|[\s,(])(?:не\s+)?(?:после|до|между|позже|позднее|раньше|ранее|начиная\s+с)\s+/gu;
  for (const match of text.matchAll(prefix)) {
    const tail = text
      .slice(match.index + match[0].length, match.index + match[0].length + 160)
      .replace(/^чем\s+/u, '')
      .replace(/^(?:в|на)\s+/u, '');
    if (
      /между\s+$/u.test(match[0]) &&
      /^(?:[01]?\d|2[0-3])\s+и\s+(?:[01]?\d|2[0-3])(?:\s+часами)?\s*(?=$|[,.!?;)])/u.test(tail)
    )
      bounded.add('time');
    const date = dateSignal.exec(tail);
    if (date?.index === 0) bounded.add('date');
    else if (
      /^\d{1,2}[:.,]\d{1,2}(?!\d)/u.test(tail) ||
      /^\d{1,2}(?:\s+час(?:а|ов)?)?(?=$|[,.!?;]|\s+(?:утра|дня|вечера|ночи|на|для)(?=$|\s))/u.test(
        tail,
      ) ||
      /^(?:полудня|полуночи|утра|вечера|ночи)(?=$|[\s,.!?;])/u.test(tail)
    )
      bounded.add('time');
    const clause = tail.split(/[,.!?;]/u)[0].trim();
    if (date?.index !== 0 && startsClock.test(clause) && parseTimeText(clause)) bounded.add('time');
  }
  const day = '\\d{1,2}(?:\\s+' + month + '(?:\\s+\\d{4}(?:\\s+года?)?)?)?';
  if (
    new RegExp(
      '(?:^|[\\s,(])(?:с|от)\\s+' + day + '\\s+(?:по|до)\\s+\\d{1,2}(?=$|[\\s:.,!?;])',
      'u',
    ).test(text)
  )
    bounded.add('date');
  return bounded;
}
function spokenClockClause(value) {
  const words = value.trim().split(/\s+/u);
  const end = words.findIndex(
    (word) =>
      spokenNumber(word, 100000) === null &&
      clockMinute(word) === null &&
      zeroClockParts(word) === null &&
      !/^\d+$/u.test(word) &&
      !/^(?:и|час(?:а|ов)?|минут(?:а|ы)?|утра|утром|дня|днем|вечера|вечером|ночи|ночью|пол(?:овин[аеуы])?|четверть|без|четверти|пяти|десяти|пятнадцати|двадцати)$/u.test(
        word,
      ) &&
      !parseTimeText(word + ' дня') &&
      !parseTimeText('четверть ' + word + ' дня'),
  );
  if (end < 0) return value;
  // Unsupported time units remain part of the invalid clock, never truncated to minutes.
  if (
    /^(?:секунд|миллисекунд)/u.test(words[end]) ||
    /^(?:если|или|либо|не|нет|кроме)$/u.test(words[end])
  )
    return value;
  return words.slice(0, end).join(' ');
}
function clockClauses(text) {
  const bareClocks = bareClockSpans(text);
  // Dates are never clock candidates, even when written with dots.
  const masked = text.replace(/\d{4,6}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{4,6}/gu, (value) =>
    ' '.repeat(value.length),
  );
  const clauses = [],
    covered = [];
  if (hasUnparsedDashClock(masked)) clauses.push(null);
  for (const prefix of masked.matchAll(/(?<![\p{L}\p{N}])(в|на|ко?)\s+/gu)) {
    const start = prefix.index + prefix[0].length,
      tail = masked.slice(start, start + 160);
    if (dateStart.test(tail) || !startsClock.test(tail)) continue;
    const numeric = tail.match(formatted) || tail.match(comma);
    const candidate = numeric
      ? numeric[0]
      : spokenClockClause(
          tail.split(
            /(?:\s+(?:в|на|по|для|к|ко|у|завтра|послезавтра|сегодня)(?=$|\s))|[,!?;]|\.(?=$|\s)/u,
          )[0],
        );
    // A duration must not borrow the meridiem qualifier of a later clock clause.
    if (
      prefix[1] === 'на' &&
      !/^\d{1,2}\s*[:.,]/u.test(candidate) &&
      !new RegExp(part + '|полдень|полночь', 'u').test(candidate) &&
      !bareClocks.some((span) => span.start === prefix.index)
    )
      continue;
    const rest = tail.slice(candidate.length);
    const dateTail = dateSignal.exec(rest.replace(/^[\s,;]+/u, ''))?.index === 0;
    const invalidTail =
      numeric &&
      (/^(?:[:\d\p{L}]|\s+мин(?:ут)?)/u.test(rest) || (/^,\s*\d/u.test(rest) && !dateTail));
    clauses.push(invalidTail ? null : parseTimeText('в ' + candidate));
    covered.push([start, start + candidate.length]);
  }
  // A standalone colon clock is explicit, but a standalone decimal may be a number.
  const standalone = new RegExp(
    '(?:^|[\\s,(])(\\d{1,2}:\\d{2})(?:\\s+' + part + ')?(?=$|[\\s,.!?;)])',
    'gu',
  );
  for (const match of masked.matchAll(standalone)) {
    const start = match.index + match[0].indexOf(match[1]);
    if (covered.some(([from, to]) => start >= from && start < to)) continue;
    clauses.push(parseTimeText(match[0].trim()));
  }
  return clauses;
}
function literalConstraints(text, clock, clarifyWeekday, correcting = false, pendingBounds) {
  // «На 17.10» or «на 17-10» may be DD.MM; never invent a clock or year.
  const clockText = text.replace(
    /(?<![\p{L}\p{N}])на\s*(?:0?[1-9]|[12]\d|3[01])[.–—-](?:0?[1-9]|1[0-2])(?!\d|[.–—-]\d)(?=$|[\s,.!?;)])/gu,
    (value) => (/[-–—]/u.test(value) && dateSignal.test(text) ? value : ' '.repeat(value.length)),
  );
  const shortDate =
    clockText !== text ||
    (correcting && /^(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])[.!?]*$/u.test(text));
  const dateProposal = bareDayProposal(text, clock);
  const hasDate =
      bareDaySignal(text) ||
      shortDate ||
      dateSignal.test(text) ||
      new RegExp(nextWeekdayPhrase, 'u').test(text),
    vagueTime = qualitativeClock.test(text),
    clocks = clockClauses(clockText),
    hasTime = clocks.length > 0;
  const bounds = temporalBounds(text);
  if (!hasDate && !hasTime && !vagueTime && !correcting && !bounds.size) return {};
  if (bounds.size && !pendingBounds)
    throw fail(
      400,
      'Уточните конкретные дату и время записи. Границы периода не задают точное начало приёма.',
    );
  const result = {},
    ambiguity = fieldUncertainty(text);
  if (hasDate) {
    const {
      date,
      dateWeekday,
      dateProposal: rolledDate,
    } = shortDate || ambiguity.date || unsupportedRelativeDate(text)
      ? { date: null }
      : clarifyWeekday
        ? bookingDateReading(ambiguity.dateText, clock, { futureMonth: true })
        : { date: parseDateText(ambiguity.dateText, clock) };
    result.date = dateProposal || rolledDate ? null : date && date >= clock.date ? date : null;
    if (dateProposal || rolledDate) result.dateProposal = dateProposal || rolledDate;
    else if (dateWeekday) result.dateWeekday = dateWeekday;
  }
  if (hasTime) result.time = !ambiguity.time && clocks.length === 1 ? clocks[0] : null;
  else if (shortDate || vagueTime) result.time = null;
  if (correcting && !hasTime) {
    // Relative corrections retract the old field without guessing an absolute value.
    if (
      /^(?:(?:время|час)\s+)?(?:на\s+)?[^,.!?;]{0,100}(?:минут|час|полчаса|четверть)[^,.!?;]{0,30}\s+(?:позже|позднее|раньше|ранее)[.!?]*$/u.test(
        text,
      )
    )
      result.time = null;
    else if (/^(?:(?:время|час)\s+)?(?:на|в)\s+(?:утро|вечер|ночь)[.!?]*$/u.test(text))
      result.time = null;
    else if (!hasDate) {
      const standalone = parseTimeText(text);
      const bare = text.replace(/[.!?]+$/u, '').trim();
      if (standalone || /^\d{1,6}$/u.test(bare) || spokenNumber(bare, 100000) !== null)
        result.time = standalone;
    }
  }
  if (
    correcting &&
    !hasDate &&
    /^(?:(?:дат[ау]|день)\s+)?(?:на\s+)?(?:следующ(?:ий|его)|предыдущ(?:ий|его))\s+д(?:ень|ня)[.!?]*$/u.test(
      text,
    )
  )
    result.date = null;
  if (
    correcting &&
    !hasDate &&
    /^(?:(?:дат[ау]|день)\s+)?через\s+[\p{L}\d\s-]{1,60}\s+(?:день|дня|дней|недел[юиь])[.!?]*$/u.test(
      text,
    )
  )
    result.date = null;
  if (pendingBounds) {
    for (const field of bounds) pendingBounds.add(field);
    for (const field of Object.keys(result)) if (!bounds.has(field)) pendingBounds.delete(field);
  }
  return result;
}
function initialTemporalConstraints(intent, requestText, clock, { clarifyWeekday = false } = {}) {
  if (
    intent?.intent !== 'prepareAppointment' ||
    typeof requestText !== 'string' ||
    requestText.length > 4000
  )
    return {};
  const text = normalizeClockSeparators(
    normalizeNextWeekdays(normalizeDayOrdinals(requestText.normalize('NFKC'))),
  )
    .replace(/\s+/gu, ' ')
    .trim();
  const scoped = temporalCorrectionScope(text);
  if (scoped)
    return mergeTemporalCorrection(
      initialTemporalConstraints(intent, scoped.before, clock, { clarifyWeekday }),
      initialTemporalConstraints(intent, scoped.rejected, clock, { clarifyWeekday }),
      initialTemporalConstraints(intent, scoped.after, clock, { clarifyWeekday }),
    );
  if (!correction.test(text)) return literalConstraints(text, clock, clarifyWeekday);
  // «Вместо» can state either the replacement or the retracted value first.
  // Keep its established model correction path instead of reversing that meaning.
  if (/(?:^|[\s,;(])вместо(?=$|[\s,;:.)!?])/u.test(text)) return {};
  const markers = [...text.matchAll(new RegExp(correction.source, 'gu'))];
  const result = {},
    pendingBounds = new Set();
  let start = 0;
  for (let index = 0; index <= markers.length; index++) {
    const end = markers[index]?.index ?? text.length;
    const segment = text.slice(start, end).replace(/^[\s,;:]+|[\s,;:]+$/gu, '');
    if (segment) {
      const found = inheritMonthContext(
        literalConstraints(segment, clock, clarifyWeekday, index > 0, pendingBounds),
        result.date,
      );
      if (Object.hasOwn(found, 'date') && !found.dateProposal) delete result.dateProposal;
      if (Object.hasOwn(found, 'date') && !found.dateWeekday) delete result.dateWeekday;
      Object.assign(result, found);
    }
    if (markers[index]) start = markers[index].index + markers[index][0].length;
  }
  if (pendingBounds.size)
    throw fail(
      400,
      'Уточните конкретные дату и время записи. Границы периода не задают точное начало приёма.',
    );
  return result;
}
module.exports = { initialTemporalConstraints };
