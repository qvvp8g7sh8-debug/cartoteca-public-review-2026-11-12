const { validDate } = require('../../../../../shared/work-schedule.cjs');
const { spokenNumber } = require('../time/spoken-number.cjs');

function groupedPhoneSuffix(text) {
  if (!/^[а-яё\d]+(?:[\s,-]+[а-яё\d]+)*$/u.test(text)) return null;
  const tokens = text.match(/[а-яё\d]+|[,-]/gu);
  let digits = '';
  let hasSpokenGroup = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === ',' || token === '-') continue;
    if (/^\d{1,2}$/u.test(token)) {
      digits += token;
      continue;
    }
    if (!/^[а-яё]+$/u.test(token)) return null;
    const number = spokenNumber(token, 99);
    if (number === null) return null;
    if (number >= 10) hasSpokenGroup = true;
    const next = tokens[index + 1];
    const unit = number >= 20 && next && !/^\d{2,}$/u.test(next) ? spokenNumber(next, 9) : null;
    if (unit !== null && unit > 0) {
      digits += String(number + unit);
      index++;
    } else {
      digits += String(number);
    }
  }
  return hasSpokenGroup && digits.length === 4 ? { kind: 'suffix4', digits } : null;
}

function parseClientPhoneAnswer(raw) {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  const digitWords = {
    ноль: '0',
    нуль: '0',
    один: '1',
    одна: '1',
    два: '2',
    две: '2',
    три: '3',
    четыре: '4',
    пять: '5',
    шесть: '6',
    семь: '7',
    восемь: '8',
    девять: '9',
  };
  const answer = raw
    .trim()
    .toLowerCase()
    .replace(
      /^(?:последние\s+(?:четыре|4|семь|7)\s+цифр[ы]?(?:\s+(?:телефона|номера))?|(?:телефон|номер)\s+заканчивается\s+на)\s*[:—-]?\s*/u,
      '',
    )
    .replace(/[\u2010-\u2015]/gu, '-')
    .replace(/[.!?…]+$/u, '')
    .trim();
  const text = answer.replace(/[а-яё]+/gu, (word) => digitWords[word] ?? word);
  if (!/^\+?[\d\s(),.\-]+$/u.test(text)) return groupedPhoneSuffix(answer);
  const digits = text.replace(/\D/gu, '');
  if (digits.length >= 10 && digits.length <= 15)
    return { kind: 'full', text: (text.startsWith('+') ? '+' : '') + digits };
  if (![4, 7].includes(digits.length) || text.startsWith('+') || /[().]/u.test(text)) return null;
  const groups = text.split(/[\s,-]+/u).filter(Boolean);
  if (groups.length === 3) {
    const [a, b, c] = groups;
    if (
      (a.length <= 2 &&
        b.length <= 2 &&
        c.length === 4 &&
        validDate(c + '-' + b.padStart(2, '0') + '-' + a.padStart(2, '0'))) ||
      (a.length === 4 &&
        b.length <= 2 &&
        c.length <= 2 &&
        validDate(a + '-' + b.padStart(2, '0') + '-' + c.padStart(2, '0')))
    )
      return null;
  }
  return { kind: digits.length === 4 ? 'suffix4' : 'suffix7', digits };
}
module.exports = { parseClientPhoneAnswer };
