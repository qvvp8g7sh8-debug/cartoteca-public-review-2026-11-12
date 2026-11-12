const { patientNameParts } = require('../../../../../shared/patient-names.cjs');
const { nameForms } = require('./name-forms.cjs');
const MAX_JOINED_HYPOTHESES = 8;
// Candidate-derived boundaries are ranking hypotheses, never strict identity authority.
function candidateJoinedNames(person, variants, value) {
  if (!patientNameParts(person).structured || !Array.isArray(variants) || variants.length > 9)
    return [];
  const given = value.tokens.flatMap((token, index) =>
    token.kind === 'first'
      ? [...new Set(nameForms(token.word, token.kind, value.gender))]
          .filter((word) => /^[\p{L}]{2,43}$/u.test(word))
          .map((form) => ({ form, index }))
      : [],
  );
  if (!given.length || !value.tokens.some((token) => token.kind === 'last')) return [];
  const result = [],
    seen = new Set();
  for (const words of variants) {
    if (
      !Array.isArray(words) ||
      !words.length ||
      words.length > 3 ||
      words.some((word) => typeof word !== 'string' || word.length > 48)
    )
      continue;
    for (let at = 0; at < words.length; at++) {
      const word = words[at];
      if (!/^[\p{L}]{7,48}$/u.test(word)) continue;
      for (const { form, index } of given)
        for (const first of [true, false]) {
          if (!(first ? word.startsWith(form) : word.endsWith(form))) continue;
          const rest = first ? word.slice(form.length) : word.slice(0, -form.length);
          if (!/^[\p{L}]{5,46}$/u.test(rest)) continue;
          const parts = first ? [form, rest] : [rest, form];
          const next = [...words.slice(0, at), ...parts, ...words.slice(at + 1)];
          const hypothesis = {
            words: next,
            firstAt: at + (first ? 0 : 1),
            lastAt: at + (first ? 1 : 0),
            firstToken: index,
          };
          const key = JSON.stringify(hypothesis);
          if (seen.has(key)) continue;
          seen.add(key);
          result.push(hypothesis);
          // Do not silently retain only the first interpretation of an over-ambiguous boundary.
          if (result.length > MAX_JOINED_HYPOTHESES) return [];
        }
    }
  }
  return result;
}
module.exports = { candidateJoinedNames, MAX_JOINED_HYPOTHESES };
