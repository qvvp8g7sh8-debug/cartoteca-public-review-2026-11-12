const DEFAULT_TIME_ZONE = 'Europe/Moscow';
const validatedTimeZones = new Set();
function timeZoneRule(value, fail) {
  if (typeof value !== 'string' || !value || value.length > 80)
    throw fail(400, 'Укажите часовой пояс.');
  if (validatedTimeZones.has(value)) return value;
  try {
    new Intl.DateTimeFormat('ru', { timeZone: value });
  } catch {
    throw fail(400, 'Неизвестный часовой пояс.');
  }
  if (validatedTimeZones.size >= 64)
    validatedTimeZones.delete(validatedTimeZones.values().next().value);
  validatedTimeZones.add(value);
  return value;
}
function createOrganizationTimeZone(context) {
  const { db, open, seal, fail, transaction, audit } = context;
  let organizationValueStatement;
  function organizationRow(organizationId) {
    organizationValueStatement ??= db.prepare('SELECT value FROM organizations WHERE id=?');
    return organizationValueStatement.get(organizationId);
  }
  function organizationTimeZone(organizationId) {
    // The full organization row is already in this native response's physical RR.
    // Ordinary reads/writes retain their established fresh standalone query.
    if (db.canPrefetchReads && context.organization?.readRequests)
      return timeZoneRule(context.organization(organizationId).timeZone || DEFAULT_TIME_ZONE, fail);
    const row = organizationRow(organizationId);
    if (!row) throw fail(404, 'Организация не найдена.');
    return timeZoneRule(open(row.value).timeZone || DEFAULT_TIME_ZONE, fail);
  }
  // Internal synchronous operation: caller owns the platform write transaction.
  function setOrganizationTimeZone(organizationId, actorId, value, { expectedTimeZone } = {}) {
    value = timeZoneRule(value, fail);
    const actor = db
      .prepare(
        "SELECT m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND m.status='active' AND a.status='active'",
      )
      .get(organizationId, actorId);
    if (!actor || !['owner', 'salon_admin'].includes(actor.role))
      throw fail(403, 'Часовой пояс изменяет владелец или администратор.');
    const prior = organizationTimeZone(organizationId);
    if (expectedTimeZone !== undefined && expectedTimeZone !== prior)
      throw fail(409, 'Часовой пояс уже изменён. Обновите настройки перед сохранением.');
    if (prior === value) return { timeZone: prior };
    const row = organizationRow(organizationId);
    db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
      seal({ ...open(row.value), timeZone: value }),
      organizationId,
    );
    context.appointmentConfirmations.invalidateZone(organizationId);
    db.prepare(
      "UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=? AND status IN ('pending','sending')",
    ).run(organizationId);
    audit('organization_time_zone_updated', actorId, organizationId, { timeZone: value });
    return { timeZone: value };
  }
  function updateOrganizationTimeZone(token, values) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some((key) => !['timeZone', 'expectedTimeZone'].includes(key))
    )
      throw fail(400, 'Некорректные настройки часового пояса.');
    return transaction(() => {
      const current = context.session(token);
      if (!current?.organizationId) throw fail(403, 'Выберите организацию.');
      return setOrganizationTimeZone(
        current.organizationId,
        current.accountId,
        values.timeZone,
        values,
      );
    });
  }
  return { organizationTimeZone, setOrganizationTimeZone, updateOrganizationTimeZone };
}
module.exports = { DEFAULT_TIME_ZONE, timeZoneRule, createOrganizationTimeZone };
