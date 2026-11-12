const { readSteps } = require('../read-steps.cjs');
const { appointmentCreateIntent } = require('./appointment-create-request.cjs');
const { detectRequestedOperation } = require('../interpretation/requested-operation.cjs');
const { literalSpan, fold } = require('../interpretation/entity-provenance.cjs');
const { temporalWordsOnly } = require('../language/time/temporal-words.cjs');

// This fallback runs only after the established initial grammar declined.
// A catalog match is a proposal, never a selected entity or cached authority.
const appointmentCreateServiceIntent = readSteps(function* (raw, clock, proveIdentity, catalog) {
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
    /(?:^|[\s,;])(?:не|нет|если|или|либо)(?=$|[\s,;.!?])/iu.test(text)
  )
    return null;
  const before = text.slice(0, requested.operation.start).trim();
  if (before && !/^(?:(?:пожалуйста|можешь|можете)[,\s]*)+$/iu.test(before)) return null;
  const tail = text.slice(requested.operation.end);
  const found = [...tail.matchAll(/(?:^|\s)на\s+(?:(услугу|процедуру)\s+)?/giu)];
  if (!found.length || found.length > 8) return null;
  // Temporal-only framing is already outside this fallback's implicit title
  // grammar. Decline before opening a fresh catalog just to reject it later.
  const relations = found.filter(
    (relation) =>
      relation[1] ||
      !temporalWordsOnly(tail.slice(relation.index + relation[0].length).split(/\s+/u)[0]),
  );
  if (!relations.length) return null;
  const services = yield catalog();
  if (!Array.isArray(services) || services.length > 200) return null;
  let candidate = null;
  for (const relation of relations) {
    const start = requested.operation.end + relation.index;
    const titleStart = start + relation[0].length;
    const source = text.slice(titleStart);
    const spans = new Map();
    for (const service of services) {
      if (typeof service.name !== 'string' || !service.name || service.name.length > 160) continue;
      const span = literalSpan(source, service.name);
      if (!span || !source.startsWith(span) || fold(span) !== fold(service.name)) continue;
      spans.set(span, (spans.get(span) || 0) + 1);
    }
    // The same source span leaves the same command to prove. Keep the number
    // of eligible rows so repeated titles still make a valid parse ambiguous.
    for (const [span, matches] of spans) {
      if (!relation[1]) {
        // A temporal prefix can be meaningful even when the whole title is not
        // a supported date clause (for example a date followed by a day period).
        // Such catalog titles require the explicit service-role label.
        if (temporalWordsOnly(span.trim().split(/\s+/u)[0])) continue;
        const temporal = yield appointmentCreateIntent('Запиши ' + span, clock, () => false);
        if (temporal && ['date', 'time', 'duration'].some((key) => temporal[key] !== undefined))
          continue;
      }
      const rest = text.slice(0, start) + ' ' + source.slice(span.length);
      const base = yield appointmentCreateIntent(rest, clock, proveIdentity);
      if (!base) continue;
      if (candidate || matches > 1) return null;
      candidate = { ...base, serviceQuery: span };
    }
  }
  return candidate;
});
module.exports = { appointmentCreateServiceIntent };
