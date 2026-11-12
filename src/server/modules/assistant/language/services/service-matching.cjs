const { normalizeName } = require('../names/name-forms.cjs');
const adjectiveForms = [
  ['ая', ['ая', 'ую', 'ой', 'ою', 'ые', 'ых', 'ым', 'ыми']],
  ['яя', ['яя', 'юю', 'ей', 'ею', 'ие', 'их', 'им', 'ими']],
  ['ый', ['ый', 'ого', 'ому', 'ым', 'ом', 'ые', 'ых', 'ыми']],
  ['ий', ['ий', 'его', 'ему', 'им', 'ем', 'ие', 'их', 'ими']],
];
// A closed whole-term family: both established spellings have the same noun
// inflections. No prefix matching or general vowel replacement is introduced.
const plasmaEndings = ['', 'а', 'у', 'ом', 'е', 'и', 'ов', 'ам', 'ами', 'ах'];
const plasmaForms = new Set(
  ['плазмалифтинг', 'плазмолифтинг'].flatMap((stem) =>
    plasmaEndings.map((ending) => stem + ending),
  ),
);
function wordForms(word) {
  if (plasmaForms.has(word)) return new Set(plasmaForms);
  if (!/^[а-я]+$/u.test(word)) return new Set([word]);
  for (const [ending, forms] of adjectiveForms)
    if (word.length > ending.length + 1 && word.endsWith(ending))
      return new Set(forms.map((form) => word.slice(0, -ending.length) + form));
  for (const [ending, forms] of [
    ['ия', ['ия', 'ию', 'ии', 'ией', 'иею', 'ий', 'иям', 'иями', 'иях']],
    ['а', ['а', 'у', 'ы', 'и', 'е', 'ой', 'ою']],
    ['я', ['я', 'ю', 'и', 'е', 'ей', 'ею']],
  ])
    if (word.length > ending.length + 1 && word.endsWith(ending))
      return new Set(forms.map((form) => word.slice(0, -ending.length) + form));
  if (/^[а-я]{3,}[бвгджзклмнпрстфхцчшщ]$/u.test(word))
    return new Set(
      ['', 'а', 'у', 'ом', 'ем', 'е', 'ы', 'и', 'ов', 'ей', 'ам', 'ами', 'ах'].map(
        (ending) => word + ending,
      ),
    );
  return new Set([word]);
}
// Keep additive treatment areas explicit; never strip a sign from a numeric qualifier.
// Script-boundary hyphens are typography, unlike the hyphen inside a product code.
function serviceText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[’\u02bc]/gu, "'")
    .replace(/([\p{L}])\s*\+\s*(?=[\p{L}])/gu, '$1 плюс ')
    .replace(/(^|[^\p{L}\p{N}])([A-Za-z]{2,48})-(?=[А-Яа-яЁё]{3})/gu, '$1$2 ')
    .replace(/(^|[^\p{L}\p{N}])([А-Яа-яЁё]{3,})-(?=[A-Za-z]{2,48}(?=$|[^\p{L}\p{N}]))/gu, '$1$2 ')
    .replace(
      /(^|[^\p{L}\p{N}])([БВГДЖЗКЛМНПРСТФХЦЧШЩбвгджзклмнпрстфхцчшщ]{2,8})-(?=[А-Яа-яЁё]{3})/gu,
      '$1$2 ',
    );
}
function words(value) {
  return (
    normalizeName(serviceText(value))
      .replace(/[.!?…]+$/u, '')
      .match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || []
  );
}
function numericWords(value) {
  return (
    normalizeName(serviceText(value))
      .replace(/[.!?…]+$/u, '')
      .match(/[+-]?\p{N}+(?:[^\p{L}\p{N}\s]\p{N}+)*(?:[%‰°])?|[\p{L}]+(?:[-'][\p{L}]+)*/gu) || []
  );
}
function serviceMatches(name, query) {
  // Numeric qualifiers keep their complete ordered attachment; only word inflections vary.
  if (/[\p{N}]/u.test(String(name || '') + String(query || ''))) {
    const wanted = numericWords(query),
      catalog = numericWords(name);
    if (
      !wanted.length ||
      wanted.length > 16 ||
      catalog.length > 64 ||
      wanted.length !== catalog.length
    )
      return false;
    return wanted.every((word, index) => wordForms(catalog[index]).has(word));
  }
  const wanted = words(query),
    catalog = words(name);
  if (
    !wanted.length ||
    wanted.length > 16 ||
    catalog.length > 64 ||
    wanted.length > catalog.length ||
    (wanted.includes('плюс') && wanted.length !== catalog.length)
  )
    return false;
  // Complete words may arrive in any order; every request word consumes a distinct catalog word.
  const forms = catalog.map(wordForms),
    assigned = new Map();
  function place(index, seen) {
    for (let slot = 0; slot < forms.length; slot++) {
      if (seen.has(slot) || !forms[slot].has(wanted[index])) continue;
      seen.add(slot);
      if (!assigned.has(slot) || place(assigned.get(slot), seen)) {
        assigned.set(slot, index);
        return true;
      }
    }
    return false;
  }
  return wanted.every((_, index) => place(index, new Set()));
}
module.exports = { serviceMatches, serviceWords: words, serviceWordForms: wordForms, serviceText };
