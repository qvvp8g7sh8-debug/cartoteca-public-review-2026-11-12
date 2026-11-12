const { fail } = require('../../../../../shared/errors.cjs');
const {
  bookingTemporalConstraints,
} = require('../../language/time/booking-temporal-constraints.cjs');
const { initialEntities } = require('../../interpretation/entity-provenance.cjs');
const { literalSpan } = require('../../interpretation/entity-provenance.cjs');
const { detectRequestedOperation } = require('../../interpretation/requested-operation.cjs');
const management = new Set(['moveAppointment', 'cancelAppointment', 'editAppointment']);
const { normalizeIntent } = require('../../interpretation/intent-schema.cjs');
const { parseDateText, parseTimeText } = require('../../language/time/temporal.cjs');
const {
  temporalWordsOnly: targetWordsOnly,
  serviceClause,
  staffClause,
} = require('./appointment-management-entities.cjs');
const { managementRelativeProof } = require('./appointment-management-temporal.cjs');
const { nearestSlotMode } = require('../slot-request.cjs');
const { appointmentSlotClause } = require('../../language/time/appointment-slot-clause.cjs');
function localManagementIntent(raw, clock) {
  const requested = detectRequestedOperation(raw);
  if (requested.negated || requested.ambiguous || !management.has(requested.intent)) return null;
  // This fallback handles only an explicit operation, a literal client span and
  // supported temporal words. It never turns a model's unsupported field edit,
  // conditional/multiple request or unfamiliar trailing instruction into a move.
  if (
    /(?:^|[\s,;:])(?:если|или|либо|кроме|вместо|все|всех|кажд[а-я]*|услуг[а-я]*|длительность|продолжительность|стоимость|цен[ауы]|заметк[а-я]*|примечани[а-я]*|комментари[а-я]*)(?=$|[\s,.!?;:])/iu.test(
      raw,
    )
  )
    return null;
  const clean = (value) => value.trim().replace(/^[,\s]+|[,\s.!?…]+$/gu, '');
  const prefix = clean(String(raw).slice(0, requested.operation.start)).replace(
    /^(?:(?:пожалуйста|можешь|можете|можно|мне нужно|мне надо|нужно|надо|я хочу|хочу)[,\s]*)+/iu,
    '',
  );
  if (prefix && !targetWordsOnly(prefix)) return null;
  let tail = clean(String(raw).slice(requested.operation.end))
    .replace(/[,\s]+пожалуйста$/iu, '')
    .replace(/^(?:(?:клиента|клиентки|пациента|пациентки|для)\s+)+/iu, '');
  const service = serviceClause(tail, clock);
  if (service) tail = service.head;
  const staff = staffClause(tail, clock);
  if (staff) tail = staff.head;
  const target =
    /(?:^|\s)(?:на|в|к|ко|у|через|завтра|послезавтра|сегодня|понедельник[а-я]*|вторник[а-я]*|сред[ауы]|четверг[а-я]*|пятниц[ауы]|суббот[ауы]|воскресень[ея]|\d{4}-\d{2}-\d{2})(?=$|\s)/iu.exec(
      tail,
    );
  const query = clean(target ? tail.slice(0, target.index) : tail);
  const temporal = target ? tail.slice(target.index).trim() : '';
  if (temporal && !targetWordsOnly(temporal)) return null;
  if (
    query.length > 160 ||
    (query &&
      !/^[\p{L}]+(?:[-'’][\p{L}]+)*(?:\s+[\p{L}]+(?:[-'’][\p{L}]+)*){0,3}$/u.test(query) &&
      !/^[+\d\s().-]{4,35}$/u.test(query))
  )
    return null;
  const generic =
    /^(?:клиента|клиентки|пациента|пациентки|клиент|его|ее|этого клиента|этой клиентки)$/iu.test(
      query,
    );
  const date = parseDateText(requested.sourceWithoutCommand, clock);
  const time = parseTimeText(requested.sourceWithoutCommand);
  return normalizeIntent({
    intent: requested.intent,
    ...(query && !generic ? { query } : {}),
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(service ? { serviceQuery: service.service } : {}),
    ...(staff ? { staffQuery: staff.staff } : {}),
  });
}
function normalizeManagementRequest(parsed, raw, clock) {
  const requested = detectRequestedOperation(raw);
  if (requested.negated || requested.ambiguous) return parsed;
  if (parsed.intent === 'help' && requested.intent === 'prepareAppointment') {
    const remainder = requested.sourceWithoutCommand.replace(/пожалуйста/giu, '').trim();
    if (/^(?:(?:клиента|клиентки|пациента|пациентки)?[\s,.!?…]*)$/iu.test(remainder))
      return { intent: 'prepareAppointment' };
  }
  if (!management.has(requested.intent)) return parsed;
  if (parsed.intent !== requested.intent)
    return localManagementIntent(appointmentSlotClause(raw)?.head || raw, clock) || parsed;
  return parsed;
}

