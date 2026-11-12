const { patientNameParts } = require('../../../../../shared/patient-names.cjs');
const { nameTokens, searchPlan, LIMITS } = require('./name-matching.cjs');
const { nameForms, nameGender, normalizeName } = require('./name-forms.cjs');
const { isBookingCommandWord } = require('../../dialogue/booking-command-words.cjs');
const controls = new Set('не нет или либо и а если кроме исключая вместо да пожалуйста'.split(' '));
function clientComponentPlan(query) {
  const words = nameTokens(query);
  if (
    words.length < 2 ||
    words.length > 3 ||
    words.some(
      (word) =>
        word.length < 2 || word.length > 48 || controls.has(word) || isBookingCommandWord(word),
    )
  )
    return { words: [], queries: [], overflow: false };
  const queries = new Set();
  for (const word of words) {
    const plan = searchPlan(word);
    if (plan.overflow) return { words, queries: [], overflow: true };
    const normalized = plan.queries.map(normalizeName);
    let prefix = normalized[0] || '';
    for (const value of normalized)
      while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
    // Candidate-only common stems cover every existing case/ё query with fewer reads.
    // Complete component forms still decide the match; broad pages still fail closed.
    const packed =
      prefix.length >= 3
        ? [...new Set(plan.queries.map((value) => value.slice(0, prefix.length)))]
        : plan.queries;
    for (const value of packed) queries.add(value);
  }
  return queries.size > LIMITS.queries
    ? { words, queries: [], overflow: true }
    : { words, queries: [...queries], overflow: false };
}
function rankClientComponents(candidates, plan) {
  const rows = candidates.flatMap((patient) => {
    const parts = patientNameParts(patient);
    if (!parts.structured) return [];
    const gender = nameGender(parts.first, parts.middle);
    return [
      {
        patient,
        parts,
        forms: Object.fromEntries(
          ['first', 'middle', 'last'].map((kind) => [
            kind,
            new Set(nameForms(parts[kind], kind, gender)),
          ]),
        ),
      },
    ];
  });
  const known = plan.words.flatMap((word, index) => {
    const kinds = ['first', 'middle', 'last'].filter((kind) =>
      rows.some((row) => row.forms[kind].has(word)),
    );
    return kinds.length ? [{ word, index, kinds }] : [];
  });
  const empty = { matches: [], overflow: false, approximate: true };
  if (!known.length) return empty;
  if (
    known.some((item) => item.kinds.length !== 1) ||
    new Set(known.map((item) => item.kinds[0])).size !== known.length
  )
    return { ...empty, componentConflict: true };
  const matches = rows.filter((row) =>
    known.every((item) => row.forms[item.kinds[0]].has(item.word)),
  );
  if (!matches.length) {
    const first = known.filter((item) => item.kinds[0] === 'first'),
      last = known.filter((item) => item.kinds[0] === 'last');
    if (first.length === 1 && last.length === 1 && known.length === plan.words.length) {
      // This is a different-person proposal, not a relaxed match for the spoken FIO.
      // Every other heard component (including a patronymic) remains an exact constraint.
      const alternatives = rows
        .filter((row) =>
          known.every(
            (item) => item.kinds[0] === 'first' || row.forms[item.kinds[0]].has(item.word),
          ),
        )
        .sort((a, b) => String(a.patient.id).localeCompare(String(b.patient.id)));
      if (alternatives.length > 5)
        return {
          ...empty,
          overflow: true,
          componentNameConflict: true,
          component: 'first',
          componentAnchor: { field: 'last', value: last[0].word },
        };
      if (alternatives.length) {
        const families = alternatives.map((row) => row.parts.last),
          sameFamily = new Set(families.map(normalizeName)).size === 1,
          given = alternatives.map((row) => row.parts.first),
          named =
            new Set(given.map(normalizeName)).size === given.length
              ? given
              : alternatives.map((row) =>
                  [row.parts.first, row.parts.middle].filter(Boolean).join(' '),
                ),
          distinct =
            named.every(Boolean) && new Set(named.map(normalizeName)).size === named.length;
        return {
          matches: alternatives.map((row) => row.patient),
          overflow: false,
          approximate: true,
          componentNameConflict: true,
          component: 'first',
          componentAnchor: { field: 'last', value: sameFamily ? families[0] : last[0].word },
          componentPrompt: distinct
            ? sameFamily
              ? families[0] + ': ' + named.join(' или ') + '?'
              : alternatives.map((row) => row.parts.full).join(' или ') + '?'
            : 'Назовите последние четыре цифры телефона или полное имя.',
        };
      }
    }
    return { ...empty, componentConflict: true };
  }
  if (known.length === plan.words.length) return { ...empty, componentConflict: true };
  if (!known.some((item) => ['first', 'last'].includes(item.kinds[0]))) return empty;
  if (matches.length > 5) return { ...empty, overflow: true };
  const kinds = new Set(known.map((item) => item.kinds[0]));
  const component =
    kinds.has('first') && !kinds.has('last')
      ? 'last'
      : kinds.has('last') && !kinds.has('first')
        ? 'first'
        : 'full';
  const values = matches.map((row) => row.parts[component]);
  const distinct =
    values.every(Boolean) && new Set(values.map(normalizeName)).size === values.length;
  const anchorKind = component === 'last' ? 'first' : 'last';
  const anchors = matches.map((row) => row.parts[anchorKind]);
  const anchor = new Set(anchors.map(normalizeName)).size === 1 ? anchors[0] : '';
  return {
    matches: matches
      .map((row) => row.patient)
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    overflow: false,
    approximate: true,
    component,
    componentAnchor: { field: anchorKind, value: anchor },
    componentPrompt:
      distinct && component !== 'full'
        ? values.join(' или ') + '?'
        : 'Уточните полное имя или телефон клиента.',
  };
}
function clientComponentStamp(result) {
  if (!result?.component || !result.componentAnchor || result.overflow) return '';
  return JSON.stringify([
    result.component,
    result.componentAnchor.field,
    normalizeName(result.componentAnchor.value),
    result.componentNameConflict === true,
    result.matches
      .map((patient) => [
        patient.id,
        normalizeName(patientNameParts(patient).full),
        String(patient.phone || '')
          .replace(/\D/gu, '')
          .slice(-4),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
function currentClientComponentAnchor(candidates, query) {
  const words = nameTokens(query);
  if (words.length !== 1 || !candidates.length) return null;
  const kinds = ['first', 'last'].filter((kind) =>
    candidates.every((patient) => {
      const parts = patientNameParts(patient);
      return (
        parts.structured &&
        nameForms(parts[kind], kind, nameGender(parts.first, parts.middle)).includes(words[0])
      );
    }),
  );
  return kinds.length === 1 ? { field: kinds[0], value: words[0] } : null;
}
function repeatsClientComponent(anchor, choice, raw) {
  const words = nameTokens(raw);
  if (
    !anchor ||
    !choice?.componentClarification ||
    words.length !== 1 ||
    !['first', 'last'].includes(anchor.field)
  )
    return false;
  const parts = patientNameParts(choice.clientName);
  return (
    parts.structured &&
    nameForms(parts[anchor.field], anchor.field, nameGender(parts.first, parts.middle)).includes(
      words[0],
    )
  );
}
module.exports = {
  clientComponentPlan,
  rankClientComponents,
  clientComponentStamp,
  currentClientComponentAnchor,
  repeatsClientComponent,
};
