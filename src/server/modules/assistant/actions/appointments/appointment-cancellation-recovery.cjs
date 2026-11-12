const { readSteps } = require('../../read-steps.cjs');
const { managementSource } = require('./appointment-management-references.cjs');
const { cancellationConfirmation } = require('./appointment-cancellation-snapshot.cjs');
const { clientLabel } = require('../../dialogue/dialogue-options.cjs');
function renewCancellation(c, entry, clock, error) {
  return readSteps(function* () {
    if (
      error?.code !== 'ASSISTANT_CANCEL_CONFIRMATION_STALE' ||
      entry.data.management?.operation !== 'cancel' ||
      entry.cancelled ||
      entry.executionSaved
    )
      return null;
    // The original source stamp and current ACL must still be valid. A changed
    // appointment cannot be silently substituted while renewing consent.
    const source = yield managementSource(c, entry.data.management.source);
    const before = { ...entry };
    entry.data = structuredClone(entry.data);
    try {
      const m = entry.data.management;
      delete m.cancelConfirmation;
      delete m.cancelConfirmed;
      entry.data.patient.label = clientLabel(source.patient);
      entry.complete = false;
      entry.version++;
      entry.turns++;
      entry.lastHash = null;
      entry.response = yield cancellationConfirmation(c, entry, source, clock);
      return entry.response;
    } catch (failure) {
      Object.assign(entry, before);
      throw failure;
    }
  }).call(this);
}
module.exports = { renewCancellation };
