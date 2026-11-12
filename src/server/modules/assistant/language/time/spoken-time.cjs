const { normalizeClockPrefixes } = require('./clock-context.cjs');
const { spokenNumber } = require('./spoken-number.cjs');
const { clockMinute, zeroClockParts } = require('./clock-minute.cjs');
const ordinals = {
  первого: 1,
  второго: 2,
  третьего: 3,
  четвертого: 4,
  пятого: 5,
  шестого: 6,
  седьмого: 7,
  восьмого: 8,
  девятого: 9,
  десятого: 10,
  одиннадцатого: 11,
  двенадцатого: 12,
};
const readHour = (value) => (value === 'час' ? 1 : spokenNumber(value, 23));
function hourOfDay(hour, part, defaultDay = false) {
  if (hour === null || hour > 23) return null;
  if (!part)
    return defaultDay
      ? hour >= 1 && hour <= 6
        ? hour + 12
        : hour
      : hour === 0 || hour >= 13
        ? hour
        : null;
  if (hour > 12) return null;
  if (/^(дн|веч)/u.test(part)) return hour < 12 ? hour + 12 : hour;
  if (/^ноч/u.test(part) && hour === 12) return 0;
  return hour;
}
function parseSpokenTime(value) {
  let text = normalizeClockPrefixes(value)
    .trim()
    .replace(/[.!?]+$/u, '')
    .replace(/^(?:в|на|ко?)\s+/u, '');
  const partMatch = text.match(/\s+(утра|утром|дня|днем|вечера|вечером|ночи|ночью)$/u);
  const part = partMatch?.[1] || '';
  if (partMatch) text = text.slice(0, partMatch.index).trim();
  const format = (minutes) => {
    const total = (minutes + 1440) % 1440;
    return (
      String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
    );
  };
  const zeros = zeroClockParts(text);
  if (zeros) {
    const hour = hourOfDay(zeros.hour, part, true);
    return hour === null ? null : format(hour * 60);
  }
  // ASR may separate hours and minutes with commas; accept only one clock or one exact repeat.
  const comma = text.match(
    /^([01]?\d|2[0-3])\s*,\s*([0-5]?\d)(?:\s*,\s*([01]?\d|2[0-3])\s*,\s*([0-5]?\d))?$/u,
  );
  if (comma) {
    if (
      comma[3] !== undefined &&
      (Number(comma[1]) !== Number(comma[3]) || Number(comma[2]) !== Number(comma[4]))
    )
      return null;
    const hour = hourOfDay(Number(comma[1]), part, true);
    return hour === null ? null : format(hour * 60 + Number(comma[2]));
  }
  const numeric = text.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/u);
  if (part && numeric) {
    const hour = hourOfDay(Number(numeric[1]), part);
    return hour === null ? null : format(hour * 60 + Number(numeric[2]));
  }
  const fraction = text.match(/^(пол(?:овин[аеуы])?\s*|четверть\s+)([а-я]+)$/u);
  if (fraction) {
    const hour = hourOfDay(ordinals[fraction[2]] ?? null, part, true);
    return hour === null
      ? null
      : format(hour * 60 - 60 + (fraction[1].startsWith('четверть') ? 15 : 30));
  }
  const before = text.match(/^без\s+(четверти|пяти|десяти|пятнадцати|двадцати)\s+(.+)$/u);
  if (before) {
    const hour = hourOfDay(readHour(before[2]), part, true);
    const minutes = { четверти: 15, пяти: 5, десяти: 10, пятнадцати: 15, двадцати: 20 }[before[1]];
    return hour === null ? null : format(hour * 60 - minutes);
  }
  let hour,
    minute = 0;
  const oneHour = text.match(/^час(?:\s+(?:и\s+)?(.+?)(?:\s+минут(?:а|ы)?)?)?$/u);
  const labelled = text.match(/^(.+?)\s+час(?:а|ов)?(?:\s+(.+?)(?:\s+минут(?:а|ы)?)?)?$/u);
  if (oneHour) {
    hour = 1;
    minute = oneHour[1] === undefined ? 0 : clockMinute(oneHour[1]);
  } else if (labelled) {
    hour = spokenNumber(labelled[1], 23);
    minute = labelled[2] === undefined ? 0 : clockMinute(labelled[2].replace(/^и\s+/u, ''));
  } else {
    const whole = text === 'час' ? 1 : spokenNumber(text);
    if (whole !== null) hour = whole;
    else {
      const minuteLabel = /\s+минут(?:а|ы)?$/u.test(text);
      const words = text.replace(/\s+минут(?:а|ы)?$/u, '').split(/\s+/),
        candidates = [];
      for (let at = 1; at < words.length; at++) {
        const h = spokenNumber(words.slice(0, at).join(' '), 23);
        const minuteText = words.slice(at).join(' ');
        const m = clockMinute(minuteText);
        // Two bare small numbers can be alternative hours, not an implicit 03 minutes.
        const explicitMinute = minuteLabel || /^(?:ноль|нуль|0\d)(?=$|\s)/u.test(minuteText);
        if (h !== null && m !== null && (m === 0 || m >= 10 || explicitMinute))
          candidates.push([h, m]);
      }
      if (candidates.length !== 1) return null;
      [hour, minute] = candidates[0];
    }
  }
  hour = hourOfDay(hour ?? null, part, true);
  return hour === null || minute === null ? null : format(hour * 60 + minute);
}
module.exports = { parseSpokenTime };
