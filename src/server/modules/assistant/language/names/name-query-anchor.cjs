const { patientNameParts } = require('../../../../../shared/patient-names.cjs');
const { descriptor } = require('./name-matching.cjs');
const { nameForms } = require('./name-forms.cjs');
// Establish a query-wide given-name constraint before comparing any fuzzy candidate.
// Use complete components of the first retrieval interpretation, not later split hypotheses.
// Suggestion-only merges remain hypotheses; this constraint never grants exact identity.
function queryNameAnchor(candidates, plan) {
  const words = plan?.variants?.[0];
  if (!Array.isArray(words) || !words.length || words.length > 4)
    return { words: [], conflict: false };
  const wanted = new Set(words),
    roles = new Map();
  for (const patient of candidates) {
    if (!patientNameParts(patient).structured) continue;
    const value = descriptor(patient);
    for (const token of value.tokens) {
      if (!['first', 'middle', 'last'].includes(token.kind)) continue;
      for (const form of nameForms(token.word, token.kind, value.gender)) {
        if (!wanted.has(form)) continue;
        if (!roles.has(form)) roles.set(form, new Set());
        roles.get(form).add(token.kind);
      }
    }
  }
  const anchored = [...wanted].filter((word) => roles.get(word)?.has('first'));
  return {
    words: anchored,
    // A component declared as both a given and family/middle name cannot be typed
    // from source order alone. Keep it unresolved rather than guessing a field.
    conflict: anchored.some((word) => roles.get(word).size !== 1),
  };
}
module.exports = { queryNameAnchor };
