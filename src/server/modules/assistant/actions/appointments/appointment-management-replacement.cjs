const {
  temporalWordsOnly,
  sourceFilterComposition,
} = require('./appointment-management-entities.cjs');
const {
  bookingTemporalConstraints,
} = require('../../language/time/booking-temporal-constraints.cjs');
const { sourceServiceQuery, sourceStaffQuery } = require('./appointment-source-selection.cjs');
const { serviceMatches } = require('../../language/services/service-matching.cjs');
const {
  servicePartialIdentityMatches,
} = require('../../language/services/service-partial-search.cjs');
const { matchesName } = require('../../language/names/name-matching.cjs');
function hasManagementCorrectionPrefix(raw) {
  return typeof raw === 'string' && /^нет[\s,.;:!?…]+\S/iu.test(raw.normalize('NFKC').trim());
}
function managementCorrectionRemainder(raw) {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  const match = /^нет[\s,.;:!?…]+([\s\S]+)$/iu.exec(raw.normalize('NFKC').trim());
  return match ? match[1].trim() || null : null;
}
// A rejection-only role classifier, never a source filter or a parsed replacement.
// Every token must have a temporal/source role; an unconsumed name or phone keeps
// the stricter client-correction reset. Conditions and extra actions stay rejected.
function rejectedSourceOnlyCorrection(raw, source) {
  const remainder = managementCorrectionRemainder(raw);
  if (!remainder) return false;
  if (/\d\s*,\s*\d/u.test(remainder)) return false;
  const words = remainder
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[,;!?…]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/^\.+|\.+$/gu, ''));
  const operators = new Set(['если', 'или', 'либо', 'не', 'нет', 'и']);
  const actions = new Set([
    'отмени',
    'отменить',
    'удали',
    'удалить',
    'перенеси',
    'перенести',
    'измени',
    'изменить',
  ]);
  const records = new Set(['запись', 'записи']);
  const head = words[words[0] === 'если' ? 1 : 0];
  if (
    !['в', 'на', 'у', 'сегодня', 'завтра', 'послезавтра'].includes(head) &&
    !records.has(head) &&
    !actions.has(head)
  )
    return false;
  const temporal = (word) =>
    /^(?:\d{1,2}(?:[:.]\d{2})?|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{4})?|\d{1,2}-(?:е|го))$/u.test(
      word,
    ) ||
    (/^\p{L}[\p{L}-]*$/u.test(word) && temporalWordsOnly(word));
  const cache = new Map();
  function covered(at) {
    if (at === words.length) return true;
    if (cache.has(at)) return cache.get(at);
    const word = words[at];
    let accepted = false;
    if (word === 'у') {
      for (let count = 1; count <= 4 && at + count < words.length; count++) {
        const query = words.slice(at + 1, at + count + 1).join(' ');
        if (!sourceStaffQuery('у ' + query)) continue;
        const members = (source?.context?.members || []).filter((member) =>
          matchesName(member, query, true),
        );
        if (members.length === 1 && covered(at + count + 1)) accepted = true;
      }
    } else if (actions.has(word)) {
      const next = ['другую', 'эту', 'ту'].includes(words[at + 1]) ? at + 2 : at + 1;
      accepted = records.has(words[next]) && covered(next + 1);
    } else if (operators.has(word) || records.has(word) || temporal(word)) {
      accepted = covered(at + 1);
    }
    cache.set(at, accepted);
    return accepted;
  }
  return covered(0);
}
function temporalFields(text, clock) {
  if (!temporalWordsOnly(text)) return null;
  const proof = bookingTemporalConstraints({ intent: 'prepareAppointment' }, text, clock);
  const fields = ['date', 'time'].filter((field) => Object.hasOwn(proof, field));
  return fields.length ? fields.join(',') : null;
}
function replacementParts(raw) {
  if (typeof raw !== 'string' || raw.length > 160) return null;
  const text = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?…]+$/u, '');
  const match = /^(?:нет[, ]+)?не\s+(.+?)\s*,?\s+а\s+(.+)$/u.exec(text);
  if (!match) return null;
  return { before: match[1].trim().replace(/,$/u, '').trim(), after: match[2].trim() };
}
function managementTemporalReplacement(raw, clock) {
  const parts = replacementParts(raw);
  if (!parts) return null;
  const { before, after } = parts;
  // Both complete clauses must describe the same temporal roles. An omitted
  // name, condition, alternative or another action cannot become a time repair.
  const fields = temporalFields(before, clock);
  return fields && fields === temporalFields(after, clock) ? after : null;
}
function managementSourceReplacement(entry, raw, source, clock) {
  const parts = replacementParts(raw);
  if (!parts) return null;
  const { before, after } = parts;
  if (
    /(?:^|[\s,;])(?:не|нет|или|либо|если|и|отмени|отменить|перенеси|перенести|создай|создать|удали|удалить|запиши|записать|сохрани|сохранить|отправь|отправить|поменяй|измени)(?=$|[\s,;.!?])/iu.test(
      before + ' ' + after,
    )
  )
    return null;
  const appointment = source?.appointment || entry.data.management.cancelConfirmation?.appointment;
  const composition = clock ? sourceFilterComposition(after, clock, true) : null;
  const rejectedStaff = sourceStaffQuery(before),
    wantedStaff = composition?.staffQuery || sourceStaffQuery(after);
  if (rejectedStaff) {
    if (!rejectedStaff || !wantedStaff || !source) return null;
    const member = source.context.members.find((row) => row.accountId === source.staffId);
    return member && matchesName(member, rejectedStaff, true)
      ? composition || { kind: 'sourceStaff', query: wantedStaff }
      : null;
  }
  if (wantedStaff && !composition?.query) return null;
  if (!appointment || temporalWordsOnly(before) || temporalWordsOnly(after)) return null;
  const rejected = sourceServiceQuery(before),
    wanted = composition?.query || sourceServiceQuery(after);
  const services = [
    appointment.service,
    ...(appointment.serviceItems || []).map((row) => row.name),
  ];
  return rejected &&
    wanted &&
    services.some(
      (name) =>
        typeof name === 'string' &&
        (serviceMatches(name, rejected) || servicePartialIdentityMatches(name, rejected)),
    )
    ? composition || { kind: 'sourceService', query: wanted }
    : null;
}
module.exports = {
  managementTemporalReplacement,
  managementSourceReplacement,
  replacementParts,
  managementCorrectionRemainder,
  hasManagementCorrectionPrefix,
  rejectedSourceOnlyCorrection,
};
