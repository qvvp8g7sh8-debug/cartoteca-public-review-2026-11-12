const { literalSpan } = require('../../interpretation/entity-provenance.cjs');
const { temporalWordsOnly } = require('../../language/time/temporal-words.cjs');
const { repairOperation, relativeOperation } = require('../../dialogue/dialogue-repair-parse.cjs');
const { sourceServiceQuery, sourceStaffQuery } = require('./appointment-source-selection.cjs');
const {
  bookingTemporalConstraints,
} = require('../../language/time/booking-temporal-constraints.cjs');
function temporalPatch(text, clock) {
  if (!text.trim() || !temporalWordsOnly(text)) return null;
  const parsed = repairOperation({ step: 'time', data: {}, options: new Map() }, text, clock);
  return parsed?.kind === 'patch' &&
    parsed.edits.every((edit) => ['date', 'time'].includes(edit.field))
    ? parsed
    : null;
}
function sourceTemporalProof(text, clock) {
  if (!text.trim() || !temporalWordsOnly(text)) return null;
  const proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, text, clock);
  return ['date', 'time', 'timeWindow'].some((field) => Object.hasOwn(proof, field)) ? proof : null;
}
function serviceClause(value, clock) {
  for (const match of value.matchAll(/(?:^|\s)на\s+(?:услугу\s+)?/giu)) {
    const prefix = value.slice(0, match.index),
      tail = value
        .slice(match.index + match[0].length)
        .replace(/[.!?]+$/u, '')
        .trim();
    if (!tail || temporalWordsOnly(tail.split(/\s/u)[0])) continue;
    const words = tail.split(/\s+/u);
    let service = tail,
      rest = '';
    for (let index = 1; index < words.length; index++) {
      const temporal = words.slice(index).join(' ');
      if (
        temporalWordsOnly(temporal) &&
        (sourceTemporalProof(temporal, clock) ||
          relativeOperation(temporal)?.kind ||
          /^(?:на |в )?то же время$/iu.test(temporal))
      ) {
        service = words.slice(0, index).join(' ');
        rest = temporal;
        break;
      }
    }
    if (
      !sourceServiceQuery(service) ||
      /[,;:]/u.test(service) ||
      /(?:^|\s)(?:поменяй|измени|отправь|удали|сохрани|сотрудник[а-я]*|специалист[а-я]*|врач[а-я]*|мастер[а-я]*|друг[а-я]*)(?=$|[\s.!?])/iu.test(
        service,
      )
    )
      continue;
    return { service, head: (prefix + ' ' + rest).trim() };
  }
  return null;
}
function maskManagementEntities(intent, raw) {
  let text = String(raw || '');
  for (const [key, prefix] of [
    ['query', null],
    ['serviceQuery', /(?:^|\s)на\s+(?:услугу\s+)?$/iu],
    [
      'staffQuery',
      /(?:^|\s)(?:у\s+(?:(?:сотрудника|специалиста|врача|мастера)\s+)?|(?:сотрудник|специалист|врач|мастер)\s+)$/iu,
    ],
  ]) {
    const span = literalSpan(text, intent[key]);
    if (!span) continue;
    const at = text.indexOf(span),
      before = text.slice(0, at),
      role = prefix?.exec(before);
    const start = role ? role.index : at;
    text =
      text.slice(0, start) + ' '.repeat(at + span.length - start) + text.slice(at + span.length);
  }
  return text;
}
function staffClause(value, clock) {
  const match =
    /(?:^|\s)(?:у\s+(?:(?:сотрудника|специалиста|врача|мастера)\s+)?|(?:сотрудник|специалист|врач|мастер)\s+)(.+)$/iu.exec(
      value,
    );
  if (!match) return null;
  const words = match[1]
    .replace(/[.!?]+$/u, '')
    .trim()
    .split(/\s+/u);
  let staff = words.join(' '),
    rest = '';
  for (let split = 1; split < words.length; split++) {
    const tail = words.slice(split).join(' ');
    if (
      temporalWordsOnly(tail) &&
      (sourceTemporalProof(tail, clock) ||
        relativeOperation(tail)?.kind ||
        /^(?:на |в )?то же время$/iu.test(tail))
    ) {
      staff = words.slice(0, split).join(' ');
      rest = tail;
      break;
    }
  }
  return sourceStaffQuery('у ' + staff)
    ? { staff, head: (value.slice(0, match.index) + ' ' + rest).trim() }
    : null;
}
function sourceFilterComposition(raw, clock, temporalOnly = false) {
  if (
    /(?:^|[\s,;])(?:не|нет|или|либо|если|и|отмени|отменить|перенеси|перенести|создай|создать|удали|удалить|запиши|записать|сохрани|сохранить|отправь|отправить|поменяй|измени)(?=$|[\s,;.!?])/iu.test(
      raw,
    )
  )
    return null;
  // Spoken clauses may be separated by punctuation. Keep decimal/clock-like
  // digit separators intact; every resulting word still needs its own role.
  raw = raw
    .replace(/(?<!\d)[,;]|[,;](?!\d)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (temporalOnly) {
    const proof = sourceTemporalProof(raw, clock);
    if (proof?.timeWindow || proof?.time === null)
      return {
        kind: 'sourceFilters',
        edits: ['date', 'time']
          .filter((field) => proof[field])
          .map((field) => ({ field, text: proof[field] })),
        constraints: proof,
      };
  }
  // Separate entity roles first, then require the entire remaining clause to be
  // temporal. Trying staffQuery first would absorb «завтра» into a person's name.
  let best = null;
  for (const order of [
    [serviceClause, staffClause],
    [staffClause, serviceClause],
  ]) {
    let head = raw,
      staff,
      service;
    for (const parse of order) {
      const clause = parse(head, clock);
      if (!clause) continue;
      if (clause.staff) staff = clause.staff;
      if (clause.service) service = clause.service;
      head = clause.head;
    }
    if (!staff && !service) continue;
    const proof = head ? sourceTemporalProof(head, clock) : staff ? {} : null;
    if (proof && (!best || (staff && service)))
      best = {
        kind: 'sourceFilters',
        query: service,
        staffQuery: staff,
        edits: ['date', 'time']
          .filter((field) => proof[field])
          .map((field) => ({ field, text: proof[field] })),
        ...(Object.keys(proof).length ? { constraints: proof } : {}),
      };
  }
  return best;
}
module.exports = {
  temporalWordsOnly,
  temporalPatch,
  serviceClause,
  staffClause,
  maskManagementEntities,
  sourceFilterComposition,
};
