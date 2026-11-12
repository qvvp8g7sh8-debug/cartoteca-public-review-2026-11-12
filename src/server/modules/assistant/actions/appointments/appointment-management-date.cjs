const { wholeDateAnswer } = require('../../language/time/whole-date-answer.cjs');
const {
  monthDateOperation,
  monthDateView,
  dayEvidence,
} = require('../../dialogue/bare-day-proposal.cjs');
const { normalizeDayOrdinals } = require('../../language/time/spoken-day.cjs');
const { validDate } = require('../../interpretation/intent-schema.cjs');
const { combinedManagementTemporal } = require('./appointment-management-temporal.cjs');
const { sourceDayOperation } = require('./appointment-source-selection.cjs');
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
const MONTH = '(?:' + MONTHS.join('|') + ')';
function normalizeDateAnswer(value) {
  let text = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[‐‑‒–—−]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '')
    .replace(/^пожалуйста[, ]+/u, '')
    .replace(/[, ]+пожалуйста$/u, '')
    .replace(/^(?:на|дата|дату) /u, '')
    .trim();
  text = text.replace(/^(\d{1,2})\s*-\s*(го|ое|е)(?=$|[\s.])/u, '$1-$2');
  // Bound the entire answer: no adjacent appointment time or date alternative is
  // discarded while normalizing an ASR digit/month boundary or ordinal period.
  const named = new RegExp(
    '^(\\d{1,2})(?:\\s*-?\\s*(?:го|ое|е))?[\\s.]*(' + MONTH + ')(?:\\s*(\\d{4})(?:\\s+года?)?)?$',
    'u',
  ).exec(text);
  if (named) text = named[1] + ' ' + named[2] + (named[3] ? ' ' + named[3] : '');
  return text;
}
function virtualDateEntry(entry) {
  const m = entry.data.management;
  return {
    step: entry.step,
    data: { dateProposal: m.dateProposal, dateMonthContext: m.dateMonthContext },
    options: new Map(
      [...entry.options].map(([id, row]) => [
        id,
        row.kind === 'managementDateMonth' ? { ...row, kind: 'dateMonth' } : row,
      ]),
    ),
  };
}
function targetDate(date, source, m) {
  return {
    kind: 'target',
    date,
    time: m.targetTime || m.requestedTime || null,
    changedDate: true,
    changedTime: false,
  };
}
function invalidNamedDate(text, clock) {
  const match = new RegExp('^(\\d{1,2}) (' + MONTH + ')(?: (\\d{4})(?: года?)?)?$', 'u').exec(
    normalizeDayOrdinals(text),
  );
  if (!match) return null;
  const date =
    (match[3] || clock.date.slice(0, 4)) +
    '-' +
    String(MONTHS.indexOf(match[2]) + 1).padStart(2, '0') +
    '-' +
    match[1].padStart(2, '0');
  return !validDate(date)
    ? 'Такой даты нет. На какую дату перенести?'
    : date < clock.date
      ? 'Эта дата уже прошла. На какую дату перенести?'
      : null;
}
function sourceDateOperation(entry, text, clock) {
  const day = sourceDayOperation(entry, text);
  if (day) return day;
  const exact = wholeDateAnswer(text, clock);
  if (exact) return { kind: 'sourceFilter', edits: [{ field: 'date', text: exact }] };
  const numberedChoice =
    /^\d{1,2}$/u.test(text) && Number(text) >= 1 && Number(text) <= entry.options.size;
  if (numberedChoice) return null;
  return null;
}
function managementDateOperation(entry, raw, clock, source) {
  const m = entry?.data?.management;
  if (
    !m ||
    !['move', 'edit', 'cancel'].includes(m.operation) ||
    typeof raw !== 'string' ||
    raw.length > 160 ||
    !validDate(clock?.date)
  )
    return null;
  const text = normalizeDateAnswer(raw);
  if (
    entry.step === 'appointment' &&
    !m.source &&
    entry.response?.dialogue?.phase === 'appointmentChoice'
  )
    return sourceDateOperation(entry, text, clock);
  if (m.operation === 'cancel') return null;
  if (!source || !['date', 'time'].includes(entry.step)) return null;
  const combined = combinedManagementTemporal(entry, raw, clock);
  if (combined) return combined;
  const virtual = virtualDateEntry(entry);
  // Normalization removes «на», so retain its proven day meaning before the
  // time-step guard distinguishes a clock from a bare numerical answer.
  if (dayEvidence(raw)?.whole) virtual.step = 'date';
  const day = monthDateOperation(virtual, text, clock);
  if (day) {
    if (day.kind === 'patch' && day.edits.length === 1 && day.edits[0].field === 'date')
      return targetDate(day.edits[0].text, source, m);
    if (['dateMonthPropose', 'dateMonthReject', 'choice', 'localHelp', 'edit'].includes(day.kind))
      return day;
  }
  const exact = wholeDateAnswer(text, clock);
  if (exact) return targetDate(exact, source, m);
  const invalid = invalidNamedDate(text, clock);
  return invalid ? { kind: 'localHelp', text: invalid } : null;
}
function managementDateView(entry, clock) {
  const m = entry.data.management;
  if (!m || !['move', 'edit'].includes(m.operation)) return null;
  const view = monthDateView(
    { dateProposal: m.dateProposal, dateMonthContext: m.dateMonthContext },
    clock,
  );
  return view
    ? { ...view, choices: view.choices.map((row) => ({ ...row, kind: 'managementDateMonth' })) }
    : null;
}
module.exports = { managementDateOperation, managementDateView, normalizeDateAnswer };
