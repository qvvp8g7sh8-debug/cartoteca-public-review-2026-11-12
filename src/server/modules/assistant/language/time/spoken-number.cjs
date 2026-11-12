const units = {
  ноль: 0,
  нуль: 0,
  один: 1,
  одна: 1,
  одну: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
};
const tens = {
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
};
const hundreds = {
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
};
function wordNumber(text) {
  const words = text.split(/\s+/);
  if (words.length > 6) return null;
  if (words.length === 2 && units[words[0]] === 0 && units[words[1]] > 0 && units[words[1]] < 10)
    return units[words[1]];
  let number = 0;
  if (words[0] === 'тысяча') {
    number = 1000;
    words.shift();
  } else if (words[0] === 'одна' && words[1] === 'тысяча') {
    number = 1000;
    words.splice(0, 2);
  }
  if (hundreds[words[0]] !== undefined) number += hundreds[words.shift()];
  if (!words.length) return number;
  if (words.length === 1 && units[words[0]] !== undefined)
    return number && units[words[0]] === 0 ? null : number + units[words[0]];
  if (tens[words[0]] !== undefined) {
    if (words.length === 1) return number + tens[words[0]];
    if (words.length === 2 && units[words[1]] > 0 && units[words[1]] < 10)
      return number + tens[words[0]] + units[words[1]];
  }
  return null;
}
function spokenNumber(value, maximum = 59) {
  const text = String(value).trim().toLowerCase();
  const number = /^\d{1,4}$/.test(text) ? Number(text) : wordNumber(text);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : null;
}
module.exports = { spokenNumber };
