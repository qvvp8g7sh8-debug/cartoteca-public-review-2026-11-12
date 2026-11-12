const { detectRequestedOperation } = require('../../interpretation/requested-operation.cjs');
const { isSlotRequest } = require('../../actions/slot-request.cjs');
function appointmentSlotClause(raw) {
  const text = String(raw || ''),
    request = detectRequestedOperation(text);
  if (
    request.negated ||
    request.ambiguous ||
    !['prepareAppointment', 'moveAppointment'].includes(request.intent)
  )
    return null;
  for (const split of text.matchAll(/[.!?;,]\s*|\s+и\s+/giu)) {
    const head = text.slice(0, split.index).trim(),
      tail = text.slice(split.index + split[0].length).trim();
    if (!isSlotRequest(tail)) continue;
    const prior = detectRequestedOperation(head);
    if (prior.intent === request.intent && !prior.negated && !prior.ambiguous)
      return { head, tail, slotStart: split.index };
  }
  return null;
}
module.exports = { appointmentSlotClause };
