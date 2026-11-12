const { entityText, literalSpan } = require('../../interpretation/entity-provenance.cjs');
const { expandClientSource } = require('../../language/names/client-source-span.cjs');
const { temporalWordsOnly } = require('../../language/time/temporal-words.cjs');
const { parseBookingTimeWindow } = require('../../language/time/booking-time-window.cjs');

// A leading «Нет,» can acknowledge a correction. Remove only that prefix after
// every entity span and the entire remaining positive clause have source proof.
// Directory matching, ambiguity and permissions retain their existing guards.
function positiveReplacementSource(raw, fields) {
  const source = String(raw || '');
  const prefix = /^\s*нет(?:\s*[,;.!?:…\p{Pd}\u2212]{1,3}\s*|\s+)/iu.exec(source);
  if (!prefix) return null;
  const candidate = ' '.repeat(prefix[0].length) + source.slice(prefix[0].length);
  if (
    /(?:^|[\s,;])(?:не|нет|или|либо|если|кроме|исключая|вместо|примерно|около|между)(?=$|[\s,.!?;])/iu.test(
      candidate,
    )
  )
    return null;
  const proven = {};
  for (const field of ['client', 'staff', 'service']) {
    if (fields[field] === null) continue;
    proven[field] = entityText(candidate, fields[field], field);
    if (!proven[field]) return null;
  }
  if (!Object.keys(proven).length) return null;
  const window = parseBookingTimeWindow(candidate);
  if (proven.client) {
    proven.client = expandClientSource(
      window.status === 'valid' ? window.maskedText : candidate,
      proven.client,
      {
        serviceQuery: proven.service,
        staffQuery: proven.staff,
      },
    );
    if (!proven.client) return null;
  }
  let remainder = candidate;
  for (const value of Object.values(proven)) {
    const span = literalSpan(remainder, value);
    if (!span) return null;
    const at = remainder.indexOf(span);
    remainder =
      remainder.slice(0, at) + ' '.repeat(span.length) + remainder.slice(at + span.length);
  }
  remainder = remainder.replace(
    /(?:^|[\s,;])(?:клиент(?:а|ку)?|пациент(?:а|ку)?|сотрудник(?:а)?|специалист(?:а)?|мастер(?:а)?|врач(?:а)?|услуг[ау]|процедур[ау]|дат[ау]|длительность|продолжительность|к|ко|у|для|и|пожалуйста|давайте)(?=$|[\s,.!?;])/giu,
    (whole) => ' '.repeat(whole.length),
  );
  const remainingWindow = parseBookingTimeWindow(remainder);
  return temporalWordsOnly(remainingWindow.maskedText.replace(/;/gu, ' ')) ? candidate : null;
}

module.exports = { positiveReplacementSource };
