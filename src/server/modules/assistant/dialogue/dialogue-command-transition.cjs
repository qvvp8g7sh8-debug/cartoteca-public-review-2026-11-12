const { detectRequestedOperation } = require('../interpretation/requested-operation.cjs');
const {
  localManagementIntent,
} = require('../actions/appointments/appointment-management-intent.cjs');
const { calendarReadIntent } = require('../actions/calendar-read-request.cjs');
const management = new Set(['moveAppointment', 'cancelAppointment', 'editAppointment']);
function canTransition(entry, text) {
  return (
    entry &&
    !entry.complete &&
    !entry.cancelled &&
    !entry.executionSaved &&
    typeof text === 'string'
  );
}
// This is only a clock-free filter. Actual command validation still runs with
// the organization clock when the answer might replace the draft.
function needsTransitionClock(entry, text) {
  if (!canTransition(entry, text)) return false;
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim();
  const normalizedRequest = detectRequestedOperation(normalized);
  if (normalizedRequest.intent === 'calendar') return true;
  const requested = normalized === text ? normalizedRequest : detectRequestedOperation(text);
  return !requested.negated && !requested.ambiguous && management.has(requested.intent);
}
// A new explicit command may replace a draft. A field correction, a bare
// "cancel" and the current management operation continue the owned dialogue.
function managementCommandTransition(entry, text, clock) {
  if (!canTransition(entry, text)) return false;
  if (calendarReadIntent(text, clock)?.intent === 'calendar') return true;
  const requested = detectRequestedOperation(text);
  if (requested.negated || requested.ambiguous || !management.has(requested.intent)) return false;
  const operation = text.slice(requested.operation.start, requested.operation.end);
  if (!/(?:^|\s)(?:запись|записи|при[её]м|при[её]ма)(?=$|[\s,.!?;:])/iu.test(operation))
    return false;
  const literal = localManagementIntent(text, clock);
  if (!literal) return false;
  if (entry.data.target === 'appointmentManagement') {
    const current = entry.data.management?.operation;
    if (
      requested.intent ===
        { move: 'moveAppointment', cancel: 'cancelAppointment', edit: 'editAppointment' }[
          current
        ] &&
      !literal.query
    )
      return false;
  }
  return true;
}
module.exports = { managementCommandTransition, needsTransitionClock };
