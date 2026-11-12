const { literalSpan, fold, entityText } = require('../../interpretation/entity-provenance.cjs');
const { temporalWordsOnly } = require('../../language/time/temporal-words.cjs');
const { parseBookingTimeWindow } = require('../../language/time/booking-time-window.cjs');
const roles = {
  клиент: 'client',
  клиентка: 'client',
  клиента: 'client',
  клиентку: 'client',
  пациент: 'client',
  пациентка: 'client',
  пациента: 'client',
  пациентку: 'client',
  сотрудник: 'staff',
  сотрудника: 'staff',
  специалист: 'staff',
  специалиста: 'staff',
  врач: 'staff',
  врача: 'staff',
  мастер: 'staff',
  мастера: 'staff',
  услуга: 'service',
  услугу: 'service',
  процедура: 'service',
  процедуру: 'service',
};
const rolePattern = new RegExp(
  '(?<![\\p{L}\\p{N}])(' + Object.keys(roles).join('|') + ')(?![\\p{L}\\p{N}])',
  'giu',
);
const assignmentPrefix =
  /^(?:(?:нет|да|а|но|лучше|точнее|вернее|тогда|теперь|пожалуйста|давай|давайте|на самом деле|вместо этого)(?:\s+|$))*(?:поменяй|смени|измени|исправь|замени|изменить|поменять|заменить|запиши|запишите|записать)?$/u;
function assignmentContext(value) {
  const prefix = fold(value).replace(rolePattern, ' ').trim();
  return (
    assignmentPrefix.test(prefix) || temporalWordsOnly(parseBookingTimeWindow(prefix).maskedText)
  );
}

