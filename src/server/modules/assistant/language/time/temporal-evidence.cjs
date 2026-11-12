// Resolve a small relative grammar from a known draft or the organization date, never model values.
const { validDate } = require('../../interpretation/intent-schema.cjs');
const { shiftDate, parseDateText } = require('./temporal.cjs');
const { parseDuration } = require('./spoken-duration.cjs');
const { spokenNumber } = require('./spoken-number.cjs');
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const unsafe =
  /(?<![\p{L}\p{N}])(?:не|нет|или|либо|если|примерно|около|между|кроме|исключая|приблизительно)(?![\p{L}\p{N}])/u;
function relativeTemporalEvidence(raw, currentData, clock) {
  if (
    typeof raw !== 'string' ||
    !raw.trim() ||
    raw.length > 160 ||
    /\u0000/u.test(raw) ||
    !validDate(clock?.date)
  )
    return {};
  let text = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .trim()
    .replace(/^пожалуйста(?:\s*,\s*|\s+)/u, '')
    .replace(/(?:\s*,\s*|\s+)пожалуйста$/u, '')
    .trim()
    .replace(/(^|\s)(на|через)(?=\d)/gu, '$1$2 ');
  if (unsafe.test(text) || /\d\s*[-–—]\s*\d/u.test(text)) return {};
  text = text.replace(/^(?:перенеси|перенести|сдвинь|сдвинуть|передвинь|передвинуть)\s+/u, '');
  const named = /^(время|дату|дата|запись)\s+/u.exec(text);
  const field = named ? (named[1] === 'время' ? 'time' : /^дат/u.test(named[1]) ? 'date' : '') : '';
  if (named) text = text.slice(named[0].length);
  const draftDate =
    validDate(currentData?.date) && currentData.date >= clock.date ? currentData.date : null;
  const dateAfter = (basis, days) => {
    if (!basis || !Number.isInteger(days) || !days || Math.abs(days) > 31 || field === 'time')
      return {};
    const value = shiftDate(basis, days);
    return validDate(value) && value >= clock.date ? { date: value } : {};
  };
  const day = /^(?:на\s+)?(?:следующий|следующую|предыдущий|предыдущую)\s+(?:день|дату)$/u.exec(
    text,
  );
  if (day) return dateAfter(draftDate, /предыдущ/u.test(text) ? -1 : 1);
  if (/^(?:днем|сутками)\s+(?:позже|позднее|раньше|ранее)$/u.test(text))
    return dateAfter(draftDate, /ран/u.test(text) ? -1 : 1);
  const relativeDay =
    /^(?:на\s+)?(?:(.+?)\s*)?(?:день|дня|дней)\s+(позже|позднее|раньше|ранее)$/u.exec(text);
  if (relativeDay) {
    const count = relativeDay[1] ? spokenNumber(relativeDay[1].trim(), 31) : 1;
    return dateAfter(draftDate, count * (/ран/u.test(relativeDay[2]) ? -1 : 1));
  }
  const afterDays = /^через\s+(?:(.+?)\s*)?(?:день|дня|дней)$/u.exec(text);
  const afterWeek = /^через\s+(?:(.+?)\s+)?неделю$/u.exec(text);
  if (afterDays || afterWeek) {
    if (field === 'time') return {};
    const parsed = afterDays || afterWeek;
    const count = parsed[1] ? spokenNumber(parsed[1].trim(), 31) : 1;
    const days = count * (afterWeek ? 7 : 1);
    if (!Number.isInteger(days) || days < 1 || days > 31) return {};
    const date = parseDateText('через ' + days + ' дней', clock);
    return validDate(date) && date >= clock.date ? { date } : {};
  }
  const relativeTime = /^(?:на\s+)?(.{1,80}?)\s+(позже|позднее|раньше|ранее)$/u.exec(text);
  if (
    !relativeTime ||
    field === 'date' ||
    !draftDate ||
    !clockPattern.test(currentData?.time || '') ||
    !/(?:мин|час|четверть)/u.test(relativeTime[1])
  )
    return {};
  const delta = parseDuration(relativeTime[1]);
  if (!delta) return {};
  const start = Number(currentData.time.slice(0, 2)) * 60 + Number(currentData.time.slice(3));
  const total = start + delta * (/ран/u.test(relativeTime[2]) ? -1 : 1);
  if (total < 0 || total >= 1440) return {};
  return {
    time:
      String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0'),
  };
}
module.exports = { relativeTemporalEvidence };
