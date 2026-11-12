const { readSteps } = require('../../read-steps.cjs');
const {
  localManagementIntent,
  prepareManagementIntent,
} = require('./appointment-management-intent.cjs');
const { managementClientContext } = require('./appointment-management-scope.cjs');
const { resolveClient } = require('../../language/names/name-directory.cjs');
const { clientChoiceMetadata } = require('../../dialogue/client-choice-names.cjs');
const { detectRequestedOperation } = require('../../interpretation/requested-operation.cjs');
const { literalSpan } = require('../../interpretation/entity-provenance.cjs');
const { isSlotRequest } = require('../slot-request.cjs');
// Repeated names may continue only a uniquely resolved, unchanged identity.
// A different or ambiguous person still takes the existing new-command path.
function managementCommandReply(c, entry, raw, clock) {
  return readSteps(function* () {
    if (
      typeof raw !== 'string' ||
      raw.length > 160 ||
      entry?.complete ||
      entry?.cancelled ||
      entry?.executionSaved ||
      entry?.data.target !== 'appointmentManagement' ||
      !entry.data.patient?.id
    )
      return null;
    let intent = localManagementIntent(raw, clock);
    if (!intent) {
      const words = raw.trim().split(/\s+/u);
      for (let index = 1; index < words.length; index++) {
        if (!isSlotRequest(words.slice(index).join(' '))) continue;
        intent = localManagementIntent(words.slice(0, index).join(' '), clock);
        if (intent) break;
      }
    }
    const operation = {
      move: 'moveAppointment',
      edit: 'editAppointment',
      cancel: 'cancelAppointment',
    }[entry.data.management?.operation];
    if (!intent?.query || intent.intent !== operation) return null;
    const found = yield resolveClient(yield managementClientContext(c), intent.query);
    if (found.overflow || found.matches.length !== 1) return null;
    const patient = found.matches[0];
    if (
      patient.id !== entry.data.patient.id ||
      clientChoiceMetadata(patient).clientNameStamp !== entry.data.patient.clientNameStamp
    )
      return null;
    const requested = detectRequestedOperation(raw);
    const source = requested.sourceWithoutCommand;
    const span = literalSpan(source, intent.query);
    if (!span) return null;
    return {
      ...(intent.serviceQuery || intent.staffQuery
        ? { sourceRequest: prepareManagementIntent(intent, raw, clock) }
        : {}),
      text: source
        .replace(span, ' ')
        .replace(/^[\s,.!?;:]+|[\s,.!?;:]+$/gu, '')
        .trim(),
    };
  }).call(this);
}
module.exports = { managementCommandReply };
