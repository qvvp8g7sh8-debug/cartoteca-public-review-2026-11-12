const { readSteps } = require('../../read-steps.cjs');
function semanticReceipt(entry, reply) {
  const dialogue = reply.dialogue
    ? {
        ...reply.dialogue,
        version: undefined,
        options: reply.dialogue.options.map(({ label }) => ({ label })),
        ...(reply.dialogue.controls
          ? { controls: reply.dialogue.controls.map(({ label }) => ({ label })) }
          : {}),
      }
    : null;
  return JSON.stringify([
    reply.text,
    reply.action,
    dialogue,
    [...entry.options.values()],
    [...(entry.controls || new Map()).values()],
    entry.data,
    entry.complete === true,
  ]);
}
function refreshManagementReceipt(c, entry, clock, present) {
  return readSteps(function* () {
    const previous = entry.response;
    // A receipt with no prior action may refresh choices, never execute a newly found target.
    const pending = !previous.action;
    const fresh = {
      ...entry,
      data: structuredClone(entry.data),
      options: new Map(entry.options),
      controls: new Map(entry.controls || []),
      complete: false,
    };
    const management = fresh.data.management;
    if (
      pending &&
      previous.dialogue?.phase === 'slots' &&
      !management.targetTime &&
      management.requestedTime
    )
      management.targetTime = management.requestedTime;
    const response = yield present(c, fresh, clock, pending);
    if (semanticReceipt(entry, previous) === semanticReceipt(fresh, response)) return previous;
    fresh.version = entry.version + 1;
    if (response.dialogue) response.dialogue.version = fresh.version;
    Object.assign(entry, {
      data: fresh.data,
      options: fresh.options,
      controls: fresh.controls,
      step: fresh.step,
      complete: fresh.complete,
      response,
      version: fresh.version,
    });
    return response;
  }).call(this);
}
module.exports = { refreshManagementReceipt };
