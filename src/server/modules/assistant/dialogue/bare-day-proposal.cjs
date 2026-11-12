const { containsCardCommand } = require('../interpretation/client-card-grammar.cjs');
const { validDate } = require('../interpretation/intent-schema.cjs');
const {
  normalizeDayOrdinals,
  monthWord,
  dayOrdinalWord,
} = require('../language/time/spoken-day.cjs');
const { isAffirmativeAnswer } = require('./affirmative-answer.cjs');
const {
  monthAnswerWord,
  wholeMonthParts,
  bookingMonthChoice,
} = require('../language/time/booking-month.cjs');
const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const DAY_NAMES = [
  '',
  'первого',
  'второго',
  'третьего',
  'четвёртого',
  'пятого',
  'шестого',
  'седьмого',
  'восьмого',
  'девятого',
  'десятого',
  'одиннадцатого',
  'двенадцатого',
  'тринадцатого',
  'четырнадцатого',
  'пятнадцатого',
  'шестнадцатого',
  'семнадцатого',
  'восемнадцатого',
  'девятнадцатого',
  'двадцатого',
];
const fold = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim();
const unsafe =
  /(?:^|[\s,;(])(?:не|нет|или|либо|если|примерно|около|между|кроме|исключая|точнее|вернее|вместо|после|до|по|с)(?=$|[\s,;:.)!?])/u;
const ordinal = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:' + dayOrdinalWord + '|\\d{1,2}-?(?:го|ое|е))(?=$|[\\s,.!?;)])',
  'gu',
);
const numbered = /(?<![\p{L}\p{N}])(\d{1,2})\s+числ[ао](?=$|[\s,.!?;)])/gu;
const month = new RegExp(
  '(?:^|[\\s,(])(?:' + monthWord + '|' + monthAnswerWord + ')(?=$|[\\s,.!?;)])',
  'u',
);
const otherDate =
  /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}|(?:^|\s)(?:сегодня|завтра|послезавтра|вчера|позавчера|через|понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[ея])(?=$|[\s,.!?])/u;
