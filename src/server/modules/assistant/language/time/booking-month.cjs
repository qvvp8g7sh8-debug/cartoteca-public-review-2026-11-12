const { validDate } = require('../../interpretation/intent-schema.cjs');

const monthForms = [
  'январ(?:ь|я|е)',
  'феврал(?:ь|я|е)',
  'март(?:а|е)?',
  'апрел(?:ь|я|е)',
  'ма(?:й|я|е)',
  'июн(?:ь|я|е)',
  'июл(?:ь|я|е)',
  'август(?:а|е)?',
  'сентябр(?:ь|я|е)',
  'октябр(?:ь|я|е)',
  'ноябр(?:ь|я|е)',
  'декабр(?:ь|я|е)',
];
const monthAnswerWord = '(?:' + monthForms.join('|') + ')';
const monthAnswer = new RegExp('^(' + monthAnswerWord + ')(?: (\\d{4})(?: года?)?)?$', 'u');

function wholeMonthParts(text) {
  const match = monthAnswer.exec(text);
  if (!match) return null;
  const month = monthForms.findIndex((form) => new RegExp('^' + form + '$', 'u').test(match[1]));
  return { month: month + 1, year: match[2] };
}

function bookingMonthContext(month, year, today) {
  if (!validDate(today) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const yearNumber = Number(today.slice(0, 4)) + Number(month < Number(today.slice(5, 7)));
  const context =
    (year || String(yearNumber).padStart(4, '0')) + '-' + String(month).padStart(2, '0');
  return validDate(context + '-01') ? context : null;
}

function bookingMonthChoice(month, year, today) {
  const context = bookingMonthContext(month, year, today);
  return context
    ? { context, inferredYear: !year && context.slice(0, 4) !== today.slice(0, 4) }
    : null;
}

module.exports = { monthAnswerWord, wholeMonthParts, bookingMonthContext, bookingMonthChoice };
