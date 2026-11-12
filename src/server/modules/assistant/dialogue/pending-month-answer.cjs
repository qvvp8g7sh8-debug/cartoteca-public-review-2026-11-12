const { validProposal, monthDateOperation } = require('./bare-day-proposal.cjs');
const { parseTimeText } = require('../language/time/temporal.cjs');
const { parseBookingTimeWindow } = require('../language/time/booking-time-window.cjs');
const { spokenNumber } = require('../language/time/spoken-number.cjs');
function temporalTail(text) {
  let value = text.toLowerCase().replace(/ё/gu, 'е');
  const window = parseBookingTimeWindow(value);
  if (window.status === 'invalid') return false;
  if (window.status === 'valid') {
    value = window.maskedText.replace(/^[\s,;]+|[\s,;.!?]+$/gu, '').trim();
    if (!value) return true;
  }
  if (!/^[\p{L}\d\s:.,–—-]+$/u.test(value)) return false;
  if (
    ![...value.matchAll(/\p{L}+/gu)].every(
      ([word]) =>
        /^(?:и|в|во|на|с|до|утром|утра|днем|дня|вечером|вечера|ночью|ночи|час|часа|часов|минут|минуты|минута)$/u.test(
          word,
        ) || spokenNumber(word, 1440) !== null,
    )
  )
    return false;
  return !!parseTimeText(value);
}
// Only a whole month clause may complete the server-owned day. Other clauses
// remain in the original source for independent entity/action validation.
function pendingMonthAnswer(entry, raw, clock) {
  if (
    entry.availabilitySearch ||
    !validProposal(entry.data?.dateProposal) ||
    typeof raw !== 'string' ||
    raw.length > 160
  )
    return null;
  if (/(?:^|[\s,;])(?:нет|не|или|либо|если|вместо)(?=$|[\s,;])/iu.test(raw)) return null;
  const parts = raw.split(/\s*[,;]\s*|\s+и\s+/iu).filter(Boolean);
  // Speech recognition need not insert punctuation. Try only a whole month
  // prefix followed by a fully consumed temporal clause; raw stays untouched.
  const words = raw.trim().split(/\s+/u);
  const prefixes = [];
  for (let index = 1; index < words.length; index++) {
    const left = words.slice(0, index).join(' '),
      right = words.slice(index).join(' ');
    if (temporalTail(right)) prefixes.push(left);
    if (temporalTail(left)) prefixes.push(right);
  }
  const matches = [...(parts.length >= 2 && parts.length <= 3 ? parts : []), ...prefixes]
    .map((text) =>
      monthDateOperation({ step: 'date', data: entry.data, options: new Map() }, text, clock, {
        booking: true,
      }),
    )
    .filter(
      (value) => value?.kind === 'dateMonthPropose' && value.proposal.date && value.proposal.month,
    );
  const dates = new Map(matches.map(({ proposal }) => [proposal.date, proposal]));
  return dates.size === 1 ? [...dates.values()][0] : null;
}
module.exports = { pendingMonthAnswer };