function dayEvidence(value, { dateStep = false } = {}) {
  if (typeof value !== 'string' || value.length > 4000) return null;
  const text = fold(value);
  if (unsafe.test(text) || month.test(text) || otherDate.test(text)) return null;
  if (dateStep) {
    const numeric = /^(?:(?:на|дата) )?(\d{1,2})[.!?…]?$/u.exec(text);
    if (numeric) {
      const day = Number(numeric[1]);
      return day >= 1 && day <= 31 ? { day, whole: true } : null;
    }
  }
  const matches = [...text.matchAll(ordinal), ...text.matchAll(numbered)]
    .sort((left, right) => left.index - right.index)
    .filter(
      (item, index, rows) =>
        !index || item.index >= rows[index - 1].index + rows[index - 1][0].length,
    );
  if (matches.length !== 1) return null;
  const match = matches[0],
    converted = normalizeDayOrdinals(match[0].replace(/\s+числ[ао]$/u, '') + ' января'),
    day = Number(/^(\d{1,2}) января$/u.exec(converted)?.[1]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const rest = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length))
    .replace(/(?<![\p{L}\p{N}])числ[ао](?![\p{L}\p{N}])/gu, '')
    .replace(/[,.!?;()]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const whole = /^(?:(?:пожалуйста|дат[ау]|день|на)\s*)*$/u.test(rest);
  const explicit =
    /(?:^|[\s,(])(?:на|дат[ау]|день)\s*$/u.test(text.slice(0, match.index)) ||
    /^\s+числ[ао](?=$|[\s,.!?;)])/u.test(text.slice(match.index + match[0].length)) ||
    /числ[ао]$/u.test(match[0]);
  return whole || explicit ? { day, whole } : null;
}
function dateInMonth(day, context) {
  const date = context + '-' + String(day).padStart(2, '0');
  return validDate(date) ? date : null;
}
function bareDayProposal(value, clock) {
  const evidence = dayEvidence(value);
  if (!evidence || !validDate(clock?.date)) return null;
  return { day: evidence.day, date: dateInMonth(evidence.day, clock.date.slice(0, 7)) };
}
function dateLabel(date, clock, includeYear = date.slice(0, 4) !== clock.date.slice(0, 4)) {
  const day = Number(date.slice(8)),
    name =
      DAY_NAMES[day] ||
      (day < 30
        ? 'двадцать ' + DAY_NAMES[day - 20]
        : day === 30
          ? 'тридцатого'
          : 'тридцать первого'),
    year = includeYear ? ' ' + date.slice(0, 4) + ' года' : '';
  return name[0].toUpperCase() + name.slice(1) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + year;
}
function validProposal(value) {
  return (
    value &&
    Number.isInteger(value.day) &&
    value.day >= 1 &&
    value.day <= 31 &&
    (value.date === null || (validDate(value.date) && Number(value.date.slice(8)) === value.day))
  );
}
function monthDateView(data, clock) {
  const proposal = data.dateProposal;
  if (!validProposal(proposal)) {
    const context = data.dateMonth?.context;
    if (!validDate(context + '-01')) return null;
    const name = MONTHS[Number(context.slice(5, 7)) - 1];
    const year = data.dateMonth.inferredYear ? ' ' + context.slice(0, 4) + ' года' : '';
    return {
      step: 'date',
      phase: 'date',
      prompt:
        context < clock.date.slice(0, 7)
          ? 'Этот месяц уже прошёл. Назовите другой месяц или дату.'
          : 'На какое число ' + name + year + ' записать?',
      input: { type: 'text', field: 'date' },
      choices: [],
    };
  }
  const past = Boolean(proposal.date && proposal.date < clock.date);
  const context = proposal.month?.context || data.dateMonthContext || clock.date.slice(0, 7);
  const label = proposal.date ? dateLabel(proposal.date, clock, proposal.month?.inferredYear) : '';
  const invalid = !proposal.date && !dateInMonth(proposal.day, context);
  const monthName = [
    'январе',
    'феврале',
    'марте',
    'апреле',
    'мае',
    'июне',
    'июле',
    'августе',
    'сентябре',
    'октябре',
    'ноябре',
    'декабре',
  ][Number(context.slice(5, 7)) - 1];
  const prompt = past
    ? Number(proposal.date.slice(8)) +
      ' ' +
      MONTHS[Number(proposal.date.slice(5, 7)) - 1] +
      ' уже прошло. Назовите другую дату.'
    : proposal.date
      ? label + ', верно?'
      : invalid
        ? 'В ' +
          monthName +
          ' нет ' +
          proposal.day +
          '-го числа. ' +
          (proposal.month ? 'Назовите другое число или месяц.' : 'Какого месяца?')
        : proposal.month
          ? 'Назовите другое число или месяц.'
          : 'Какого месяца?';
  return {
    step: 'date',
    phase: 'date',
    prompt,
    input: { type: 'text', field: 'date' },
    choices:
      proposal.date && !past
        ? [
            {
              kind: 'dateMonth',
              value: proposal.date,
              day: proposal.day,
              label,
            },
          ]
        : [],
  };
}
function legacyMonthDate({ month, year }, day, clock) {
  let number = Number(year || clock.date.slice(0, 4));
  let context = String(number).padStart(4, '0') + '-' + String(month).padStart(2, '0');
  let date = dateInMonth(day, context);
  if (!year && date && date < clock.date) {
    context = String(++number).padStart(4, '0') + '-' + String(month).padStart(2, '0');
    date = dateInMonth(day, context);
  }
  return date && date >= clock.date ? date : null;
}
function bookingMonthDayProposal(day, month, clock) {
  if (!month) return null;
  const date = dateInMonth(day, month.context);
  return date && date >= clock.date ? { day, date, month } : null;
}
function monthDateOperation(entry, value, clock, { booking = false } = {}) {
  if (
    !entry ||
    entry.availabilitySearch ||
    typeof value !== 'string' ||
    value.length > 160 ||
    !validDate(clock?.date)
  )
    return null;
  const pending = validProposal(entry.data?.dateProposal) ? entry.data.dateProposal : null;
  const text = fold(value)
    .replace(/[.!?…]+$/u, '')
    .trim();
  if (pending) {
    if (isAffirmativeAnswer(value) && pending.date) {
      if (pending.date < clock.date)
        return { kind: 'localHelp', text: monthDateView(entry.data, clock).prompt };
      const current = [...entry.options].find(
        ([, row]) =>
          row.kind === 'dateMonth' && row.value === pending.date && row.day === pending.day,
      );
      return current ? { kind: 'choice', choice: current[0] } : null;
    }
    if (/^(?:нет|неверно|неправильно|другой месяц)$/u.test(text))
      return { kind: 'dateMonthReject' };
    if (/^(?:другая дата|другой день)$/u.test(text)) return { kind: 'edit', field: 'date' };
  }
  if (pending || (booking && entry.step === 'date')) {
    const named = wholeMonthParts(text.replace(/^(?:нет[, ]+)?(?:в|на)?\s*/u, ''));
    if (named) {
      if (!booking) {
        const date = legacyMonthDate(named, pending.day, clock);
        if (date) return { kind: 'patch', edits: [{ field: 'date', text: date }] };
      } else {
        const month = bookingMonthChoice(named.month, named.year, clock.date);
        if (month && !pending) return { kind: 'dateMonthSelect', month };
        const proposal = pending && bookingMonthDayProposal(pending.day, month, clock);
        if (proposal) return { kind: 'dateMonthPropose', proposal };
        if (pending)
          return {
            kind: 'dateMonthPropose',
            proposal: { day: pending.day, date: null, ...(month ? { month } : {}) },
            message: 'Такой даты нет или она уже прошла.',
          };
      }
      return {
        kind: 'localHelp',
        text: 'Такой даты нет или она уже прошла. Назовите другую дату.',
      };
    }
  }
  const evidence = dayEvidence(value, { dateStep: entry.step === 'date' });
  if (!evidence?.whole) return null;
  if (entry.step !== 'date' && !/(?:^|\s)(?:на|дат[ау]|день|числ[ао])(?=$|\s)/u.test(fold(value)))
    return null;
  const selectedMonth = entry.data?.dateMonth || pending?.month;
  if (booking && selectedMonth) {
    const proposal = bookingMonthDayProposal(evidence.day, selectedMonth, clock);
    return proposal
      ? { kind: 'dateMonthPropose', proposal }
      : {
          kind: 'dateMonthPropose',
          proposal: { day: evidence.day, date: null, month: selectedMonth },
          message: 'В этом месяце нет такой будущей даты.',
        };
  }
  const context = entry.data?.dateMonthContext;
  if (/^\d{4}-\d{2}$/u.test(context || '')) {
    const date = contextualDayDate(evidence, entry.data, clock);
    return date
      ? { kind: 'patch', edits: [{ field: 'date', text: date }] }
      : {
          kind: 'dateMonthPropose',
          proposal: { day: evidence.day, date: null },
          message: 'В этом месяце нет такой будущей даты. Какого месяца?',
        };
  }
  const proposal = { day: evidence.day, date: dateInMonth(evidence.day, clock.date.slice(0, 7)) };
  return { kind: 'dateMonthPropose', proposal };
}
function dayTurnConstraints(entry, value, clock) {
  if (!entry || entry.availabilitySearch || !validDate(clock?.date)) return null;
  const text = fold(value);
  if (
    /(?:^|[\s,;])(?:удал|отправ|оплат|сохран|созда|добав|выполн|запуст|включ|выключ|обнов|закр|переключ)[а-я]*(?=$|[\s,.!?])/u.test(
      text,
    ) ||
    containsCardCommand(text) ||
    /(?:^|\s)(?:покажи|открой|найди|посмотри)\s+(?:мне\s+)?(?:клиентов|календарь|расписание)(?=$|[\s,.!?])/u.test(
      text,
    )
  )
    return null;
  const evidence = dayEvidence(value, { dateStep: entry.step === 'date' });
  if (!evidence) return null;
  const selectedMonth = entry.data?.dateMonth || entry.data?.dateProposal?.month;
  if (selectedMonth) {
    const proposal = bookingMonthDayProposal(evidence.day, selectedMonth, clock);
    return proposal ? { date: null, dateProposal: proposal } : null;
  }
  const context = entry.data?.dateMonthContext || clock.date.slice(0, 7);
  const date = dateInMonth(evidence.day, context);
  if (entry.data?.dateMonthContext && date && date >= clock.date) return { date };
  return { date: null, dateProposal: { day: evidence.day, date } };
}
function inheritMonthContext(proof, date) {
  if (!validDate(date) || !validProposal(proof.dateProposal)) return proof;
  const proposal = proof.dateProposal;
  if (proposal.month) return proof;
  const inherited = dateInMonth(proposal.day, date.slice(0, 7));
  const result = { ...proof };
  if (inherited && (!proposal.date || inherited >= proposal.date)) {
    result.date = inherited;
    delete result.dateProposal;
  } else {
    result.date = null;
    result.dateProposal = { day: proposal.day, date: null };
  }
  return result;
}
function bareDaySignal(value) {
  const text = fold(value);
  if (month.test(text)) return false;
  if ([...text.matchAll(numbered)].length) return true;
  return [...text.matchAll(ordinal)].some(
    (match) =>
      /(?:^|[\s,(])(?:на|дат[ау]|день)\s*$/u.test(text.slice(0, match.index)) ||
      /^\s+числ[ао](?=$|[\s,.!?;)])/u.test(text.slice(match.index + match[0].length)) ||
      /^[\s,.!?]*$/u.test(text.slice(0, match.index) + text.slice(match.index + match[0].length)),
  );
}
function contextualDayDate(proposal, data, clock) {
  const context = data?.dateMonthContext;
  if (!/^\d{4}-\d{2}$/u.test(context || '')) return null;
  const date = dateInMonth(proposal.day, context);
  return date && date >= clock.date ? date : null;
}
module.exports = {
  dayEvidence,
  bareDaySignal,
  bareDayProposal,
  monthDateView,
  monthDateOperation,
  validProposal,
  contextualDayDate,
  bookingMonthDayProposal,
  inheritMonthContext,
  dayTurnConstraints,
};
