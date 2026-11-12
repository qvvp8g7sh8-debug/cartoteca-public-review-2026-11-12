const {
  parseBookingTimeWindow,
  windowBounds,
} = require('../../language/time/booking-time-window.cjs');
const {
  bookingTemporalConstraints,
} = require('../../language/time/booking-temporal-constraints.cjs');
const { repairOperation } = require('../../dialogue/dialogue-repair-parse.cjs');
const { dayEvidence, validProposal } = require('../../dialogue/bare-day-proposal.cjs');
const { nearestSlotMode, isSlotRequest } = require('../slot-request.cjs');
const {
  managementRelativeProof,
  wholeManagementTemporalProof,
} = require('./appointment-management-temporal.cjs');
const { parseSpokenTime } = require('../../language/time/spoken-time.cjs');
const { parseTimeText } = require('../../language/time/temporal.cjs');
const { detectRequestedOperation } = require('../../interpretation/requested-operation.cjs');
function wholeDayClock(text, proof) {
  if (!validProposal(proof.dateProposal)) return null;
  const clocks = new Set();
  const words = text.trim().split(/\s+/u);
  const clean = (part) => part.replace(/^[,\s]+|[,\s.!?…]+$/gu, '');
  for (let index = 1; index < words.length; index++) {
    const left = clean(words.slice(0, index).join(' ')),
      right = clean(words.slice(index).join(' '));
    for (const [day, clock] of [
      [left, right],
      [right, left],
    ]) {
      const evidence = dayEvidence(day, { dateStep: true });
      if (!evidence?.whole || evidence.day !== proof.dateProposal.day) continue;
      const value = clock.toLowerCase().replace(/ё/gu, 'е');
      const time =
        parseSpokenTime(value) ||
        (/^(?:(?:в|на|ко?)\s+)?\d{1,2}[:.]\d{2}$/u.test(value) ? parseTimeText(value) : null);
      if (time && (!proof.time || time === proof.time)) clocks.add(time);
    }
  }
  return clocks.size === 1 ? [...clocks][0] : null;
}
function managementTargetOperation(entry, raw, clock, hasSource) {
  if (entry.data.management.operation === 'cancel') return null;
  const request = detectRequestedOperation(raw);
  const explicit =
    request.intent === 'moveAppointment' &&
    !request.negated &&
    !request.ambiguous &&
    request.operation?.start === 0 &&
    Boolean(raw.slice(request.operation.end).trim());
  const text = (explicit ? raw.slice(request.operation.end) : raw).trim();
  const window = parseBookingTimeWindow(text);
  // Leave ordinary source-date and ordinal answers with their existing parser.
  if (!explicit && window.status === 'none') return null;
  if (explicit && !hasSource) {
    const relative = managementRelativeProof({ query: '' }, text, clock);
    if (relative.relativeTarget || relative.keepTime)
      return { kind: 'targetRelative', ...relative };
  }
  if (explicit && window.status !== 'valid') {
    const m = entry.data.management;
    const constraints = wholeManagementTemporalProof(
      text,
      clock,
      m.targetDate || m.initialDate || m.dateMonthContext,
    );
    if (constraints && !constraints.relativeTarget && !constraints.keepTime)
      return { kind: 'targetConstraints', constraints };
  }
  if (hasSource && window.status === 'none') return null;
  const masked = window.maskedText.trim().replace(/^[,\s]+|[,\s.!?…]+$/gu, '');
  const slots = isSlotRequest(masked);
  const parsed = masked ? repairOperation({ ...entry, step: 'time' }, masked, clock) : null;
  const proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, text, clock);
  const combined = wholeDayClock(masked, proof);
  const proposal =
    (dayEvidence(masked)?.whole || combined) && validProposal(proof.dateProposal)
      ? proof.dateProposal
      : null;
  if (
    window.status === 'invalid' ||
    (masked &&
      !slots &&
      !proposal &&
      (parsed?.kind !== 'patch' ||
        parsed.edits.some((row) => !['date', 'time'].includes(row.field))))
  )
    return explicit || window.status !== 'none'
      ? { kind: 'managementHelp', text: 'Уточните новую дату, время или период переноса.' }
      : null;
  return {
    kind: 'targetPatch',
    edits: combined ? [{ field: 'time', text: combined }] : parsed?.edits || [],
    ...(proposal ? { proposal } : {}),
    ...(window.status === 'valid' && windowBounds(window.window) ? { window: window.window } : {}),
    seekSlots:
      slots ||
      parsed?.seekSlots === true ||
      (window.status === 'valid' && !parsed?.edits?.some((row) => row.field === 'time')),
    nearest: nearestSlotMode(text),
  };
}
module.exports = { managementTargetOperation };
