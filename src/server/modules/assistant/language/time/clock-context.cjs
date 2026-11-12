const { normalizeDayOrdinals, monthWord } = require('./spoken-day.cjs');
const { spokenNumber } = require('./spoken-number.cjs');
const { zeroClockParts } = require('./clock-minute.cjs');
const dateCue =
  '(?:^|[\\s,(])(?:послезавтра|завтра|позавчера|вчера|сегодня|понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[ея]|через\\s+(?:\\d{1,3}\\s+(?:день|дня|дней)|неделю)|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{1,2}\\s+' +
  monthWord +
  '|\\d{1,2}\\s+числа)(?=$|[\\s,.!?;)])';
const hourWord =
  '(?:час|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать|двадцать(?:\\s+(?:один|два|три))?)';
const edge = '(?=$|[\\s,.!?;)])';
function normalizeClockPrefixes(value) {
  return String(value || '')
    .replace(
      new RegExp(
        '(?<![\\p{L}\\p{N}])(?:по\\s+времени\\s+(?:мне\\s+)?(?:подойдет|подойдёт|удобно)|(?:время|начало)(?:\\s+приема)?\\s*(?:теперь|будет|поставь|поставим)?\\s*[:=–—-]?)\\s+(?=(?:\\d{1,4}|' +
          hourWord +
          '|пол(?:овин[аеуы])?|четверть|без)(?=$|[\\s:.,!?;]))',
        'giu',
      ),
      'в ',
    )
    .replace(
      /(?<![\p{L}\p{N}])(в|на|ко?)\s*(\d{1,2})\s*(час(?:а|ов)?)(?=$|[\s,.!?;)])/giu,
      '$1 $2 $3',
    )
    .replace(
      new RegExp(
        '(?<![\\p{L}\\p{N}])(в|на|ко?)\\s*(' + hourWord + ')\\s*(час(?:а|ов)?)' + edge,
        'giu',
      ),
      '$1 $2 $3',
    )
    .replace(
      /(?<![\p{L}\p{N}])(в|на|ко?)(?=\d{1,2}(?:\s*[-–—:]\s*\d{1,4}|(?=$|[\s,.!?;)])))/giu,
      '$1 ',
    )
    .replace(
      /(?<![\p{L}\p{N}])на(?=\d{1,4}\s*(?:час(?:а|ов)?|мин(?:ут(?:а|ы|у)?)?)(?=$|[\s,.!?;)]))/giu,
      'на ',
    )
    .replace(new RegExp('(?<![\\p{L}\\p{N}])(в|на|ко?)(?=' + hourWord + edge + ')', 'giu'), '$1 ');
}
function startsNumber(value) {
  const words = value
    .trim()
    .replace(/[,.!?;].*$/u, '')
    .split(/\s+/u)
    .slice(0, 3);
  return words.some(
    (_, index) => spokenNumber(words.slice(0, index + 1).join(' '), 100000) !== null,
  );
}
function hasDurationPrefix(value) {
  return /(?:^|\s)(?:длительност(?:ь|ью|и)|продолжительност(?:ь|ью|и)|длится|длиться)(?:\s+(?:приема|процедуры|услуги|записи))?\s*[:=]?\s*$/u.test(
    value,
  );
}
function bareClockSpans(value, context = {}) {
  if (context?.durationContext === true) return [];
  const text = String(value || '');
  const hasClockContext =
    context?.timeContext === true ||
    /(?:^|[\s,(])(?:время|начало)(?:\s+приема)?(?=$|[\s,.!?;)])/iu.test(
      normalizeDayOrdinals(text),
    ) ||
    new RegExp(dateCue, 'u').test(normalizeDayOrdinals(text));
  const result = [];
  for (const prefix of text.matchAll(/(?<![\p{L}\p{N}])на\s+/giu)) {
    const before = normalizeDayOrdinals(text.slice(Math.max(0, prefix.index - 80), prefix.index));
    if (hasDurationPrefix(before)) continue;
    const start = prefix.index + prefix[0].length;
    if (hasClockContext) {
      const clause = text
        .slice(start)
        .split(
          /(?:\s+(?:в|на|по|для|к|ко|у|завтра|послезавтра|сегодня)(?=$|\s))|[,!?;]|\.(?=$|\s)/u,
        )[0]
        .trimEnd();
      if (zeroClockParts(clause)) {
        result.push({ start: prefix.index, end: start + clause.length });
        continue;
      }
    }
    const match = new RegExp('^(\\d{1,2}|' + hourWord + ')' + edge, 'iu').exec(text.slice(start));
    if (!match) continue;
    const word = normalizeDayOrdinals(match[1]);
    const hour = word === 'час' ? 1 : spokenNumber(word, 99);
    if (hour === null) continue;
    let end = start + match[0].length;
    const rest = text.slice(end);
    if (/^[.,:]\d/u.test(rest)) continue;
    const unit = /^\s+час(?:а|ов)?(?=$|[\s,.!?;)])/u.exec(rest);
    if (unit) {
      // Keep even invalid numeric hours as clock evidence: parseTimeText rejects24+, not a length override.
      const after = rest.slice(unit[0].length);
      const compound = /^\s+(?:и\s+)?([\p{L}\d\s]{1,48}?)\s+минут(?:а|ы)?(?=$|[\s,.!?;)])/u.exec(
        after,
      );
      const compoundMinutes = compound && spokenNumber(compound[1].trim(), 59);
      const compoundMeridiem =
        compound &&
        /^\s+(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)(?=$|[\s,.!?;)])/u.test(
          after.slice(compound[0].length),
        );
      if (context.provenTimeWindow === true && compound && !compoundMeridiem) continue;
      const otherClock = new RegExp(
        '(?<![\\p{L}\\p{N}])(?:в|ко?)\\s*(?:\\d{1,2}(?:[:.,]\\d{1,2})?|' + hourWord + ')' + edge,
        'iu',
      ).test(text);
      if (
        hasClockContext &&
        hour <= 23 &&
        compoundMinutes !== null &&
        compound &&
        !otherClock &&
        !/^\s+(?:позже|позднее|раньше|ранее|вперед|назад)(?=$|[\s,.!?;)])/u.test(
          after.slice(compound[0].length),
        )
      ) {
        result.push({ start: prefix.index, end: end + unit[0].length + compound[0].length });
        continue;
      }
      // Compounds, fractions and relative offsets are lengths, not a whole clock hour.
      if (
        startsNumber(after) ||
        /^\s+(?:и|с)\s+(?:четверть|половин|\d)/u.test(after) ||
        /^\s+(?:позже|позднее|раньше|ранее|вперед|назад)(?=$|[\s,.!?])/u.test(after)
      )
        continue;
      // A separately stated exact start makes «в14:00 на два часа» a length.
      if (
        new RegExp(
          '(?<![\\p{L}\\p{N}])(?:в|ко?)\\s*(?:\\d{1,2}(?:[:.,]\\d{1,2})?|' + hourWord + ')' + edge,
          'iu',
        ).test(text)
      )
        continue;
      end += unit[0].length;
    } else {
      if (!hasClockContext || hour > 23) continue;
      if (
        new RegExp(
          '^\\s*(?:мин(?:ут(?:а|ы|у)?)?|числа|' + monthWord + ')(?=$|[\\s,.!?;)])',
          'u',
        ).test(rest) ||
        (word === 'час' && startsNumber(rest))
      )
        continue;
      if (
        word === 'час' &&
        new RegExp(
          '(?<![\\p{L}\\p{N}])(?:в|ко?)\\s*(?:\\d{1,2}(?:[:.,]\\d{1,2})?|' + hourWord + ')' + edge,
          'iu',
        ).test(text)
      )
        continue;
      const alternative =
        /^\s+(?:или|либо)\s+([^:,.!?;]{1,80}?)\s+мин(?:ут(?:а|ы|у)?)?(?=$|[\s,.!?;)])/u.exec(rest);
      if (
        alternative &&
        alternative[1].split(/\s+(?:или|либо)\s+/u).every((v) => spokenNumber(v, 100000) !== null)
      )
        continue;
    }
    result.push({ start: prefix.index, end });
  }
  return result;
}
function maskBareClockPhrases(value, context = {}) {
  const text = normalizeClockPrefixes(value),
    spans = bareClockSpans(text, context);
  let result = text;
  for (const span of spans.reverse())
    result =
      result.slice(0, span.start) + ' '.repeat(span.end - span.start) + result.slice(span.end);
  return result;
}
function maskWindowDurationPhrases(value) {
  const text = normalizeClockPrefixes(value),
    ordinary = bareClockSpans(text),
    bounded = bareClockSpans(text, { provenTimeWindow: true });
  let result = text;
  // A proven time window makes an independently stated hour/minute compound
  // a length. Mask only those complete compounds from the clock parser; a
  // simple «на двенадцать часов» remains a starting clock in either context.
  for (const span of ordinary.reverse())
    if (!bounded.some((clock) => clock.start === span.start && clock.end === span.end))
      result =
        result.slice(0, span.start) + ' '.repeat(span.end - span.start) + result.slice(span.end);
  return result;
}
module.exports = {
  dateCue,
  normalizeClockPrefixes,
  bareClockSpans,
  maskBareClockPhrases,
  maskWindowDurationPhrases,
  hasDurationPrefix,
};
