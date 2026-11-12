// Bounded deterministic catalog comparison; callers distinguish candidates from unique identities.
const { normalizeName } = require('../names/name-forms.cjs');
const { serviceWordForms, serviceText } = require('./service-matching.cjs');
const { brandSearchScore } = require('./service-brand-forms.cjs');
const unsafe =
  /(?:^|\s)(?:не|нет|или|либо|если|кроме|исключая|вместо|и|отправь|отправить|сохрани|сохранить|удали|удалить|создай|запиши|отмени)(?=$|\s)/u;
function units(value, catalog = false) {
  const raw = serviceText(value).trim();
  if (!raw || raw.length > (catalog ? 512 : 160) || unsafe.test(normalizeName(raw))) return null;
  const result = [],
    pattern = /[+-]?[\p{L}\p{N}]+(?:[-'.,/:][\p{L}\p{N}]+)*(?:[%‰°])?/gu;
  let end = 0;
  const word = (text) =>
    result.push({
      kind: 'word',
      raw: text,
      value: normalizeName(text),
      identifier:
        /^[A-Z]{2,8}$/u.test(text) ||
        /^[A-Za-z]*[a-z][A-Z][A-Za-z]*$/u.test(text) ||
        (/^[A-Za-z]{2,8}$/u.test(text) && !/[aeiouy]/iu.test(text)) ||
        /^[бвгджзклмнпрстфхцчшщ]{2,8}$/iu.test(text),
    });
  const code = (text) => result.push({ kind: 'code', raw: text, value: normalizeName(text) });
  for (const match of raw.matchAll(pattern)) {
    if (!(catalog ? /^[\s(),]*$/u : /^\s*$/u).test(raw.slice(end, match.index))) return null;
    const token = match[0];
    const branded = token.match(
      /^([\p{L}]{2,16})-([A-Za-z]{1,8}[+-]?\d[\p{L}\p{N}.,:/+-]*[%‰°]?)$/u,
    );
    const attached = token.match(/^([а-яё]+)([+-]?\d[\p{N}.,:/+-]*[%‰°]?)$/iu);
    if (branded) {
      word(branded[1]);
      code(branded[2]);
    } else if (attached) {
      word(attached[1]);
      code(attached[2]);
    } else if (/\p{N}/u.test(token)) code(token);
    else word(token);
    end = match.index + token.length;
  }
  if (
    !(catalog ? /^[\s(),]*$/u : /^\s*$/u).test(raw.slice(end)) ||
    !result.length ||
    result.length > (catalog ? 24 : 12)
  )
    return null;
  return result;
}
function searchScore(name, query, complete, requireIdentifier = false, description = false) {
  const wanted = units(query),
    catalog = units(name, true);
  if (!wanted || !catalog) return Infinity;
  const numbers = (rows) => rows.filter((row) => row.kind === 'code').map((row) => row.value);
  const requestedCodes = numbers(wanted),
    catalogCodes = numbers(catalog);
  const numeric = requestedCodes.length > 0;
  if ((numeric || complete) && JSON.stringify(requestedCodes) !== JSON.stringify(catalogCodes))
    return Infinity;
  if (numeric && !catalog.some((row) => row.kind === 'word' && /^[A-Za-z]{2,48}$/u.test(row.raw)))
    return Infinity;
  // Omitting a technology acronym is safe only for a complete nonnumeric
  // description. Every area/connector/other qualifier must still be heard.
  const descriptionRows = catalog.filter((row) => !row.identifier && row.value !== 'плюс');
  if (
    description &&
    (catalogCodes.length || !catalog.some((row) => row.identifier) || descriptionRows.length < 2)
  )
    return Infinity;
  const descriptionMask = catalog.reduce(
    (mask, row, index) => (row.identifier ? mask : mask | (1 << index)),
    0,
  );
  // An explicitly named additive bundle must not acquire an extra area from
  // a longer service. Bare PRX/RF requests retain their existing identity rule.
  const composite = wanted.some((row) => row.kind === 'word' && row.value === 'плюс');
  const compositeMask = catalog.reduce(
    (mask, row, index) => (row.kind === 'word' && !row.identifier ? mask | (1 << index) : mask),
    0,
  );
  const memo = new Map(),
    wordMemo = new Map();
  const forms = catalog.map((row) => (row.kind === 'word' ? serviceWordForms(row.value) : null));
  let states = 0;
  function scoreWord(index, start, count) {
    const key = index + ':' + start + ':' + count;
    if (wordMemo.has(key)) return wordMemo.get(key);
    const target = catalog[index],
      parts = wanted.slice(start, start + count);
    let score = Infinity;
    if (target.kind === 'word' && parts.every((row) => row.kind === 'word'))
      score =
        count === 1 && forms[index].has(parts[0].value)
          ? 0
          : brandSearchScore(
              target.raw,
              parts.map((row) => row.raw),
            );
    wordMemo.set(key, score);
    return score;
  }
  function visit(at, used, after, identified = false) {
    if (++states > 4096) return Infinity;
    if (at === wanted.length)
      return (!complete || used === (1 << catalog.length) - 1) &&
        (!requireIdentifier || identified) &&
        (!description || (used & descriptionMask) === descriptionMask) &&
        (!composite || (used & compositeMask) === compositeMask)
        ? 0
        : Infinity;
    const key =
      at +
      ':' +
      (numeric ? after : used) +
      (numeric && composite ? ':' + used : '') +
      (requireIdentifier ? ':' + Number(identified) : '');
    if (memo.has(key)) return memo.get(key);
    let best = Infinity;
    for (
      let index = numeric ? after : 0;
      index < (complete && numeric ? Math.min(after + 1, catalog.length) : catalog.length);
      index++
    ) {
      if (!numeric && used & (1 << index)) continue;
      const target = catalog[index],
        request = wanted[at];
      if (request.kind === 'code') {
        if (target.kind === 'code' && target.value === request.value)
          best = Math.min(best, visit(at + 1, used | (1 << index), index + 1, true));
        continue;
      }
      for (let count = 1; count <= 6 && at + count <= wanted.length; count++) {
        if (wanted[at + count - 1].kind !== 'word') break;
        const cost = scoreWord(index, at, count);
        if (Number.isFinite(cost))
          best = Math.min(
            best,
            cost +
              visit(
                at + count,
                used | (1 << index),
                index + 1,
                identified || target.identifier === true,
              ),
          );
      }
    }
    memo.set(key, best);
    return best;
  }
  const score = visit(0, 0, 0);
  return states > 4096 || !Number.isFinite(score)
    ? Infinity
    : 2 + score + (numeric ? 0 : catalogCodes.length / 4);
}
function partialServiceScore(name, query) {
  return searchScore(name, query, false);
}
function serviceAliasSourceMatches(proposal, raw) {
  return Number.isFinite(searchScore(proposal, raw, true));
}
function servicePartialIdentityMatches(name, query) {
  return Number.isFinite(searchScore(name, query, false, true));
}
function serviceHasIdentifier(name) {
  return units(name, true)?.some((row) => row.identifier === true) || false;
}
function serviceDescriptionMatches(name, query) {
  return Number.isFinite(searchScore(name, query, false, false, true));
}
module.exports = {
  partialServiceScore,
  serviceAliasSourceMatches,
  servicePartialIdentityMatches,
  serviceDescriptionMatches,
  serviceHasIdentifier,
};