function prepareManagementIntent(parsed, raw, clock) {
  const requested = detectRequestedOperation(raw);
  if (requested.negated) throw fail(400, 'Действие не выполняю.');
  if (requested.ambiguous) throw fail(400, 'Назовите одну задачу с записью.');
  if (/(?:^|[\s,;:])(?:если|либо|при условии|в случае)(?=$|[\s,.!?;:])/iu.test(raw))
    throw fail(400, 'Уточните одну запись без условия.');
  if (!management.has(parsed.intent) || requested.intent !== parsed.intent)
    throw fail(400, 'Уточните действие с существующей записью.');
  if (parsed.intent === 'moveAppointment' && parsed.staffQuery) {
    let offset = 0,
      span;
    while ((span = literalSpan(raw.slice(offset), parsed.staffQuery))) {
      const at = offset + raw.slice(offset).indexOf(span);
      if (
        /(?:^|\s)(?:к|ко)\s+(?:(?:сотруднику|специалисту|врачу|мастеру)\s+)?$/iu.test(
          raw.slice(0, at),
        )
      )
        throw fail(400, 'Сменить сотрудника можно в форме записи.');
      offset = at + span.length;
    }
  }
  // Preserve every original condition, including dates before the operation.
  const source = requested.sourceWithoutCommand;
  const local = localManagementIntent(raw, clock);
  // A filter must survive even when the provider omits it. It never changes
  // the booked service; the initializer uses it only to narrow source records.
  if (!parsed.serviceQuery && local?.serviceQuery)
    parsed = { ...parsed, serviceQuery: local.serviceQuery };
  const entityProof = {
    ...initialEntities(parsed, source),
    ...(local?.query ? { query: local.query } : {}),
  };
  const relative =
    parsed.intent !== 'cancelAppointment'
      ? managementRelativeProof(entityProof, source, clock)
      : {};
  const constraints =
    relative.relativeTarget || relative.keepTime
      ? { ...relative }
      : bookingTemporalConstraints({ intent: 'prepareAppointment' }, source, clock);
  const intent = initialEntities(parsed, source, constraints);
  if (parsed.serviceQuery && !intent.serviceQuery)
    throw fail(400, 'Уточните услугу исходной записи.');
  if (intent.serviceQuery) {
    const span = literalSpan(raw, intent.serviceQuery);
    const before = span ? raw.slice(0, raw.indexOf(span)) : '';
    if (
      /(?:^|[\s,;])(?:не|нет)\s+(?:на\s+)?$/iu.test(before) ||
      /(?:^|[\s,;])(?:или|либо|вместо|кроме)(?=$|[\s,.!?;])/iu.test(raw)
    )
      throw fail(400, 'Уточните услугу исходной записи.');
  }
  const nearest = parsed.intent === 'moveAppointment' ? nearestSlotMode(raw) : null;
  if (nearest) constraints.nearestRequested = nearest;
  if (parsed.intent === 'moveAppointment' && appointmentSlotClause(raw))
    constraints.seekSlots = true;
  if (parsed.intent !== 'cancelAppointment') {
    if (relative.relativeTarget || relative.keepTime) {
      Object.assign(constraints, relative);
      delete constraints.time;
      delete intent.time;
      if (local?.query) intent.query = local.query;
    }
  }
  for (const field of ['date', 'time'])
    if (constraints[field] !== undefined) intent[field] = constraints[field];
  return { intent, constraints };
}
module.exports = { prepareManagementIntent, localManagementIntent, normalizeManagementRequest };
