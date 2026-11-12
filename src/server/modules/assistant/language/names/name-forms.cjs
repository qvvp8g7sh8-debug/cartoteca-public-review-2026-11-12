// Search aliases only: stored names are never rewritten; this is not identity verification.
const { shortGivenNames, givenNameBases } = require('./given-name-aliases.cjs');
const normalizeName = (value) =>
  String(value || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[’\u02bc]/g, "'")
    .trim()
    .replace(/\s+/g, ' ');
const families = [
  ['ова', 'овой', 'овой', 'ову', 'овой', 'овой', 'овою'],
  ['ева', 'евой', 'евой', 'еву', 'евой', 'евой', 'евою'],
  ['ина', 'иной', 'иной', 'ину', 'иной', 'иной', 'иною'],
  ['ына', 'ыной', 'ыной', 'ыну', 'ыной', 'ыной', 'ыною'],
  ['ов', 'ова', 'ову', 'ова', 'овым', 'ове'],
  ['ев', 'ева', 'еву', 'ева', 'евым', 'еве'],
  ['ин', 'ина', 'ину', 'ина', 'иным', 'ине'],
  ['ын', 'ына', 'ыну', 'ына', 'ыным', 'ыне'],
  ['ская', 'ской', 'ской', 'скую', 'скою', 'ской'],
  ['цкая', 'цкой', 'цкой', 'цкую', 'цкою', 'цкой'],
  ['ский', 'ского', 'скому', 'ского', 'ским', 'ском'],
  ['цкий', 'цкого', 'цкому', 'цкого', 'цким', 'цком'],
  ['ая', 'ой', 'ой', 'ую', 'ою', 'ой'],
  ['яя', 'ей', 'ей', 'юю', 'ею', 'ей'],
  ['ый', 'ого', 'ому', 'ого', 'ым', 'ом'],
  ['ой', 'ого', 'ому', 'ого', 'ым', 'ом'],
  ['кий', 'кого', 'кому', 'кого', 'ким', 'ком'],
  ['гий', 'гого', 'гому', 'гого', 'гим', 'гом'],
  ['хий', 'хого', 'хому', 'хого', 'хим', 'хом'],
  ['ий', 'его', 'ему', 'его', 'им', 'ем'],
];
const maleNames = new Set(
  (
    'александр алексей анатолий андрей антон артем артур борис вадим валентин валерий ' +
    'василий виктор владимир владислав вячеслав геннадий георгий григорий даниил денис дмитрий ' +
    'евгений егор иван игорь илья кирилл константин лев леонид максим михаил никита николай ' +
    'олег павел петр роман семен сергей станислав степан тимофей федор юрий ярослав'
  ).split(' '),
);
const femaleNames = new Set(
  (
    'александра алина алиса алла анастасия анна валентина валерия вера вероника ' +
    'виктория галина дарья диана ева евгения екатерина елена елизавета жанна зинаида зоя инна ' +
    'ирина ксения лариса лидия лилия любовь людмила маргарита марина мария надежда наталия ' +
    'наталья нина оксана ольга полина раиса светлана софия софья таисия тамара татьяна юлия яна'
  ).split(' '),
);
const irregular = {
  павел: ['павел', 'павла', 'павлу', 'павла', 'павлом', 'павле'],
  лев: ['лев', 'льва', 'льву', 'льва', 'львом', 'льве'],
  петр: ['петр', 'петра', 'петру', 'петра', 'петром', 'петре'],
  илья: ['илья', 'ильи', 'илье', 'илью', 'ильей', 'илье'],
  любовь: ['любовь', 'любови', 'любови', 'любовь', 'любовью', 'любови'],
};
const consonant = /[бвгджзклмнпрстфхцчшщ]$/u;
function replaceForms(word, suffix, forms) {
  const stem = word.slice(0, -suffix.length);
  return forms.map((ending) => stem + ending);
}
function firstForms(word, gender = '') {
  if (irregular[word]) return irregular[word];
  if (word.endsWith('ия')) return replaceForms(word, 'ия', ['ия', 'ии', 'ии', 'ию', 'ией', 'ии']);
  if (word.endsWith('ья')) return replaceForms(word, 'ья', ['ья', 'ьи', 'ье', 'ью', 'ьей', 'ье']);
  if (word.endsWith('а')) {
    const genitive = /[гкхжчшщ]а$/u.test(word) ? 'и' : 'ы';
    return replaceForms(word, 'а', ['а', genitive, 'е', 'у', 'ой', 'е']);
  }
  if (word.endsWith('я')) return replaceForms(word, 'я', ['я', 'и', 'е', 'ю', 'ей', 'е']);
  if (!maleNames.has(word) && !(gender === 'male' && /[бвгджзйклмнпрстфхцчшщь]$/u.test(word)))
    return Array(6).fill(word);
  if (word.endsWith('ий')) return replaceForms(word, 'ий', ['ий', 'ия', 'ию', 'ия', 'ием', 'ии']);
  if (/[йь]$/u.test(word))
    return replaceForms(word, word.slice(-1), [word.slice(-1), 'я', 'ю', 'я', 'ем', 'е']);
  return [word, word + 'а', word + 'у', word + 'а', word + 'ом', word + 'е'];
}
function firstSearchForms(word, gender = '') {
  return [
    ...new Set(
      givenNameBases(word)
        .filter(
          (base) =>
            !gender ||
            base === word ||
            (gender === 'female' ? !maleNames.has(base) : !femaleNames.has(base)),
        )
        .flatMap((base) => {
          const forms = firstForms(base, gender),
            instrumental = forms[4];
          return [...forms, instrumental.replace(/[ое]й$/u, (ending) => ending[0] + 'ю')];
        }),
    ),
  ];
}
const knownFirstNames = new Set([...maleNames, ...femaleNames, ...shortGivenNames]);
function nameGender(first, middle = '') {
  const normalizedFirst = normalizeName(first),
    normalizedMiddle = normalizeName(middle);
  const genders = new Set(
    givenNameBases(normalizedFirst).flatMap((base) =>
      maleNames.has(base) ? ['male'] : femaleNames.has(base) ? ['female'] : [],
    ),
  );
  const fromFirst = genders.size === 1 ? [...genders][0] : '';
  const fromMiddle = /(?:ович|евич|ич)$/u.test(normalizedMiddle)
    ? 'male'
    : /(?:овна|евна|ична)$/u.test(normalizedMiddle)
      ? 'female'
      : '';
  return fromFirst && fromMiddle && fromFirst !== fromMiddle ? '' : fromFirst || fromMiddle;
}

