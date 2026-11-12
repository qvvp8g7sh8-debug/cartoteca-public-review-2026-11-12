const { createHash } = require('node:crypto');
const { fail } = require('../../../../shared/errors.cjs');
const { normalizeRules, normalizeExampleSelection } = require('./behavior-schema.cjs');
function compareRules(before, after) {
  const left = new Map(before.examples.map((example) => [example.id, example]));
  const right = new Map(after.examples.map((example) => [example.id, example]));
  const sharedBefore = before.examples
    .filter((example) => right.has(example.id))
    .map((example) => example.id);
  const sharedAfter = after.examples
    .filter((example) => left.has(example.id))
    .map((example) => example.id);
  const field = (name) => ({
    changed: before[name] !== after[name],
    before: before[name],
    after: after[name],
  });
  return {
    instructions: field('instructions'),
    dictionary: field('dictionary'),
    exampleSelection: {
      changed:
        normalizeExampleSelection(before.exampleSelection) !==
        normalizeExampleSelection(after.exampleSelection),
      before: normalizeExampleSelection(before.exampleSelection),
      after: normalizeExampleSelection(after.exampleSelection),
    },
    examples: {
      added: after.examples.filter((example) => !left.has(example.id)),
      removed: before.examples.filter((example) => !right.has(example.id)),
      changed: after.examples
        .filter(
          (example) =>
            left.has(example.id) &&
            JSON.stringify(left.get(example.id)) !== JSON.stringify(example),
        )
        .map((example) => ({ id: example.id, before: left.get(example.id), after: example })),
      orderChanged: JSON.stringify(sharedBefore) !== JSON.stringify(sharedAfter),
    },
  };
}
function reviewHash(actorId, revision, rules, sourceVersion = null) {
  // A review-content binding, not authorization: session/CSRF/admin checks remain mandatory.
  return createHash('sha256')
    .update(JSON.stringify({ actorId, revision, rules: normalizeRules(rules), sourceVersion }))
    .digest('hex');
}
function requireReview(actorId, state, rules, sourceVersion, value) {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value) ||
    value !== reviewHash(actorId, state.revision, rules, sourceVersion)
  )
    throw fail(409, 'Предпросмотр устарел или правила изменились. Просмотрите изменения ещё раз.');
}
module.exports = { compareRules, reviewHash, requireReview };
