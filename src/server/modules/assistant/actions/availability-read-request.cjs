const { validDate } = require('../interpretation/intent-schema.cjs');
const { parseDateText } = require('../language/time/temporal.cjs');
const { parseDuration } = require('../language/time/spoken-duration.cjs');
const civilDay =
  '(сегодня|завтра|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.\\d{1,2}\\.\\d{4}|\\d{1,2}/\\d{1,2}/\\d{4})';
const command = new RegExp(
  '^(?:(?:пожалуйста[,\\s]+|можешь\\s+))*(?:найди(?:те)?|покажи(?:те)?)\\s+(?:мне\\s+)?' +
    'свободн(?:ое\\s+(?:окно|время)|ые\\s+окна)\\s+(?:на\\s+)?' +
    civilDay +
    '\\s+на\\s+(.+)$',
  'u',
);
const durationUnit =
  /(?:^|[^\p{L}])(?:мин(?:ут(?:а|ы|у)?)?|ч(?:ас(?:а|ов)?)?|полчаса|полчасика)(?!\p{L})/u;

function availabilityReadParts(raw) {
  if (typeof raw !== 'string' || raw.length > 4000) return null;
  const text = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim();
  const match = command.exec(text);
  if (!match || !durationUnit.test(match[2])) return null;
  const duration = parseDuration(match[2]);
  if (duration === null) return null;
  const day = match[1];
  if (day === 'сегодня' || day === 'завтра') return { day, duration };
  const numeric = day.split(/[./]/u);
  const date =
    numeric.length === 3
      ? numeric[2] + '-' + numeric[1].padStart(2, '0') + '-' + numeric[0].padStart(2, '0')
      : day;
  return validDate(date) ? { day: date, duration } : null;
}
function availabilityReadIntent(raw, clock) {
  if (!validDate(clock?.date)) return null;
  const parts = availabilityReadParts(raw);
  if (!parts) return null;
  const date = validDate(parts.day) ? parts.day : parseDateText(parts.day, clock);
  // Unknown modifiers and omitted fields retain the existing model/default semantics.
  return date ? { intent: 'availability', date, endDate: date, duration: parts.duration } : null;
}
module.exports = { availabilityReadIntent, availabilityReadParts };
