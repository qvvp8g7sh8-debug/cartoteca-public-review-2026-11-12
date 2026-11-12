const { fail } = require('../../../../shared/errors.cjs');
const { help, patch } = require('./dialogue-repair-values.cjs');
const { parseTimeText } = require('../language/time/temporal.cjs');
const { parseDuration } = require('./dialogue-input.cjs');
const ordinals = [
  ['первый', 'первого', 'первую', 'первое'],
  ['второй', 'второго', 'вторую', 'второе'],
  ['третий', 'третьего', 'третью', 'третье'],
  ['четвертый', 'четвертого', 'четвертую', 'четвертое'],
  ['пятый', 'пятого', 'пятую', 'пятое'],
  ['шестой', 'шестого', 'шестую', 'шестое'],
  ['седьмой', 'седьмого', 'седьмую', 'седьмое'],
  ['восьмой', 'восьмого', 'восьмую', 'восьмое'],
  ['девятый', 'девятого', 'девятую', 'девятое'],
  ['десятый', 'десятого', 'десятую', 'десятое'],
  ['одиннадцатый', 'одиннадцатого', 'одиннадцатую', 'одиннадцатое'],
  ['двенадцатый', 'двенадцатого', 'двенадцатую', 'двенадцатое'],
];
const cardinals = [
  'один',
  'одна',
  'одну',
  'два',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
];
function ordinalOperation(entry, text) {
  const match = text.match(
    /^(?:(?:выбери|выбираю|беру|давай|давайте|возьми|хочу|можно|(?:мне\s+)?(?:подойдет|подходит))\s+)?(?:(?:вариант|окно|окошко|номер)\s+(?:номер\s+)?)?([а-я]+|\d{1,2})(?:\s+(?:вариант|окно|окошко))?(?:\s+(?:мне\s+)?(?:подойдет|подходит))?$/u,
  );
  if (!match) return null;
  const word = match[1],
    explicit = /(?:^|\s)(?:вариант|окно|окошко|номер)(?=$|\s)/u.test(text);
  const index = ordinals.findIndex((forms) => forms.includes(word));
  const last = /^(?:последн(?:ий|юю|его|ее)|предпоследн(?:ий|юю|его|ее))$/u.test(word);
  const number = /^\d+$/.test(word),
    cardinal = cardinals.includes(word);
  if (index < 0 && !last && !number && !cardinal) return null;
  if ((number || cardinal) && !explicit && ['time', 'duration'].includes(entry.step)) {
    const value = entry.step === 'time' ? parseTimeText(word) : parseDuration(word);
    return value
      ? patch([{ field: entry.step, text: String(value) }])
      : help(
          'Это время, длительность или номер варианта? Для выбора скажите «второе окно», для времени — «в 14:00».',
        );
  }
  const options = [...(entry.options || new Map()).keys()];
  let position = index;
  if (last) position = options.length - (word.startsWith('пред') ? 2 : 1);
  else if (number) position = Number(word) - 1;
  else if (cardinal)
    position = ['один', 'одна', 'одну'].includes(word)
      ? 0
      : ['два', 'две'].includes(word)
        ? 1
        : [
            'три',
            'четыре',
            'пять',
            'шесть',
            'семь',
            'восемь',
            'девять',
            'десять',
            'одиннадцать',
            'двенадцать',
          ].indexOf(word) + 2;
  if (position < 0 || !options[position])
    throw fail(
      400,
      'Такого варианта сейчас нет. Назовите один из текущих вариантов или уточните данные.',
    );
  return { kind: 'choice', choice: options[position] };
}
module.exports = { ordinalOperation };
