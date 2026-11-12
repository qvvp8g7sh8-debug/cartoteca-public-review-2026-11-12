const { inheritMonthContext } = require('../../dialogue/bare-day-proposal.cjs');
// Only an explicit rejected clause plus a positive replacement can narrow temporal proof.
// The caller retains the original utterance for entity/source validation.
function temporalCorrectionScope(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 4000) return null;
  const text = raw.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
  if (
    text.includes('?') ||
    /(?:^|[\s,;(])(?:если|или|либо|примерно|около|между|приблизительно|при\s+условии|в\s+случае)(?=$|[\s,;:.)!?])/u.test(
      text,
    )
  )
    return null;
  const negatives = [...text.matchAll(/(?:^|[\s,;(])(?:не|нет)(?=$|[\s,;:.)!?])/gu)];
  if (negatives.length !== 1) return null;
  const marker = negatives[0],
    start = marker.index + marker[0].search(/\S/u);
  if (!/^не\s+/u.test(text.slice(start))) return null;
  const oldStart = start + /^не\s+/u.exec(text.slice(start))[0].length;
  const tail = text.slice(oldStart),
    connector = /(?:,\s*|\s+)а\s+/u.exec(tail);
  if (!connector) return null;
  const rejected = tail.slice(0, connector.index).trim();
  const afterStart = oldStart + connector.index + connector[0].length;
  const after = text.slice(afterStart).trim();
  if (
    !rejected ||
    rejected.length > 160 ||
    /[,;!?]/u.test(rejected) ||
    !/[\p{L}\p{N}]/u.test(after) ||
    /^(?:надо|нужно|хочу|следует|буду|будем|только|столько|совсем|записывай|записывайте|делай|делайте|отменяй|отменяйте)(?=$|[\s,.!?])/u.test(
      rejected,
    )
  )
    return null;
  return { before: text.slice(0, start), rejected, after, start, end: afterStart };
}
function mergeTemporalCorrection(before, rejected, after) {
  after = inheritMonthContext(after, before.date || rejected.date);
  const reset = {};
  for (const field of ['date', 'time']) if (Object.hasOwn(rejected, field)) reset[field] = null;
  if (Object.hasOwn(rejected, 'duration') || rejected.requireDuration) {
    reset.duration = null;
    reset.requireDuration = true;
  }
  if (Object.hasOwn(rejected, 'timeWindow') || rejected.timeWindowRequired) {
    reset.time = null;
    reset.timeWindow = null;
    reset.timeWindowRequired = true;
  }
  const result = { ...before, ...reset, ...after };
  if (Object.hasOwn(after, 'date') || Object.hasOwn(reset, 'date'))
    for (const field of ['dateProposal', 'dateWeekday']) if (!after[field]) delete result[field];
  if (after.duration != null && !after.requireDuration) delete result.requireDuration;
  if ((after.time || after.timeWindow) && !after.timeWindowRequired)
    delete result.timeWindowRequired;
  return result;
}
module.exports = { temporalCorrectionScope, mergeTemporalCorrection };
