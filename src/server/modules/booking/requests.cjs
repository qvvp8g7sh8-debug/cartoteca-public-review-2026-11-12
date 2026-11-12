const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { bookingPreview } = require('./preview.cjs');
const { requestInput, requestView } = require('./request-input.cjs');
const { admitRequest } = require('./admission.cjs');

// Authenticated staging commands. Public admission will have its own budget/identity boundary.
function submitRequest(platform, token, storage, values, now = Date.now(), expectedOrganizationId) {
  const input = requestInput(values);
  const expected = expectedOrganizationId || platform.onlineBooking.actor(token).organizationId;
  return compoundMutation(platform, storage, expected, 'booking', () =>
    storage.transaction(() => {
      const actor = platform.onlineBooking.actor(token),
        org = actor.organizationId;
      if (org !== expected) throw fail(403, 'Кабинет изменился. Повторите операцию.');
      if (actor.role === 'cosmetologist' && input.staffId !== actor.accountId)
        throw fail(403, 'Нет доступа к заявкам другого сотрудника.');
      return requestView(
        admitRequest(
          platform,
          org,
          storage,
          input,
          () =>
            bookingPreview(
              platform,
              token,
              storage,
              { date: input.date, serviceIds: input.serviceIds, staffId: input.staffId },
              now,
            ),
          () => platform.workSchedules.view(token, input.staffId, input.date, input.date),
          now,
        ),
      );
    }, 'DEFERRED'),
  );
}
function listRequests(platform, token, cursor = null, now = Date.now()) {
  const actor = platform.onlineBooking.actor(token);
  if (
    cursor &&
    (!Number.isSafeInteger(cursor.createdAt) ||
      cursor.createdAt < 0 ||
      typeof cursor.id !== 'string' ||
      cursor.id.length > 120 ||
      !cursor.id)
  )
    throw fail(400, 'Некорректная страница заявок.');
  const page = platform.bookingRequests.list(
    actor.organizationId,
    actor.role === 'cosmetologist' ? actor.accountId : null,
    cursor,
    now,
  );
  return {
    ...page,
    settingsRevision: platform.onlineBooking.view(token).revision,
    items: page.items.map(requestView),
  };
}
function requestSummary(platform, token, now = Date.now()) {
  const actor = platform.onlineBooking.actor(token);
  return {
    ...platform.bookingRequests.summary(
      actor.organizationId,
      actor.role === 'cosmetologist' ? actor.accountId : null,
      now,
    ),
    settingsRevision: platform.onlineBooking.view(token).revision,
  };
}
function rejectRequest(platform, token, values, now = Date.now(), storage) {
  if (
    !values ||
    Object.keys(values).some((k) => !['id', 'revision'].includes(k)) ||
    typeof values.id !== 'string' ||
    values.id.length > 120 ||
    !Number.isSafeInteger(values.revision)
  )
    throw fail(400, 'Некорректная заявка.');
  const expected = platform.onlineBooking.actor(token).organizationId;
  return compoundMutation(platform, storage, expected, 'booking', () => {
    const actor = platform.onlineBooking.actor(token),
      record = platform.bookingRequests.get(actor.organizationId, values.id, now);
    if (actor.organizationId !== expected) throw fail(403, 'Кабинет изменился.');
    if (!record) throw fail(404, 'Заявка не найдена.');
    platform.onlineBooking.assertRequestPermission(token, record.staffId);
    if (record.status === 'rejected') return requestView(record);
    if (record.acceptance && (!storage || storage.get('booking-accepted:' + record.id)))
      throw fail(
        409,
        'Заявка уже сохранена в календарь. Повторите принятие для обновления статуса.',
      );
    return requestView(
      platform.bookingRequests.finish(
        actor.organizationId,
        values.id,
        values.revision,
        'rejected',
        now,
      ),
    );
  });
}
module.exports = { submitRequest, listRequests, requestSummary, rejectRequest };
