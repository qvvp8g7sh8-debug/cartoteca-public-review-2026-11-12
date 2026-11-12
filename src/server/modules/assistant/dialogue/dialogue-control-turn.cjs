const { readSteps } = require('./../read-steps.cjs');
const { informationResponse } = require('./dialogue-control.cjs');

// Keep the underlying question separate from the transient informational reply.
// Weak keys expire with dialogue receipts and never enter model context or storage.
const bases = new WeakMap();
const baseResponse = (reply) => bases.get(reply) || reply;
function signature(entry, reply) {
  const dialogue = reply?.dialogue;
  return JSON.stringify([
    entry.data,
    entry.step,
    [...entry.options.values()],
    [...(entry.controls || new Map()).values()],
    dialogue
      ? {
          ...dialogue,
          version: undefined,
          information: undefined,
          options: dialogue.options.map(({ label }) => ({ label })),
          controls: dialogue.controls?.map(({ label }) => ({ label })),
        }
      : null,
  ]);
}
const informationTurn = readSteps(function* informationTurn(
  entry,
  operation,
  { refresh, clock, limit, hash, replay = false },
) {
  const base = baseResponse(entry.response);
  const fresh = {
    ...entry,
    data: structuredClone(entry.data),
    options: new Map(entry.options),
    controls: new Map(entry.controls || []),
    complete: false,
    response: base,
  };
  const next = yield refresh(fresh);
  const changed = signature(entry, base) !== signature(fresh, next);
  if (replay && !changed) return entry.response;
  // Refreshers must request clarification instead of executing a newly found
  // target. Fail closed if a future caller supplies an executing presenter.
  if (next.action || !next.dialogue) {
    entry.complete = true;
    entry.cancelled = true;
    entry.options = new Map();
    entry.controls = new Map();
    entry.response = {
      text: 'Данные изменились. Начните команду заново.',
      action: null,
      dialogue: null,
    };
  } else {
    if (changed) {
      entry.data = fresh.data;
      entry.options = fresh.options;
      entry.controls = fresh.controls;
      entry.step = fresh.step;
      entry.availabilitySearch = fresh.availabilitySearch;
    }
    const current = changed ? next : base;
    entry.response = informationResponse(current, operation, clock, limit);
    bases.set(entry.response, current);
  }
  entry.version++;
  if (!replay) entry.turns++;
  if (entry.response.dialogue) entry.response.dialogue.version = entry.version;
  entry.lastHash = hash;
  return entry.response;
});
function copyInformationBase(source, target) {
  const base = source && bases.get(source);
  if (base && target) bases.set(target, structuredClone(base));
}
module.exports = { baseResponse, informationTurn, copyInformationBase };
