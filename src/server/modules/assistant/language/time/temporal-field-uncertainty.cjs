const { monthWord: month } = require('./spoken-day.cjs');
const { spokenNumber } = require('./spoken-number.cjs');
const { parseSpokenTime } = require('./spoken-time.cjs');
const { readDurationMinutes } = require('./spoken-duration.cjs');
const part = '(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)';
const uncertain =
  /(?:^|[\s,;(])(?:не|нет|или|либо|примерно|около|между|приблизительно|точнее|точней|вернее|исправляю|поправка|лучше|вместо|кроме|исключая)(?=$|[\s,;:.)!?])/u;
function fieldUncertainty(text) {
  const ambiguous = uncertain.test(text);
  const fallback = { date: ambiguous, time: ambiguous, dateText: text };
  if (!ambiguous || /(?:^|[\s,;(])(?:если|при\s+условии|в\s+случае)(?=$|[\s,;:.)!?])/u.test(text))
    return fallback;
  const markers = [...text.matchAll(new RegExp(uncertain.source, 'gu'))].map((match) => ({
    start: match.index + match[0].search(/\S/u),
    end: match.index + match[0].length,
  }));
  const covered = new Set(),
    fields = new Set();
  const edge = '(?=$|[\\s,.!?;)])';
  const clauseEnd =
    '(?=$|[,.!?;)]|\\s+(?:в|на|по|для|к|ко|у|завтра|послезавтра|сегодня)(?=$|[\\s,.!?]))';
  const approximate = '(?:примерно|около|приблизительно)';
  const alternative = '(?:или|либо)';
  const clock = '\\d{1,2}:\\d{2}(?!\\d|[:.]\\d)(?:\\s+' + part + ')?';
  const namedDay = '\\d{1,2}\\s+' + month + '(?:\\s+\\d{4}(?:\\s+года?)?)?';
  const day =
    '(?:послезавтра|завтра|позавчера|вчера|сегодня|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4}|' +
    namedDay +
    ')';
  function mark(expression, field, accepts = () => true, overlap = false) {
    const pattern = '(?<![\\p{L}\\p{N}])' + expression + edge;
    for (const match of text.matchAll(
      new RegExp(overlap ? '(?=(?<scope>' + pattern + '))' : pattern, 'gu'),
    )) {
      if (!accepts(match)) continue;
      const span = match.groups?.scope || match[0];
      const inside = markers
        .map((marker, index) =>
          marker.start >= match.index && marker.end <= match.index + span.length ? index : -1,
        )
        .filter((index) => index >= 0);
      if (!inside.length) continue;
      inside.forEach((index) => covered.add(index));
      fields.add(field);
    }
  }
  mark(approximate + '\\s+(?:(?:в|на)\\s+)?' + clock, 'time');
  mark(
    approximate + '\\s+(?<spoken>(?:в|на)\\s+[^:,.!?;]{1,100}?)' + clauseEnd,
    'time',
    (match) => parseSpokenTime(match.groups.spoken.trim()) !== null,
  );
  mark(
    '(?:(?:в|на)\\s+)?' +
      clock +
      '(?:\\s+' +
      alternative +
      '\\s+(?:(?:в|на)\\s+)?' +
      clock +
      '){1,3}',
    'time',
  );
  mark(
    '(?<clocks>(?:в|на|ко?)\\s+[^.!?;]{1,100}?(?:\\s+' +
      alternative +
      '\\s+(?:(?:в|на|ко?)\\s+)?[^.!?;]{1,100}?){1,3})' +
      clauseEnd,
    'time',
    (match) => {
      const variants = match.groups.clocks.split(new RegExp('\\s+' + alternative + '\\s+', 'u'));
      // A complete duration choice headed by «на» is not a second clock choice.
      if (
        /^на\s+/u.test(variants[0].trim()) &&
        variants.every(
          (value) =>
            /(?:час|мин|(?:^|\d)ч(?:\d|$))/u.test(value) &&
            readDurationMinutes(value.trim().replace(/^на\s+/u, '')) !== null,
        )
      )
        return false;
      return (
        variants.length >= 2 &&
        variants.length <= 4 &&
        variants.every((value) => {
          const text = value.trim();
          if (parseSpokenTime(text) !== null) return true;
          return /^(?:(?:в|на|ко?)\s+)?(?:[01]?\d|2[0-3]):[0-5]\d$/u.test(text);
        })
      );
    },
    true,
  );
  mark(approximate + '\\s+(?:(?:на|в)\\s+)?' + day, 'date');
  mark(day + '(?:\\s+' + alternative + '\\s+(?:на\\s+)?' + day + '){1,3}', 'date');
  mark('\\d{1,2}\\s+' + alternative + '\\s+' + namedDay, 'date');
  mark(
    '(?:на|по|длительностью|продолжительностью)\\s+(?<duration>[^:,.!?;]{1,100}?)\\s+мин(?:ут(?:а|ы|у)?)?',
    'duration',
    (match) => {
      if (
        /^\s+(?:позже|позднее|раньше|ранее|вперед|назад)(?=$|[\s,.!?])/u.test(
          text.slice(match.index + match[0].length),
        )
      )
        return false;
      const value = match.groups.duration.replace(new RegExp('^' + approximate + '\\s+', 'u'), '');
      return value
        .split(new RegExp('\\s+' + alternative + '\\s+', 'u'))
        .every((count) => /^\d{1,6}$/u.test(count) || spokenNumber(count, 100000) !== null);
    },
  );
  mark(
    '(?:на|по|длительностью|продолжительностью)\\s+(?<compound>[^:,.!?;]{1,160}?)' + clauseEnd,
    'duration',
    (match) => {
      const variants = match.groups.compound.split(new RegExp('\\s+' + alternative + '\\s+', 'u'));
      return (
        variants.length > 1 &&
        variants.length <= 4 &&
        variants.every((value) => readDurationMinutes(value.trim()) !== null)
      );
    },
  );
  // Unknown alternatives, negations and qualifiers keep the original conservative guard.
  if (covered.size !== markers.length) return fallback;
  return {
    date: fields.has('date'),
    time: fields.has('time'),
    dateText: text.replace(new RegExp(uncertain.source, 'gu'), (value) => ' '.repeat(value.length)),
  };
}
module.exports = { fieldUncertainty };
