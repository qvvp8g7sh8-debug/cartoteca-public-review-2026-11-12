const { readSteps } = require('./../read-steps.cjs');
const { detectRequestedOperation } = require('../interpretation/requested-operation.cjs');
const { wholeIdentity } = require('./client-read-request.cjs');
const { parseDateText, parseTimeText } = require('../language/time/temporal.cjs');
const { temporalWordsOnly } = require('../language/time/temporal-words.cjs');
const { parseDuration } = require('../language/time/spoken-duration.cjs');
const { monthWord } = require('../language/time/spoken-day.cjs');
const {
  monthAnswerWord,
  wholeMonthParts,
  bookingMonthChoice,
} = require('../language/time/booking-month.cjs');
const { nextWeekdayPhrase } = require('../language/time/relative-weekday.cjs');
// This is only a whole-clause boundary; the established temporal helper owns
// weekday arithmetic against the supplied organization clock.
const weekdayClause = new RegExp(
  '^(?:(?:на|в)\\s+)?(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|' +
    nextWeekdayPhrase +
    ')(?=$|[\\s,;])',
  'iu',
);
const dateClause = new RegExp(
  '^(?:(?:на|в)\\s+)?(?:сегодня|завтра|послезавтра|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{1,2}\\s+(?:' +
    monthWord +
    ')\\s+\\d{4}(?:\\s+года?)?)(?=$|[\\s,;])',
  'iu',
);
const monthClause = new RegExp(
  '^(?:на|в)\\s+(' + monthAnswerWord + '(?:\\s+\\d{4}(?:\\s+года?)?)?)(?=$|[\\s,;])',
  'iu',
);
const clockClause = /^(?:(?:в|на|к)\s+)?(?:[01]?\d|2[0-3]):[0-5]\d(?=$|[\s,;])/iu;
const meridiemClause =
  /^(?:в|к)\s+(?:(?:[1-9]|1[0-2]|один|два|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)(?:\s+час(?:а|ов)?)?\s+(?:утра|утром|дня|днем|вечера|вечером|ночи|ночью)|полдень|полночь)(?=$|[\s,;])/iu;
const forbidden =
  /(?:^|[\s,;:])(?:не|нет|если|или|либо|кроме|вместо|все|всех|кажд[а-я]*|срочно|побыстрее|скорее|быстрее|желательно|обязательно|повторно|снова|обычно|возможности|сразу|дополнительно|сохрани(?:те)?|сохранить|отправь(?:те)?|отправить)(?=$|[\s,;:.!?])/iu;
