const { spokenNumber } = require('./spoken-number.cjs');
const MAX_RAW_MINUTES = 100000;
const valid = (minutes) =>
  Number.isSafeInteger(minutes) && minutes >= 5 && minutes <= 1440 && minutes % 5 === 0
    ? minutes
    : null;
function rawNumber(value, maximum) {
  const number = /^\d{1,6}$/.test(value) ? Number(value) : spokenNumber(value, maximum);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null;
}
function readDurationMinutes(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  const text = value
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.!?…]+$/u, '')
    .trim()
    .replace(/^пожалуйста(?:\s*,\s*|\s+)/u, '')
    .replace(/(?:\s*,\s*|\s+)пожалуйста$/u, '')
    .trim()
    .replace(/^на\s+/u, '')
    .replace(/\s+/gu, ' ');
  if (/^(?:полчаса|полчасика)$/.test(text)) return 30;
  if (/^(?:час|один час)$/.test(text)) return 60;
  if (/^полтора часа$/.test(text)) return 90;
  if (/^четверть часа$/.test(text)) return 15;
  if (/^три четверти часа$/.test(text)) return 45;
  const decimal = text.match(/^(\d{1,4})[.,](\d{1,4})\s*ч(?:ас(?:а|ов)?)?\.?$/u);
  if (decimal) {
    const scale = 10 ** decimal[2].length;
    const numerator = (Number(decimal[1]) * scale + Number(decimal[2])) * 60;
    const minutes = numerator / scale;
    return numerator % scale === 0 && minutes <= MAX_RAW_MINUTES ? minutes : null;
  }
  const compound =
    text.match(
      /^(?:(.+?)\s+)?час(?:а|ов)?(?:\s*,\s*|\s+(?:и\s+)?)(.+?)(?:\s+мин(?:ут(?:а|ы|у)?)?)?$/u,
    ) ||
    text.match(
      /^(\d{1,4})\s*ч(?:ас(?:а|ов)?)?\.?\s*(?:,|и(?=\s))?\s*(\d{1,2})(?:\s*мин(?:ут(?:а|ы|у)?)?)?$/u,
    );
  if (compound) {
    const hours = compound[1] ? rawNumber(compound[1], Math.floor(MAX_RAW_MINUTES / 60)) : 1;
    const minutes = rawNumber(compound[2], 59);
    if (hours === null || minutes === null) return null;
    const total = hours * 60 + minutes;
    return total <= MAX_RAW_MINUTES ? total : null;
  }
  const match = text.match(/^(.+?)\s*(мин(?:ут(?:а|ы|у)?)?\.?|ч(?:ас(?:а|ов)?)?\.?)?$/u);
  const number = match ? rawNumber(match[1], MAX_RAW_MINUTES) : null;
  if (number === null) return null;
  const minutes = number * (/^ч/.test(match[2] || '') ? 60 : 1);
  return minutes <= MAX_RAW_MINUTES ? minutes : null;
}
function parseDuration(value) {
  return valid(readDurationMinutes(value));
}
module.exports = { parseDuration, readDurationMinutes };