// An omitted, explicitly assigned role is unresolved. A nullable wire value does
// not authorize reusing the previous person or procedure. This is only a guard;
// it never invents an entity value or relaxes the actual resolver's criteria.
function sameEntityValue(value, field, data) {
  const selected = field === 'client' ? data.patient : data[field];
  if (!selected || !value) return false;
  return [
    data[field === 'client' ? 'clientQuery' : field + 'Query'],
    selected.label?.replace(/\s*·\s*…\d+\s*$/u, ''),
  ].some((known) => typeof known === 'string' && fold(known) === fold(value));
}
function sameKnownRole(tail, field, data) {
  const selected = field === 'client' ? data.patient : data[field];
  if (!selected) return false;
  const values = [
    data[field === 'client' ? 'clientQuery' : field + 'Query'],
    selected.label?.replace(/\s*·\s*…\d+\s*$/u, ''),
  ];
  const clause = tail.split(/[,;.!?]/u)[0].trim();
  return values.some((value) => {
    if (typeof value !== 'string' || !value.trim()) return false;
    const span = literalSpan(clause, value);
    if (!span || !fold(clause).startsWith(fold(span))) return false;
    const rest = clause.slice(clause.indexOf(span) + span.length).trim();
    return !rest || temporalWordsOnly(rest);
  });
}
function maskEntityValues(raw, fields) {
  let text = String(raw || '');
  // Words inside another fully source-proven entity are title/name data, not a
  // second role assignment (for example a service called «Клиент VIP»).
  for (const field of ['client', 'staff', 'service']) {
    const value = fields[field];
    if (typeof value !== 'string') continue;
    const span = literalSpan(text, value);
    if (!span) continue;
    const at = text.indexOf(span);
    if (at >= 0) text = text.slice(0, at) + ' '.repeat(span.length) + text.slice(at + span.length);
  }
  return text;
}
function explicitEntityRole(raw, field, fields) {
  const source = String(raw || ''),
    value = entityText(source, fields[field], field);
  if (!value) return false;
  const text = maskEntityValues(source, fields);
  // An anchored relation assigns the catalog role, independently of its title.
  // A modifier elsewhere in the sentence cannot authorize replacing a person.
  if (field === 'service' || field === 'staff') {
    const span = literalSpan(source, value),
      before = fold(
        text
          .slice(0, source.indexOf(span))
          .split(/[,;.!?]/u)
          .at(-1),
      ),
      relation = (field === 'service' ? /(?:^|\s)на$/u : /(?:^|\s)(?:к|ко|у)$/u).exec(before);
    const prefix = relation ? before.slice(0, relation.index).replace(rolePattern, ' ').trim() : '';
    if (relation && !(field === 'service' && temporalWordsOnly(value)) && assignmentContext(prefix))
      return true;
  }
  for (const match of text.matchAll(rolePattern)) {
    if (roles[match[1].toLowerCase()] !== field) continue;
    const before = fold(
      text
        .slice(0, match.index)
        .split(/[,;.!?]/u)
        .at(-1),
    );
    if (!assignmentContext(before)) continue;
    const tail = source
      .slice(match.index + match[0].length)
      .replace(/^\s*[:=–—]\s*|^\s+/u, '')
      .replace(/^(?:поменяй|смени|измени|исправь|замени)(?:\s+на)?\s+/iu, '')
      .replace(/^на\s+/iu, '');
    const span = literalSpan(tail, value);
    if (span && fold(tail).startsWith(fold(span))) return true;
  }
  return false;
}
function entityRoleOmissions(raw, fields, protectedFields = new Set(), data = {}) {
  const text = maskEntityValues(raw, fields);
  const omitted = new Set(),
    ambiguous = new Set();
  for (const match of text.matchAll(rolePattern)) {
    const field = roles[match[1].toLowerCase()];
    if (fields[field] !== null || protectedFields.has(field)) continue;
    const before = text
      .slice(0, match.index)
      .split(/[.!?;,]/u)
      .at(-1);
    if (
      /(?:^|\s)(?:какой|какая|какую|какого|который|которого|кто|где|назови|назовите|уточни|уточните)(?=$|\s)/iu.test(
        before,
      ) ||
      /(?:не\s+(?:меняй|меняйте|менять)|оставь|оставьте)\s*$/iu.test(before)
    )
      continue;
    const tail = text
      .slice(match.index + match[0].length)
      .replace(/^\s*[:=–—]\s*|^\s+/u, '')
      .replace(/^(?:поменяй|смени|измени|исправь|замени)(?:\s+на)?\s+/iu, '')
      .replace(/^на\s+/iu, '');
    if (!tail || /^[,;.!?]/u.test(tail)) continue;
    if (
      /^(?:не\s+(?:меняй|меняйте|менять)|остав(?:ь|ьте|им|ляем)\s+|(?:тот|та|то)\s+же|прежн|как\s+было)/iu.test(
        tail,
      )
    )
      continue;
    if (sameKnownRole(tail, field, data)) continue;
    (assignmentContext(before) ? omitted : ambiguous).add(field);
  }
  // «На массаж» is the existing service-assignment grammar, as distinct from
  // «на завтра/на 16:00». Do not let a missing proposal reuse the old procedure.
  if (fields.service === null && !protectedFields.has('service'))
    for (const match of text.matchAll(/(?:^|[\s,;])на\s+/giu)) {
      const before = text
        .slice(0, match.index)
        .split(/[.!?;,]/u)
        .at(-1);
      if (
        /(?:клиент(?:а|ку)?|пациент(?:а|ку)?|сотрудник(?:а)?|специалист(?:а)?|врач(?:а)?|мастер(?:а)?)(?:\s+(?:поменяй|смени|измени|исправь|замени))?\s*$/iu.test(
          before,
        )
      )
        continue;
      let query = text
        .slice(match.index + match[0].length)
        .split(/[,.!?;]/u)[0]
        .trim();
      if (!query || temporalWordsOnly(query.split(/\s+/u)[0])) continue;
      const words = query.split(/\s+/u);
      for (let split = 1; split < words.length; split++)
        if (temporalWordsOnly(words.slice(split).join(' '))) {
          query = words.slice(0, split).join(' ');
          break;
        }
      if (
        !query ||
        query.length > 160 ||
        !/[\p{L}]/u.test(query) ||
        /(?:^|\s)(?:не|нет|или|либо|если|и|отмени|перенеси|создай|удали|запиши|сохрани|клиент(?:а|ку)?|сотрудник(?:а)?|специалист(?:а)?)(?=$|\s)/iu.test(
          query,
        )
      )
        continue;
      if (!sameKnownRole(query, 'service', data)) omitted.add('service');
    }
  const ordered = (values) => ['client', 'staff', 'service'].filter((field) => values.has(field));
  return { omitted: ordered(omitted), ambiguous: ordered(ambiguous) };
}
const omittedEntityRoles = (...args) => entityRoleOmissions(...args).omitted;
module.exports = { entityRoleOmissions, omittedEntityRoles, explicitEntityRole, sameEntityValue };