const clean = (value) => value.trim().replace(/^[,;\s]+|[,;\s]+$/gu, '');
function durationClause(text) {
  const prefix = /^(?:на|длительностью)\s+/iu.exec(text);
  if (!prefix) return null;
  const words = text.slice(prefix[0].length).split(/\s+/u);
  for (let count = Math.min(6, words.length); count > 0; count--) {
    const source = words.slice(0, count).join(' ').replace(/[,;]$/u, '');
    // Bare numbers may be dates or clocks; duration requires its own explicit unit.
    if (!/(?:мин(?:ут(?:а|ы|у)?)?\.?|час(?:а|ов)?|полчаса)$/iu.test(source)) continue;
    const value = parseDuration(source);
    const clause = prefix[0] + source;
    // Established grammar also reads 'на один час' as13:00. Keep every
    // clock/duration ambiguity on the existing model/clarification path.
    if (value !== null && parseTimeText(clause) === null) return { source: clause, value };
  }
  return null;
}
function temporalFields(value, clock) {
  let tail = clean(value);
  const fields = {};
  while (tail) {
    let source, field, parsed;
    const date = dateClause.exec(tail) || weekdayClause.exec(tail),
      month = !date && monthClause.exec(tail),
      time = clockClause.exec(tail) || meridiemClause.exec(tail);
    if (date || month) {
      source = (date || month)[0];
      field = 'date';
      parsed = date ? parseDateText(source, clock) : null;
    } else if (time) {
      source = time[0];
      field = 'time';
      parsed = parseTimeText(source);
    } else {
      const duration = durationClause(tail);
      if (!duration) return null;
      source = duration.source;
      field = 'duration';
      parsed = duration.value;
    }
    if ((!month && parsed == null) || Object.hasOwn(fields, field)) return null;
    if (month) {
      const named = wholeMonthParts(month[1].toLowerCase().replace(/\s+/gu, ' '));
      fields.dateMonth = bookingMonthChoice(named.month, named.year, clock.date);
      if (!fields.dateMonth) return null;
    }
    fields[field] = parsed;
    tail = clean(tail.slice(source.length));
  }
  return fields;
}
function literalIdentity(value) {
  const text = clean(value);
  if (!text) return '';
  if (/[,;]/u.test(text) || /(?:^|\s)(?:и|а)(?=$|\s)/iu.test(text)) return null;
  if (/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4}/u.test(text)) return null;
  // A calendar/duration word cannot silently become part of a person's surname.
  if (/\p{L}/u.test(text) && text.split(/\s+/u).some((word) => temporalWordsOnly(word)))
    return null;
  return wholeIdentity(text);
}
// Only a fully consumed initial request can skip interpretation. These values
// remain proposals: existing fresh ACL, entity proofs, clarifications and manual
// saving still own every domain action. Unknown syntax keeps the model path.
const appointmentCreateIntent = readSteps(
  function* appointmentCreateIntent(raw, clock, proveIdentity) {
    if (typeof raw !== 'string' || raw.length > 512 || /[\r\n\u0000-\u001f\u007f]/u.test(raw))
      return null;
    const text = raw
      .normalize('NFKC')
      .trim()
      .replace(/[.!?…]+$/u, '')
      .trim();
    const requested = detectRequestedOperation(text);
    if (
      requested.intent !== 'prepareAppointment' ||
      requested.negated ||
      requested.ambiguous ||
      requested.sameAppointmentSave ||
      forbidden.test(text)
    )
      return null;
    const before = text.slice(0, requested.operation.start).trim();
    if (before && !/^(?:(?:пожалуйста|можешь|можете)[,\s]*)+$/iu.test(before)) return null;
    const source = clean(text.slice(requested.operation.end))
      .replace(/[,\s]+пожалуйста$/iu, '')
      .trim();
    const explicitClient =
      /^(?:для\s+)?(?:клиента|клиентку|клиентки|пациента|пациентку|пациентки)(?=$|\s)/iu.test(
        source,
      );
    const tail = source.replace(
      /^(?:(?:клиента|клиентку|клиентки|пациента|пациентку|пациентки|для)(?:\s+|$))+/iu,
      '',
    );
    const words = tail ? tail.split(/\s+/u) : [];
    if (words.length > 32) return null;
    const candidates = new Map();
    for (let split = 0; split <= words.length; split++) {
      const query = literalIdentity(words.slice(0, split).join(' '));
      if (query === null) continue;
      const fields = temporalFields(words.slice(split).join(' '), clock);
      if (!fields) continue;
      const intent = { intent: 'prepareAppointment', ...(query ? { query } : {}), ...fields };
      candidates.set(JSON.stringify(intent), intent);
    }
    if (candidates.size !== 1) return null;
    const intent = [...candidates.values()][0];
    // Bare words can denote a service as easily as a surname. Only the existing
    // ACL-aware directory may prove implicit names; do not guess from suffixes.
    // Its result is not reused by the action: normal fresh resolution still runs.
    if (
      intent.query &&
      !explicitClient &&
      /\p{L}/u.test(intent.query) &&
      !(yield proveIdentity?.(intent.query))
    )
      return null;
    return intent;
  },
);
module.exports = { appointmentCreateIntent };
