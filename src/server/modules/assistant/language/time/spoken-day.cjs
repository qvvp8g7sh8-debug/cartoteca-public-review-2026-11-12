const monthWord =
  '(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*';
const ordinals = [
  ['первое', 'первого', 'первый'],
  ['второе', 'второго', 'второй'],
  ['третье', 'третьего', 'третий'],
  ['четвертое', 'четвертого', 'четвертый'],
  ['пятое', 'пятого', 'пятый'],
  ['шестое', 'шестого', 'шестой'],
  ['седьмое', 'седьмого', 'седьмой'],
  ['восьмое', 'восьмого', 'восьмой'],
  ['девятое', 'девятого', 'девятый'],
  ['десятое', 'десятого', 'десятый'],
  ['одиннадцатое', 'одиннадцатого', 'одиннадцатый'],
  ['двенадцатое', 'двенадцатого', 'двенадцатый'],
  ['тринадцатое', 'тринадцатого', 'тринадцатый'],
  ['четырнадцатое', 'четырнадцатого', 'четырнадцатый'],
  ['пятнадцатое', 'пятнадцатого', 'пятнадцатый'],
  ['шестнадцатое', 'шестнадцатого', 'шестнадцатый'],
  ['семнадцатое', 'семнадцатого', 'семнадцатый'],
  ['восемнадцатое', 'восемнадцатого', 'восемнадцатый'],
  ['девятнадцатое', 'девятнадцатого', 'девятнадцатый'],
  ['двадцатое', 'двадцатого', 'двадцатый'],
];
const values = new Map(ordinals.flatMap((forms, index) => forms.map((form) => [form, index + 1])));
for (let index = 0; index < 9; index++)
  for (const form of ordinals[index]) values.set('двадцать ' + form, 21 + index);
for (const form of ['тридцатое', 'тридцатого', 'тридцатый']) values.set(form, 30);
for (const form of ordinals[0]) values.set('тридцать ' + form, 31);
const spoken = new RegExp(
  '(^|[\\s,(])(' +
    [...values.keys()]
      .sort((a, b) => b.length - a.length)
      .map((value) => value.replace(/ /g, '\\s+'))
      .join('|') +
    ')(?=\\s+' +
    monthWord +
    '(?=$|[\\s,.!?]))',
  'gu',
);
const numbered = new RegExp(
  '(^|[\\s,(])(\\d{1,2})-?(?:го|ое|е|й)(?=\\s+' + monthWord + '(?=$|[\\s,.!?]))',
  'gu',
);
function normalizeDayOrdinals(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(spoken, (_, before, word) => before + values.get(word.replace(/\s+/g, ' ')))
    .replace(numbered, '$1$2');
}
const dayOrdinalWord = [...values.keys()]
  .filter((word) => !/(?:ый|ой|ий)$/u.test(word))
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/ /g, '\\s+'))
  .join('|');
module.exports = { normalizeDayOrdinals, monthWord, dayOrdinalWord };
