const { normalizeName, inverseForms, firstNameKind, nameForms } = require('./name-forms.cjs');
const exactGivenBases = (word) =>
  inverseForms(word).filter(
    (base) => firstNameKind(base) && nameForms(base, 'first').includes(word),
  );
function knownGivenForm(word) {
  return exactGivenBases(word).length > 0;
}
const vowels = /[аеёиоуыэюяьъ]/gu;
const paired = { б: 'п', в: 'ф', г: 'к', д: 'т', ж: 'ш', з: 'с' };
const devoice = (text) => text.replace(/[бвгджз]/gu, (letter) => paired[letter]);
function surnameSound(value) {
  const word = normalizeName(value);
  if (!/^[а-я]{5,32}$/u.test(word)) return null;
  const skeleton = word.replace(vowels, '');
  if (skeleton.length < 5) return null;
  return {
    skeleton,
    folded: devoice(skeleton),
    sound: devoice(
      word.replace(/[ьъ]/gu, '').replace(/[оая]/gu, 'а').replace(/[еы]/gu, 'и').replace(/ю/gu, 'у'),
    ),
  };
}
// A strong spoken fallback keeps the full consonant sequence: no arbitrary consonant edits.
function spokenSurnamePair(heard, actual) {
  const first = surnameSound(heard),
    second = surnameSound(actual);
  if (!first || !second || first.folded !== second.folded) return null;
  return [first.sound, second.sound];
}
function yoQueries(word) {
  const variants = [word];
  for (let index = 0; index < word.length && variants.length < 2; index++)
    if (word[index] === 'е') variants.push(word.slice(0, index) + 'ё' + word.slice(index + 1));
  return variants;
}
function spokenNameQueries(variants) {
  const given = [],
    clusters = [];
  const append = (rows, word, limit) => {
    if (!rows.includes(word) && rows.length < limit) rows.push(word);
  };
  for (const words of variants) {
    if (words.length < 2 || words.length > 4) continue;
    for (let index = 0; index < words.length; index++) {
      const bases = exactGivenBases(words[index]);
      if (!bases.length) continue;
      const surnames = words
        .filter((_, other) => other !== index)
        .map(surnameSound)
        .filter(Boolean);
      if (!surnames.length) continue;
      for (const base of bases) for (const query of yoQueries(base)) append(given, query, 2);
      for (const row of surnames)
        for (const position of [
          ...new Set([0, Math.max(0, Math.floor((row.skeleton.length - 4) / 2))]),
        ])
          append(clusters, row.skeleton.slice(position, position + 4), 2);
    }
  }
  return [...given, ...clusters];
}
module.exports = { knownGivenForm, spokenNameQueries, spokenSurnamePair };
