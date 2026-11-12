const { bookingDateReading, parseTimeText } = require('../language/time/temporal.cjs');
const { parseDuration } = require('./dialogue-input.cjs');
const { normalizeDayOrdinals } = require('../language/time/spoken-day.cjs');
const { isSlotRequest } = require('../actions/slot-request.cjs');
const { parseBookingTimeWindow } = require('../language/time/booking-time-window.cjs');
const {
  nextWeekdayPhrase,
  normalizeNextWeekdays,
} = require('../language/time/relative-weekday.cjs');
const fields = {
  клиент: 'client',
  клиента: 'client',
  клиентку: 'client',
  пациент: 'client',
  пациента: 'client',
  пациентку: 'client',
  специалист: 'staff',
  специалиста: 'staff',
  сотрудник: 'staff',
  сотрудника: 'staff',
  врач: 'staff',
  врача: 'staff',
  мастер: 'staff',
  мастера: 'staff',
  услуга: 'service',
  услугу: 'service',
  процедура: 'service',
  процедуру: 'service',
  дата: 'date',
  дату: 'date',
  день: 'date',
  время: 'time',
  длительность: 'duration',
  продолжительность: 'duration',
};
const fieldNames = Object.keys(fields).join('|');
const otherWord = '(?:другой|другого|другая|другую|другое)';
const prefix = '(?:(?:поменяй|измени|исправь|замени|изменить|поменять|заменить)\\s+)';
const named = new RegExp(
  '^(?:' + prefix + ')?(' + fieldNames + ')(?=$|[\\s:=])(?:\\s*(?:на(?=\\s)|:|=)\\s*|\\s+)?(.*)$',
  'u',
);
const alternate = new RegExp(
  '^(?:другой|другого|другая|другую|другое)\\s+(' + fieldNames + ')$',
  'u',
);
const otherNamed = new RegExp(
  '^(?:' +
    prefix +
    ')?' +
    otherWord +
    '\\s+(' +
    fieldNames +
    ')(?:\\s*[,=:–—]\\s*|\\s+на\\s+)(.+)$',
  'u',
);
const nextNamed = new RegExp(
  '^(?:' + prefix + ')?(?:' + otherWord + '\\s+)?(?:' + fieldNames + ')(?=$|[\\s:=,–—])',
  'u',
);
const replacementFiller = new RegExp('^' + otherWord + '\\s*(?:[,=:–—]|-\\s)\\s*(?:это\\s+)?', 'u');
const dateFragment = new RegExp(
  '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{1,2}\\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*(?:\\s+\\d{4}(?:\\s+год(?:а|у)?)?)?|послезавтра|позавчера|сегодня|завтра|вчера|через\\s+\\d{1,3}\\s+(?:день|дня|дней)|через\\s+неделю|(?:(?:в|во|на|к|ко)\\s+)?' +
    nextWeekdayPhrase +
    '|(?:понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[ея])(?:\\s+(?:этой|эту)\\s+недел[юи])?)',
  'gu',
);
const ambiguous =
  /(?:^|[\s,;])(?:или|либо|примерно|около|между|приблизительно|не|нет|кроме|исключая)(?=$|[\s,;.!?])/u;
