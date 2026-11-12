const { monthDateOperation } = require('./bare-day-proposal.cjs');
const {
  bookingDateReading,
  parseBookingDateText,
  parseTimeText,
} = require('../language/time/temporal.cjs');
const { isAffirmativeAnswer, isConfirmationAnswer } = require('./affirmative-answer.cjs');
const { serviceChoiceOperation } = require('../language/services/service-suggestions.cjs');
const { parseBookingTimeWindow } = require('../language/time/booking-time-window.cjs');
const { wholeDateAnswer } = require('../language/time/whole-date-answer.cjs');
const { shortWeekdayChoice } = require('./weekday-date-choice.cjs');
function fastBookingOperation(entry, value, clock) {
  if (!entry || typeof value !== 'string' || value.length > 160 || entry.availabilitySearch)
    return null;
  const monthDate = monthDateOperation(entry, value, clock, { booking: true });
  if (monthDate) return monthDate;
  const service = serviceChoiceOperation(entry, value);
  if (service) return service;
  const text = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (entry.response?.dialogue?.phase === 'closedDay') {
    if (
      isConfirmationAnswer(value, 'create') ||
      /^(?:верно|подтверждаю|да,? продолжить)$/u.test(text)
    ) {
      const choice = [...entry.options].find(([, row]) => row.kind === 'closedDayContinue');
      return choice
        ? { kind: 'choice', choice: choice[0] }
        : {
            kind: 'localHelp',
            text: 'Запись вне графика может подготовить владелец или администратор. Выберите другую дату.',
          };
    }
    if (/^(?:нет|другой день|другая дата)$/u.test(text))
      return { kind: 'bookingControl', control: 'otherDate' };
  }
  if (entry.response?.dialogue?.phase === 'period' && isAffirmativeAnswer(value))
    return { kind: 'localHelp' };
  if (
    entry.response?.dialogue?.phase === 'slots' &&
    (isAffirmativeAnswer(value) || /^(?:подойдет|подходит|да,? подойдет|давай)$/u.test(text))
  ) {
    const choices = [...entry.options];
    if (choices.length === 1 && choices[0][1].kind === 'slot')
      return { kind: 'choice', choice: choices[0][0] };
  }
  const control = /^(?:другие варианты|еще варианты|еще окна|еще промежутки|покажи еще|еще)$/u.test(
    text,
  )
    ? entry.response?.dialogue?.phase === 'period'
      ? 'moreRanges'
      : 'moreSlots'
    : /^(?:другой период|поменяй период|измени период)$/u.test(text)
      ? 'otherPeriod'
      : /^(?:другая дата|другой день|ближайшие дни|ближайшая дата)$/u.test(text)
        ? 'otherDate'
        : null;
  if (control) {
    const available = [...(entry.controls || [])].some(([, row]) => row.kind === control);
    return available
      ? { kind: 'bookingControl', control }
      : { kind: 'localHelp', text: 'Уточните дату, период или точное время.' };
  }
  if (entry.step === 'date') {
    const next = shortWeekdayChoice(entry, text, clock);
    if (next) return next;
    if (
      entry.data?.dateWeekday &&
      (isAffirmativeAnswer(value) || /^(?:нет|верно|подтверждаю)$/u.test(text))
    )
      return { kind: 'localHelp' };
    const date = wholeDateAnswer(value, clock, parseBookingDateText);
    if (date) {
      const reading = bookingDateReading(text, clock, { futureMonth: true });
      if (reading.dateProposal?.date === date)
        return { kind: 'dateMonthPropose', proposal: reading.dateProposal };
      const pending = date === clock.date && reading.dateWeekday;
      return { kind: 'patch', edits: [{ field: 'date', text: pending ? text : date }] };
    }
  }
  const period = parseBookingTimeWindow(text);
  if (period.status === 'valid' && !period.maskedText.replace(/[\s,.;!?]/gu, '').trim())
    return { kind: 'timeWindow', window: period.window };
  if (
    clock &&
    /^(?:на |дата )?(?:сегодня|завтра|послезавтра|\d{4}-\d{2}-\d{2}|\d{1,2} (?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?: \d{4}(?: года)?)?)$/u.test(
      text,
    )
  ) {
    const { date, dateProposal } = bookingDateReading(text, clock, { futureMonth: true });
    if (dateProposal) return { kind: 'dateMonthPropose', proposal: dateProposal };
    if (date && date >= clock.date)
      return { kind: 'patch', edits: [{ field: 'date', text: date }] };
  }
  if (
    entry.step === 'time' &&
    /^(?:в |на |к )?(?:[01]?\d|2[0-3])[:.-][0-5]\d(?: (?:утра|дня|вечера|ночи))?$/u.test(text)
  ) {
    const time = parseTimeText(text, { timeContext: true });
    if (time) return { kind: 'patch', edits: [{ field: 'time', text: time }] };
  }
  return null;
}
module.exports = { fastBookingOperation };
