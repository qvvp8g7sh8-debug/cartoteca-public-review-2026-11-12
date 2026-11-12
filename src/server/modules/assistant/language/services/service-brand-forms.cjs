// Deterministic catalog comparison only; callers still check current-catalog uniqueness.
const { normalizeName } = require('../names/name-forms.cjs');
const letters = Object.freeze({
  a: 'a ay ei',
  b: 'b be bee bi',
  c: 'c ce see si tse',
  d: 'd de dee di',
  e: 'e ee i ye',
  f: 'f ef',
  g: 'g ge gee ji dji',
  h: 'h eich eych ash',
  i: 'i ai eye',
  j: 'j jay jei',
  k: 'k ka kay kei',
  l: 'l el',
  m: 'm em',
  n: 'n en',
  o: 'o oh ou',
  p: 'p pe pee pi',
  q: 'q cue kyu ku',
  r: 'r er ar',
  s: 's es',
  t: 't te tee ti',
  u: 'u yu',
  v: 'v ve vee vi',
  w: 'w doubleyu dablyu',
  x: 'x eks iks ex ix',
  y: 'y wai ipsilon',
  z: 'z ze zee zet zi',
});
const russian = Object.freeze({
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
});
function spokenKey(value) {
  return normalizeName(value)
    .replace(/дж/gu, 'j')
    .replace(/[а-яё]/gu, (char) => russian[char])
    .replace(/[\s'-]/gu, '')
    .replace(/qu/gu, 'kv')
    .replace(/ee/gu, 'i')
    .replace(/x/gu, 'ks');
}
function brandSearchScore(catalog, words) {
  // A complete consonant-only Cyrillic acronym can spell the same Latin letters.
  // No prefix or edit-distance conversion is introduced for ordinary words.
  if (/^[бвгджзклмнпрстфхцчшщ]{2,8}$/iu.test(catalog)) {
    const latin = spokenKey(catalog).toUpperCase();
    if (/^[A-Z]{2,8}$/u.test(latin)) return brandSearchScore(latin, words);
  }
  if (
    !/^[A-Za-z]+(?:[-'][A-Za-z]+)*$/u.test(catalog) ||
    catalog.length > 48 ||
    !words.length ||
    words.length > 6 ||
    words.some((word) => !/^[\p{L}]+(?:[-'][\p{L}]+)*$/u.test(word))
  )
    return Infinity;
  const raw = words.join('');
  // Visual Cyrillic letters are meaningful only against a complete Latin catalog
  // identifier. This is not fuzzy spelling or an unrestricted prefix conversion.
  const visual = {
    а: 'a',
    в: 'b',
    е: 'e',
    к: 'k',
    м: 'm',
    н: 'h',
    о: 'o',
    р: 'p',
    с: 'c',
    т: 't',
    у: 'y',
    х: 'x',
  };
  const latin = normalizeName(raw).replace(/[авекмнорстух]/gu, (char) => visual[char]);
  if (
    /^[A-Za-z]{2,8}$/u.test(catalog) &&
    /^[a-z]{2,8}$/u.test(latin) &&
    catalog.toLowerCase() === latin &&
    (/^[A-Z]+$/u.test(catalog) || !/[aeiouy]/iu.test(catalog))
  )
    return 1;
  const query = spokenKey(raw);
  if (!query || query.length > 64) return Infinity;
  if (spokenKey(catalog) === query) return 1;
  // Acronym pronunciations are generated from letters, never from a brand dictionary.
  if (
    !/^[A-Za-z]{2,8}$/u.test(catalog) ||
    !(/^[A-Z]+$/u.test(catalog) || !/[aeiouy]/iu.test(catalog))
  )
    return Infinity;
  let positions = new Set([0]);
  for (const char of catalog.toLowerCase()) {
    const next = new Set();
    for (const at of positions)
      for (const name of letters[char].split(' ')) {
        const form = spokenKey(name);
        if (query.startsWith(form, at)) next.add(at + form.length);
        if (
          at > 0 &&
          /^[aeiou]/u.test(form) &&
          query[at - 1] === form[0] &&
          query.startsWith(form.slice(1), at)
        )
          next.add(at + form.length - 1);
      }
    positions = next;
    if (!positions.size) return Infinity;
  }
  return positions.has(query.length) ? 2 : Infinity;
}
module.exports = { brandSearchScore };
