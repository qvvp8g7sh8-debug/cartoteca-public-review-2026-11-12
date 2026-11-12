const { spokenNumber } = require('./spoken-number.cjs');
const zeroPair = /^(?:ноль|нуль|0)[\s\p{Pd}]*(?:ноль|нуль|0)$/u;
const zeroClock = /^(.*?)\s*((?:ноль|нуль|0)[\s\p{Pd}]*(?:ноль|нуль|0))(?:\s+минут(?:а|ы)?)?$/u;
function clockMinute(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const text = value.normalize('NFKC').toLowerCase().trim();
  return zeroPair.test(text) ? 0 : spokenNumber(text, 59);
}
// Whole-clock ASR joins are accepted only with one valid hour and exactly two zeros.
// Dates, phone numbers and durations continue using the unchanged spokenNumber.
function zeroClockParts(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const text = value.normalize('NFKC').toLowerCase().trim();
  const match = zeroClock.exec(text);
  if (!match) return null;
  const heardHour = match[1].trim().replace(/\s+час(?:а|ов)?$/u, '');
  const hour = heardHour === 'час' ? 1 : spokenNumber(heardHour, 23);
  return hour === null ? null : { hour, minute: 0 };
}
module.exports = { clockMinute, zeroClockParts };