function surnameForms(word, gender) {
  if (gender === 'female' && /[бвгджзйклмнпрстфхцчшщь]$/u.test(word)) return Array(6).fill(word);
  if (['смородина', 'жемчужина'].includes(word)) return Array(6).fill(word);
  if (word === 'грин' && gender === 'male')
    return [word, word + 'а', word + 'у', word + 'а', word + 'ом', word + 'е'];
  if (/(?:ых|их|енко|ко|[оеиуюэ])$/u.test(word)) return Array(6).fill(word);
  const family = families.find(
    ([suffix]) => word.endsWith(suffix) && word.length > suffix.length + 1,
  );
  if (family) return replaceForms(word, family[0], family);
  if (gender === 'male' && consonant.test(word))
    return [word, word + 'а', word + 'у', word + 'а', word + 'ом', word + 'е'];
  // Stress/origin are not present in the directory: unfamiliar -а/-я/-ь surnames stay exact.
  return Array(6).fill(word);
}
function simpleForms(word, kind, gender) {
  if (kind === 'first') return firstForms(word, gender);
  if (kind === 'middle' && /(?:ович|евич|ич)$/u.test(word))
    return [word, word + 'а', word + 'у', word + 'а', word + 'ем', word + 'е'];
  if (kind === 'middle' && /(?:овна|евна|ична)$/u.test(word))
    return replaceForms(word, 'а', ['а', 'ы', 'е', 'у', 'ой', 'е']);
  return kind === 'last' ? surnameForms(word, gender) : Array(6).fill(word);
}
function nameForms(value, kind, gender = '') {
  const parts = normalizeName(value).split('-');
  if (parts.length > 3) return [normalizeName(value)];
  if (kind === 'first' && parts.length === 1) return firstSearchForms(parts[0], gender);
  const variants = parts.map((word) => simpleForms(word, kind, gender));
  const longInstrumental = variants
    .map((forms) =>
      forms[4] === forms[0] ? forms[4] : forms[4].replace(/[ое]й$/u, (ending) => ending[0] + 'ю'),
    )
    .join('-');
  return [
    ...new Set([
      ...Array.from({ length: 6 }, (_, index) => variants.map((forms) => forms[index]).join('-')),
      longInstrumental,
    ]),
  ];
}
function firstNameKind(word) {
  return knownFirstNames.has(word);
}
function inverseForms(value) {
  const word = normalizeName(value),
    variants = new Set([word]);
  for (const name of knownFirstNames) if (firstSearchForms(name).includes(word)) variants.add(name);
  for (const family of families)
    for (const suffix of family)
      if (word.endsWith(suffix) && word.length > suffix.length + 1)
        variants.add(word.slice(0, -suffix.length) + family[0]);
  for (const ending of ['а', 'у', 'ом', 'ем', 'е'])
    if (word.endsWith(ending)) {
      const stem = word.slice(0, -ending.length);
      if (stem.length >= 3 && consonant.test(stem)) variants.add(stem);
    }
  // First names and patronymics share only these bounded productive endings.
  for (const [ending, suffix] of [
    ['у', 'а'],
    ['ы', 'а'],
    ['е', 'а'],
    ['ой', 'а'],
    ['ю', 'я'],
    ['и', 'я'],
    ['ей', 'я'],
    ['ою', 'а'],
    ['ею', 'я'],
  ])
    if (word.endsWith(ending) && word.length > ending.length + 1)
      variants.add(word.slice(0, -ending.length) + suffix);
  for (const suffix of ['ович', 'евич', 'ич'])
    for (const ending of ['а', 'у', 'ем', 'е'])
      if (word.endsWith(suffix + ending)) variants.add(word.slice(0, -ending.length));
  return [...variants];
}
module.exports = { normalizeName, nameForms, nameGender, firstNameKind, inverseForms };