const help = (
  text = 'Уточните исправление одним точным значением: например «поменяй дату на завтра» или «время на 16:30».',
) => ({ kind: 'localHelp', text });
const patch = (edits) => ({ kind: 'patch', edits, confirm: false });
function exactTime(text, timeContext = false) {
  if (
    /[:.]/u.test(text) &&
    !/^(?:в\s+|на\s+)?\d{1,2}[:.]\d{2}(?:\s+(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью))?$/u.test(
      text,
    )
  )
    return null;
  if (/(?:полдень|полночь)/u.test(text) && !/^(?:в\s+|на\s+)?(?:полдень|полночь)$/u.test(text))
    return null;
  return parseTimeText(text, { timeContext });
}
function temporalEdits(
  text,
  clock,
  allowTime = true,
  { timeContext = false, futureMonth = false } = {},
) {
  const source = normalizeNextWeekdays(normalizeDayOrdinals(text)).replace(
    /^(?:на|дату\s+на)\s+/u,
    '',
  );
  const matches = [...source.matchAll(dateFragment)].filter((match) => {
    const before = source[match.index - 1] || ' ',
      after = source[match.index + match[0].length] || ' ';
    return !/[а-я\d]/u.test(before + after);
  });
  if (matches.length > 1)
    return help('Назовите одну дату и одно время. Пока данные записи не изменены.');
  if (matches.length === 1) {
    const match = matches[0];
    // Keep surrounding evidence: an adjacent year must not become a bare clock.
    const { date, dateWeekday, dateProposal } = bookingDateReading(source, clock, { futureMonth });
    if (!date && !dateWeekday && !dateProposal)
      return help('Уточните полную дату. Пока данные записи не изменены.');
    const dateEdit = { field: 'date', text: dateWeekday || dateProposal ? match[0] : date };
    const rest = (source.slice(0, match.index) + ' ' + source.slice(match.index + match[0].length))
      .replace(/^[\s,]+|[\s,]+$/gu, '')
      .replace(/^(?:в|на)\s*$/u, '')
      .replace(/^(?:и\s+)?(?:время\s+(?:на\s+)?)?/u, '')
      .trim();
    if (!rest) return patch([dateEdit]);
    if (isSlotRequest(rest)) return { ...patch([dateEdit]), seekSlots: true };
    const period = parseBookingTimeWindow(rest);
    if (period.status === 'valid' && period.window.kind === 'range' && !period.maskedText.trim())
      return { ...patch([dateEdit]), timeWindow: period.window };
    const time = exactTime(rest, timeContext);
    return time
      ? patch([dateEdit, { field: 'time', text: time }])
      : help(
          'Дату понял. Уточните вместе с ней точное время, например «завтра в 16:30». Пока данные не изменены.',
        );
  }
  const time = allowTime ? exactTime(source, timeContext) : null;
  if (time) return patch([{ field: 'time', text: time }]);
  return /\d{1,2}[:.]\d{2}|полдень|полночь/u.test(source)
    ? help(
        'Уточните только новое время или явно назовите исправляемые поля. Пока данные записи не изменены.',
      )
    : null;
}
function namedOperation(text, clock, { futureMonth = false } = {}) {
  const other = text.match(alternate);
  if (other) return { kind: 'edit', field: fields[other[1]] };
  const match = text.match(named) || text.match(otherNamed);
  if (!match) return null;
  const field = fields[match[1]];
  let value = match[2].trim();
  // A local entity repair must consume one whole value. A second statement or
  // another field cue belongs to the model's atomic multi-field extraction.
  if (
    ['client', 'staff', 'service'].includes(field) &&
    (/[.!?…](?=\s*[\p{L}])/u.test(value) ||
      /(?:^|[\s,;])(?:клиент[а]?|пациент[а]?|сотрудник[а]?|специалист[а]?|услуг[ау]|процедур[ау]|дат[ау]|время|длительность|продолжительность)(?:\s*[:=–—]|\s+(?:поставь|возьмем|выбери|измени|поменяй|на)(?=$|\s))/u.test(
        value,
      ))
  )
    return null;
  // Strip only a structural replacement marker with an explicit separator.
  // A literal title such as «Другая консультация» keeps all its words.
  if (['client', 'staff', 'service'].includes(field))
    value = value.replace(replacementFiller, '').trim();
  if (!value || /^(?:другой|другого|другая|другую|другое)$/u.test(value))
    return { kind: 'edit', field };
  if (/^вместо(?=$|\s)/u.test(value)) {
    const replacement = /^вместо\s+(.+?)\s+на\s+(.+)$/u.exec(value);
    if (
      !replacement ||
      ambiguous.test(replacement[2]) ||
      /(?:^|\s)вместо(?=$|\s)/u.test(replacement[2])
    )
      return help('Назовите одно новое значение поля.');
    value = replacement[2].trim();
  }
  if (['client', 'staff', 'service'].includes(field)) return patch([{ field, text: value }]);
  if (field === 'duration') {
    const answer = value
      .replace(/^(?:(?:приема|процедуры|услуги|записи)(?:\s+|$))?(?:на\s+)?/u, '')
      .trim();
    if (!answer) return { kind: 'edit', field };
    const minutes = parseDuration(answer);
    return minutes
      ? patch([{ field, text: String(minutes) }])
      : help('Назовите точную длительность от 5 до 1440 минут с шагом 5.');
  }
  const operation = temporalEdits(value, clock, true, {
    timeContext: field === 'time',
    futureMonth,
  });
  if (operation?.kind === 'patch' && operation.edits.some((edit) => edit.field === field))
    return operation;
  return help(
    field === 'date'
      ? 'Уточните дату, например «завтра» или полную дату ГГГГ-ММ-ДД.'
      : 'Уточните точное время и часть суток, например «в 16:30» или «два часа дня».',
  );
}
function splitCorrections(text) {
  // Split only before another named field. A service name may itself contain commas or «и».
  const parts = [],
    separator = /\s*(?:,|;|\sи\s)\s*/gu;
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const rest = text.slice(match.index + match[0].length);
    if (nextNamed.test(rest)) {
      parts.push(text.slice(start, match.index));
      start = match.index + match[0].length;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
module.exports = {
  ambiguous,
  help,
  patch,
  temporalEdits,
  namedOperation,
  splitCorrections,
  prefix,
};
