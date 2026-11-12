const { ordinalOperation } = require('../../dialogue/dialogue-repair-choice.cjs');
const { detectRequestedOperation } = require('../../interpretation/requested-operation.cjs');
const { temporalPatch, temporalWordsOnly } = require('./appointment-management-entities.cjs');
const {
  managementRelativeProof,
  wholeManagementTemporalProof,
} = require('./appointment-management-temporal.cjs');
const { managementTargetOperation } = require('./appointment-management-target-input.cjs');
function choiceTargetOperation(entry, raw, clock) {
  if (
    entry.data.management.operation === 'cancel' ||
    ![...entry.options.values()].some((row) => row.kind === 'appointmentSource')
  )
    return null;
  const request = detectRequestedOperation(raw);
  if (request.negated || request.ambiguous) return null;
  let text = raw;
  if (request.intent) {
    if (request.intent !== 'moveAppointment' || request.operation.start !== 0) return null;
    text = raw.slice(request.operation.end);
  }
  const words = text.toLowerCase().replace(/ё/gu, 'е').trim().split(/\s+/u);
  for (let split = 1; split < Math.min(words.length, 5); split++) {
    const selection = words
      .slice(0, split)
      .join(' ')
      .replace(/[,;]+$/u, '')
      .replace(/\s+запись$/u, '');
    let parsed;
    try {
      parsed = ordinalOperation(entry, selection);
    } catch (error) {
      if (error.status !== 400) throw error;
      continue;
    }
    if (parsed?.kind !== 'choice' || entry.options.get(parsed.choice)?.kind !== 'appointmentSource')
      continue;
    const tail = words
      .slice(split)
      .join(' ')
      .replace(/^[,;]+\s*/u, '');
    if (!temporalWordsOnly(tail)) continue;
    const relative = managementRelativeProof({}, tail, clock);
    if (relative.keepTime || relative.relativeTarget)
      return { kind: 'sourceTarget', choice: parsed.choice, relative };
    const m = entry.data.management;
    const constraints = wholeManagementTemporalProof(
      tail,
      clock,
      m.targetDate || m.initialDate || m.dateMonthContext,
    );
    if (constraints)
      return {
        kind: 'sourceTarget',
        choice: parsed.choice,
        target: { kind: 'targetConstraints', constraints },
      };
    const patch = temporalPatch(tail, clock);
    if (patch)
      return {
        kind: 'sourceTarget',
        choice: parsed.choice,
        target: { kind: 'targetPatch', edits: patch.edits },
      };
    const target = managementTargetOperation(entry, 'Перенеси запись ' + tail, clock, false);
    if (target?.kind === 'targetPatch')
      return { kind: 'sourceTarget', choice: parsed.choice, target };
  }
  return null;
}
module.exports = { choiceTargetOperation };
