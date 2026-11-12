const { validDate } = require('../../interpretation/intent-schema.cjs');
const weekdayForms = [
  'понедельник(?:а|у|ом|е)?',
  'вторник(?:а|у|ом|е)?',
  'сред(?:а|у|ы|е|ой|ою)',
  'четверг(?:а|у|ом|е)?',
  'пятниц(?:а|у|ы|е|ей|ею)',
  'суббот(?:а|у|ы|е|ой|ою)',
  'воскресень(?:е|я|ю|ем|и)',
];
const weekdayWord = '(?:' + weekdayForms.join('|') + ')';
const weekdayMention = new RegExp(
  '(?:^|[^\\p{L}\\p{N}])(?:(этот|эта|эту|это|этой)\\s+)?' + weekdayWord + '(?![\\p{L}\\p{N}])',
  'u',
);
function unqualifiedWeekday(text) {
  const match = weekdayMention.exec(text);
  return Boolean(match && !match[1]);
}
const nextWord = 'следующ(?:ий|ая|ую|ее|ей|ем|ему|его)';
const nextWeekdayPhrase =
  '(?:' +
  nextWord +
  '\\s+' +
  weekdayWord +
  '|' +
  weekdayWord +
  '\\s+' +
  nextWord +
  '(?!\\s+недел))';
const qualified = '(?<![\\p{L}\\p{N}])' + nextWeekdayPhrase + '(?![\\p{L}\\p{N}])';
function normalizeNextWeekdays(value) {
  // Split only a complete finite weekday phrase, never arbitrary joined words.
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(
      new RegExp(
        '(?<![\\p{L}\\p{N}])(?:(во|на|ко|в|к)\\s*)?(' +
          nextWord +
          ')\\s*(' +
          weekdayWord +
          ')(?![\\p{L}\\p{N}])',
        'gu',
      ),
      (_, prefix, next, weekday) => (prefix ? prefix + ' ' : '') + next + ' ' + weekday,
    );
}
function unsupportedRelativeDate(value) {
  const text = normalizeNextWeekdays(value).replace(new RegExp(qualified, 'gu'), ' ');
  return /следующ|прошл|предыдущ/u.test(text);
}
function nextWeekdayDate(value, today) {
  const text = normalizeNextWeekdays(value);
  const phrases = [...text.matchAll(new RegExp(qualified, 'gu'))];
  if (!phrases.length) return undefined;
  if (phrases.length !== 1 || !validDate(today)) return null;
  const weekday = weekdayForms.findIndex((form) =>
    new RegExp('(?<![\\p{L}\\p{N}])' + form + '(?![\\p{L}\\p{N}])', 'u').test(phrases[0][0]),
  );
  const stamp = Date.parse(today + 'T00:00:00Z');
  const current = (new Date(stamp).getUTCDay() + 6) % 7;
  const days = (weekday - current + 7) % 7 || 7;
  const iso = new Date(stamp + days * 86400000).toISOString();
  const date = iso.slice(0, 10);
  return validDate(date) ? date : null;
}
function wholeNextWeekday(value) {
  return new RegExp('^(?:(?:в|во|на|к|ко)\\s+)?' + nextWeekdayPhrase + '$', 'u').test(
    normalizeNextWeekdays(value),
  );
}
module.exports = {
  nextWeekdayPhrase,
  unqualifiedWeekday,
  normalizeNextWeekdays,
  unsupportedRelativeDate,
  nextWeekdayDate,
  wholeNextWeekday,
};
