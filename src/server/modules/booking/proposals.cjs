const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { validDate } = require('../../../shared/work-schedule.cjs');
const { startsAt } = require('../notifications/appointments.cjs');
const { duration } = require('../cabinet/validation.cjs');
const { bookingPreview, calculateBookingPreview } = require('./preview.cjs');
const { requestView } = require('./request-input.cjs');

function input(values, fields) {
  if (
    !values ||
    Array.isArray(values) ||
    Object.keys(values).some((k) => !fields.includes(k)) ||
    typeof values.id !== 'string' ||
    !values.id ||
    values.id.length > 120 ||
    !validDate(values.date)
  )
    throw fail(400, 'Выберите заявку и дату.');
}
function owned(c, values, now) {
  c.assertCurrent();
  const actor = c.platform.onlineBooking.actor(c.token),
    org = c.current.organizationId;
  if (actor.organizationId !== org) throw fail(403, 'Кабинет изменился.');
  c.platform.bookingPublication.resolve(org);
  const record = c.platform.bookingRequests.get(org, values.id, now);
  if (!record) throw fail(404, 'Заявка не найдена.');
  c.platform.onlineBooking.assertRequestPermission(c.token, record.staffId);
  if (record.kind !== 'other-time' || record.status !== 'requested' || record.acceptance)
    throw fail(409, 'Предложение доступно только необработанному запросу другого времени.');
  return { org, record };
}
function canonical(storage, record) {
  const services = storage.readSelected([], record.serviceIds).services;
  if (
    services.length !== record.services.length ||
    record.services.some((old) => {
      const current = services.find((s) => s.id === old.id);
      return (
        !current ||
        current.name !== old.name ||
        duration(current.duration ?? 60) !== duration(old.duration) ||
        (current.price ?? null) !== old.price
      );
    })
  )
    throw fail(409, 'Услуги изменились. Требуется новая заявка клиента.');
}
function options(c, values, now = Date.now()) {
  input(values, ['id', 'date']);
  const storage = c.tenantStore(c.current.organizationId);
  return compoundMutation(c.platform, storage, c.current.organizationId, 'booking', () => {
    const { org, record } = owned(c, values, now);
    return storage.transaction(() => {
      canonical(storage, record);
      const result = bookingPreview(
        c.platform,
        c.token,
        storage,
        { date: values.date, serviceIds: record.serviceIds, staffId: record.staffId },
        now,
        { mode: 'any', excludeRequestId: record.id },
      );
      return { times: [...new Set(result.slots.map((s) => s.time))] };
    }, 'DEFERRED');
  });
}
function propose(c, values, now = Date.now()) {
  input(values, ['id', 'revision', 'date', 'time']);
  if (
    !Number.isSafeInteger(values.revision) ||
    values.revision < 0 ||
    !/^([01]\d|2[0-3]):[0-5][05]$/.test(values.time)
  )
    throw fail(400, 'Проверьте время предложения.');
  const storage = c.tenantStore(c.current.organizationId);
  return compoundMutation(c.platform, storage, c.current.organizationId, 'booking', () => {
    const { org, record } = owned(c, values, now);
    const result = storage.transaction(() => {
      if (
        record.proposal?.state === 'waiting' &&
        record.proposal.baseRevision === values.revision &&
        record.date === values.date &&
        record.time === values.time &&
        record.proposal.timeZone === c.platform.organizationTimeZone(org) &&
        record.proposal.expiresAt > now
      )
        return record;
      if (record.revision !== values.revision)
        throw fail(409, 'Заявка уже изменена. Обновите список.');
      canonical(storage, record);
      const preview = bookingPreview(
        c.platform,
        c.token,
        storage,
        { date: values.date, serviceIds: record.serviceIds, staffId: record.staffId },
        now,
        { mode: 'any', atTime: values.time, excludeRequestId: record.id },
      );
      const slot = preview.slots.find((s) => s.time === values.time);
      if (!slot) throw fail(409, 'Время недоступно. Выберите другое.');
      const expiresAt = Math.min(
        record.expiresAt,
        now + 24 * 60 * 60000,
        startsAt({ date: values.date, time: values.time }, preview.timeZone) -
          c.platform.onlineBooking.settings(org).minimumLeadMinutes * 60000,
      );
      if (expiresAt <= now) throw fail(409, 'До посещения недостаточно времени для согласования.');
      return c.platform.bookingProposals.offer(
        org,
        record,
        { date: slot.date, time: slot.time, roomId: slot.roomId },
        expiresAt,
        now,
        preview.timeZone,
      );
    }, 'DEFERRED');
    return {
      record: requestView(result),
      path: '/booking.html#reply=' + c.platform.bookingProposals.token(org, result),
    };
  });
}
function publicView(platform, resolved) {
  const { org, record, organization } = resolved;
  const staff = platform.bookingPublication.members(org).find((m) => m.id === record.staffId);
  if (!staff && record.status === 'requested')
    throw fail(409, 'Сотрудник больше не принимает. Обратитесь в организацию.');
  return {
    organization,
    staff: staff || null,
    date: record.date,
    time: record.time,
    duration: record.duration,
    services: record.services.map(({ name, price }) => ({ name, price })),
    state: record.status === 'requested' ? record.proposal.state : record.status,
    expiresAt: Math.min(record.proposal.expiresAt, record.expiresAt),
  };
}
function inspectProposal(c, secret, now = Date.now()) {
  return c.platform.withReadSnapshot(() =>
    publicView(c.platform, c.platform.bookingProposals.resolve(secret, now)),
  );
}
function proposalLink(c, id, now = Date.now()) {
  if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Выберите заявку.');
  const storage = c.tenantStore(c.current.organizationId);
  return compoundMutation(c.platform, storage, c.current.organizationId, 'booking', () => {
    const { org, record } = owned(c, { id }, now);
    if (
      record.proposal?.state !== 'waiting' ||
      record.proposal.expiresAt <= now ||
      record.proposal.timeZone !== c.platform.organizationTimeZone(org)
    )
      throw fail(410, 'Нет действующего предложения. Создайте новое.');
    return { path: '/booking.html#reply=' + c.platform.bookingProposals.token(org, record) };
  });
}
function respondProposal(c, values, now = Date.now()) {
  if (
    !values ||
    Object.keys(values).some((k) => !['secret', 'decision'].includes(k)) ||
    !['agree', 'decline'].includes(values.decision)
  )
    throw fail(400, 'Выберите ответ на предложение.');
  const hint = c.platform.bookingProposals.resolve(values.secret, now);
  const storage = c.tenantStore(hint.org);
  return compoundMutation(c.platform, storage, hint.org, 'booking', () => {
    const resolved = c.platform.bookingProposals.resolve(values.secret, now),
      { org, record } = resolved;
    if (org !== hint.org) throw fail(403, 'Кабинет изменился.');
    const wanted = values.decision === 'agree' ? 'agreed' : 'declined';
    if (record.proposal.state === wanted) return publicView(c.platform, resolved);
    if (record.status !== 'requested' || record.proposal.state !== 'waiting')
      throw fail(409, 'Предложение уже обработано.');
    return storage.transaction(() => {
      if (values.decision === 'agree') {
        canonical(storage, record);
        const preview = calculateBookingPreview(
          c.platform,
          org,
          storage,
          { date: record.date, serviceIds: record.serviceIds, staffId: record.staffId },
          now,
          { mode: 'any', atTime: record.time, roomId: record.roomId },
          (id) => c.platform.workSchedules.publicDays(org, id, record.date, record.date),
        );
        if (!preview.slots.some((s) => s.time === record.time && s.roomId === record.roomId))
          throw fail(409, 'Это время уже недоступно. Обратитесь в организацию.');
      }
      const updated = c.platform.bookingProposals.reply(org, record, values.decision, now);
      return publicView(c.platform, { ...resolved, record: updated });
    }, 'DEFERRED');
  });
}
module.exports = {
  proposalOptions: options,
  propose,
  proposalLink,
  inspectProposal,
  respondProposal,
};
