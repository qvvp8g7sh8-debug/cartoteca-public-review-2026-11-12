const { patientNameParts } = require('../../../../../shared/patient-names.cjs');
const {
  normalizeName,
  nameForms,
  nameGender,
  firstNameKind,
  inverseForms,
} = require('./name-forms.cjs');
const LIMITS = Object.freeze({ queries: 8, perQuery: 50, candidates: 200, tokens: 4 });
function nameTokens(value) {
  const text = normalizeName(value)
    .replace(/[.!?…]+$/u, '')
    .trim();
  return text && /^[\p{L}'-]+(?: [\p{L}'-]+)*$/u.test(text) ? text.split(' ') : [];
}
function descriptor(person, staff = false) {
  if (staff) {
    const tokens = nameTokens(person.displayName);
    const first = tokens.find(firstNameKind) || '';
    const middle = tokens.find((word) => /(?:ович|евич|ична|овна|евна)$/u.test(word)) || '';
    return {
      gender: nameGender(first, middle),
      tokens: tokens.map((word) => ({
        word,
        kind: firstNameKind(word) ? 'first' : word === middle ? 'middle' : 'last',
      })),
    };
  }
  const parts = patientNameParts(person);
  if (!parts.structured && nameTokens(parts.full).length > 2)
    return { gender: '', tokens: nameTokens(parts.full).map((word) => ({ word, kind: '' })) };
  return {
    gender: nameGender(parts.first, parts.middle),
    tokens: ['first', 'middle', 'last'].flatMap((kind) =>
      nameTokens(parts[kind]).map((word) => ({ word, kind })),
    ),
  };
}
function matchesName(person, query, staff = false) {
  const words = nameTokens(query),
    value = descriptor(person, staff);
  if (
    !words.length ||
    words.length > LIMITS.tokens ||
    words.some((word) => word.replace(/[-']/g, '').length < 2)
  )
    return false;
  const options = words.map((word) =>
    value.tokens.flatMap((token, index) =>
      token.word === word || nameForms(token.word, token.kind, value.gender).includes(word)
        ? [index]
        : [],
    ),
  );
  // Every query token must refer to a different complete token, in either FIO order.
  function assign(index, used) {
    return (
      index === options.length ||
      options[index].some((slot) => !used.has(slot) && assign(index + 1, new Set([...used, slot])))
    );
  }
  return assign(0, new Set());
}
function yoVariants(value) {
  let values = [''];
  for (const char of value) {
    values = values.flatMap((prefix) =>
      char === 'е' ? [prefix + 'е', prefix + 'ё'] : [prefix + char],
    );
    if (values.length > LIMITS.queries) return null;
  }
  return values;
}
function searchPlan(query) {
  const words = nameTokens(query);
  if (
    !words.length ||
    words.length > LIMITS.tokens ||
    words.some((word) => word.replace(/[-']/g, '').length < 2)
  )
    return { queries: [], overflow: false };
  // A whole component of a double surname is an anchor; the final match still requires the whole surname.
  const anchors = words
    .flatMap((word) => word.split('-'))
    .filter((word) => word.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const anchor of anchors) {
    const queries = new Set();
    let overflow = false;
    const forms = inverseForms(anchor);
    for (const form of forms) {
      const aliases = yoVariants(form);
      if (!aliases) {
        overflow = true;
        break;
      }
      for (const alias of aliases) queries.add(alias);
    }
    // The directory uses literal includes: a shorter retained query covers a longer one.
    // This only reduces candidate reads; complete-token matching still decides identity.
    const packed = [...queries].filter(
      (query) =>
        ![...queries].some((other) => other.length < query.length && query.includes(other)),
    );
    if (!overflow && packed.length <= LIMITS.queries) return { queries: packed, overflow: false };
    if (!overflow && forms.some(firstNameKind)) {
      // A known given-name alias family may have too many literal yo variants.
      // Four-character candidate anchors retain every variant; final identity matching is unchanged.
      const prefixes = [...new Set(packed.map((query) => query.slice(0, 4)))];
      const compact = prefixes.filter(
        (query) => !prefixes.some((other) => other.length < query.length && query.includes(other)),
      );
      if (compact.length <= LIMITS.queries) return { queries: compact, overflow: false };
    }
  }
  return { queries: [], overflow: true };
}
function patientQuery(patient) {
  return patientNameParts(patient).full;
}
module.exports = { LIMITS, nameTokens, matchesName, searchPlan, patientQuery, descriptor };
