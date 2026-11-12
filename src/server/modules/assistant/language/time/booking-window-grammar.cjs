const { parseTimeText } = require('./temporal.cjs');
const { spokenNumber } = require('./spoken-number.cjs');
const part = '(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)';
const hour =
  '(?:\\d{1,3}(?:[:.]\\d{1,3})?|полудня|полуночи|час|один|одного|дв[ае]|двух|три|трех|четыре|четырех|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти|одиннадцать|одиннадцати|двенадцать|двенадцати|тринадцать|тринадцати|четырнадцать|четырнадцати|пятнадцать|пятнадцати|шестнадцать|шестнадцати|семнадцать|семнадцати|восемнадцать|восемнадцати|девятнадцать|девятнадцати|двадцать(?:\\s+(?:один|два|три))?)';
const endpoint = hour + '(?:\\s+час(?:а|ов)?)?(?:\\s+' + part + ')?';
const edge = '(?![\\p{L}\\p{N}:]|[.-]\\d)';
const cue = '(?<![\\p{L}\\p{N}])';
function normalizeNumericRanges(value) {
  const number = '\\d{1,3}(?:[:.]\\d{1,3})?';
  return value
    .replace(
      new RegExp(cue + '(с|от)\\s*(' + number + ')\\s*(до|по)\\s*(' + number + ')' + edge, 'gu'),
      (_, fromWord, from, toWord, to) => fromWord + ' ' + from + ' ' + toWord + ' ' + to,
    )
    .replace(
      new RegExp(cue + 'между\\s*(' + number + ')\\s*и\\s*(' + number + ')' + edge, 'gu'),
      (_, from, to) => 'между ' + from + ' и ' + to,
    );
}
function readClock(value, end = false) {
  const text = value.trim().replace(/\s+час(?:а|ов)?(?=$|\s)/u, '');
  if (end && /^24(?::00)?$/u.test(text)) return '24:00';
  const genitives = {
    одного: 'один',
    двух: 'два',
    трех: 'три',
    четырех: 'четыре',
    пяти: 'пять',
    шести: 'шесть',
    семи: 'семь',
    восьми: 'восемь',
    девяти: 'девять',
    десяти: 'десять',
    одиннадцати: 'одиннадцать',
    двенадцати: 'двенадцать',
    тринадцати: 'тринадцать',
    четырнадцати: 'четырнадцать',
    пятнадцати: 'пятнадцать',
    шестнадцати: 'шестнадцать',
    семнадцати: 'семнадцать',
    восемнадцати: 'восемнадцать',
    девятнадцати: 'девятнадцать',
  };
  if (text === 'полудня') return '12:00';
  if (text === 'полуночи') return end ? '24:00' : '00:00';
  return parseTimeText(text.replace(/[а-я]+/gu, (word) => genitives[word] || word));
}
function clockWord(value) {
  return (
    /^\d{1,3}(?::\d{1,3})?$/u.test(value) ||
    readClock(value) !== null ||
    spokenNumber(value, 100000) !== null ||
    /^(?:двумя|тремя|четырьмя|двадцат[иью]|тридцат[иью]|сорока|пятидесяти|шестидесяти|семидесяти|восьмидесяти|девяноста)$/u.test(
      value,
    )
  );
}
function clockTail(value) {
  const token = /^\s+([а-я]+)/u.exec(value)?.[1];
  return token && clockWord(token);
}
module.exports = { endpoint, edge, cue, readClock, clockWord, clockTail, normalizeNumericRanges };
