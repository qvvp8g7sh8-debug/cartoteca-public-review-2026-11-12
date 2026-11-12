const { descriptor } = require('./name-matching.cjs');
const { nameForms } = require('./name-forms.cjs');
const { spokenSurnamePair } = require('./name-phonetics.cjs');
const { boundedNameDistance: editDistance } = require('./name-distance.cjs');
const { candidateJoinedNames } = require('./candidate-joined-name.cjs');
const { queryNameAnchor } = require('./name-query-anchor.cjs');
function candidateScore(person, plan, anchor) {
  const value = descriptor(person);
  if (!value.tokens.length || value.tokens.length > 8) return Infinity;
  const firstForms = new Set(
    value.tokens
      .filter((token) => token.kind === 'first')
      .flatMap((token) => nameForms(token.word, token.kind, value.gender)),
  );
  if (anchor.conflict || anchor.words.some((word) => !firstForms.has(word))) return Infinity;
  const joined = candidateJoinedNames(person, plan.variants, value);
  const given = new Set(
    [...plan.variants, ...joined.map((row) => row.words)]
      .flat()
      .filter((word) => firstForms.has(word)),
  );
  const cache = new Map(),
    spokenAllowed = value.tokens.some(
      (token) =>
        token.kind === 'first' &&
        nameForms(token.word, token.kind, value.gender).some((word) => given.has(word)),
    );
  function cost(word, index) {
    const key = word + '\u0000' + index;
    if (cache.has(key)) return cache.get(key);
    const token = value.tokens[index];
    let best = Infinity,
      spoken = Infinity;
    for (const form of new Set([token.word, ...nameForms(token.word, token.kind, value.gender)])) {
      const length = Math.min(
        word.replace(/[-']/gu, '').length,
        form.replace(/[-']/gu, '').length,
        token.word.replace(/[-']/gu, '').length,
      );
      const limit = length >= 8 ? 2 : length >= 5 ? 1 : 0;
      best = Math.min(best, editDistance(word, form, limit));
      if (spokenAllowed && token.kind === 'last') {
        const pair = spokenSurnamePair(word, form);
        if (pair) spoken = Math.min(spoken, editDistance(pair[0], pair[1], 3));
      }
    }
    const result = { plain: best, spoken };
    cache.set(key, result);
    return result;
  }
  function assignment(words, exact = false, joined = null) {
    let best = Infinity;
    const options = words.map((word, position) =>
      value.tokens.flatMap((token, index) => {
        const distance = cost(word, index);
        if (anchor.words.includes(word) && (token.kind !== 'first' || distance.plain !== 0))
          return [];
        if (
          joined &&
          ((position === joined.firstAt && (index !== joined.firstToken || distance.plain !== 0)) ||
            (position === joined.lastAt && token.kind !== 'last'))
        )
          return [];
        if (Number.isFinite(distance.plain) && (!exact || distance.plain === 0))
          return [
            {
              index,
              distance: distance.plain,
              anchor: token.kind === 'first' && given.has(word) && distance.plain === 0,
              spoken: false,
            },
          ];
        return !exact && Number.isFinite(distance.spoken)
          ? [
              {
                index,
                distance: 4 + distance.spoken,
                anchor: false,
                spoken: true,
              },
            ]
          : [];
      }),
    );
    function visit(position, used, score, anchored, spoken) {
      if (score >= best) return;
      if (position === options.length) {
        if (!spoken || anchored) best = score;
        return;
      }
      for (const option of options[position])
        if (!used.has(option.index))
          visit(
            position + 1,
            new Set([...used, option.index]),
            score + option.distance,
            anchored || option.anchor,
            spoken || option.spoken,
          );
    }
    visit(0, new Set(), 0, false, false);
    return best;
  }
  if (plan.excluded.some((words) => assignment(words, true) === 0)) return Infinity;
  return Math.min(
    ...plan.variants.map((words) => assignment(words)),
    ...joined.map((row) => assignment(row.words, false, row)),
  );
}
function rankNameSuggestions(candidates, plan) {
  const anchor = queryNameAnchor(candidates, plan);
  return candidates
    .map((patient) => ({
      patient,
      score: candidateScore(patient, plan, anchor),
    }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => a.score - b.score || String(a.patient.id).localeCompare(String(b.patient.id)))
    .map((row) => row.patient);
}
module.exports = { rankNameSuggestions };
