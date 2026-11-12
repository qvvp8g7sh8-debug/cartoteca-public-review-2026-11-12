const { fail } = require('../../../shared/errors.cjs');
const { catalogProviders } = require('../services/catalog.cjs');
const defaults = () => ({
  revision: 0,
  mode: 'any',
  bookingMode: 'approval',
  minimumLeadMinutes: 60,
  reservationMinutes: 30,
  showPrices: true,
  staff: {},
  services: {},
});
const manager = (actor) => ['owner', 'salon_admin'].includes(actor?.role);
function assignedProviders(members, value, serviceIds) {
  if (members.length === 1) return members;
  return members.filter((m) =>
    serviceIds.every(
      (id) => Array.isArray(value.services[id]) && value.services[id].includes(m.accountId),
    ),
  );
}
function createBookingSettings(context) {
  const { db, open, seal, transaction, audit } = context;
  function settings(org) {
    const profile = context.organization(org);
    return { ...defaults(), ...profile.onlineBooking };
  }
  function actor(token) {
    const current = context.session(token);
    if (
      !current?.organizationId ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
    )
      throw fail(403, 'Нет доступа к онлайн-записи.');
    if (context.subscription(current.organizationId).status !== 'active')
      throw fail(403, 'Доступ приостановлен.');
    return current;
  }
  // Request-local only: never reuse membership/permissions across requests.
  function providerSnapshot(org) {
    const profile = context.organization(org);
    const value = { ...defaults(), ...profile.onlineBooking },
      members = context.workspaceMembers(org);
    return {
      settings: value,
      specialties: profile.staffSpecialties || {},
      ownerId: members.find((m) => m.role === 'owner')?.accountId || '',
      members: members.filter(
        (m) =>
          m.status === 'active' &&
          ['owner', 'cosmetologist'].includes(m.role) &&
          value.staff[m.accountId]?.enabled !== false,
      ),
    };
  }
  function view(token) {
    const current = actor(token),
      saved = settings(current.organizationId);
    const staff = context
      .workspaceMembers(current.organizationId)
      .filter((m) => m.status === 'active');
    return {
      ...saved,
      staff: manager(current)
        ? saved.staff
        : { [current.accountId]: saved.staff[current.accountId] || {} },
      services: manager(current) ? saved.services : {},
      members: staff
        .filter((m) => manager(current) || m.accountId === current.accountId)
        .map((m) => ({
          ...m,
          specialty: context.staffSpecialty(current.organizationId, m.accountId),
        })),
      canManage: manager(current),
      canManageOwnRequests:
        manager(current) || saved.staff[current.accountId]?.manageOwnRequests !== false,
    };
  }
  function save(token, values, serviceIds) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some(
        (k) =>
          ![
            'revision',
            'mode',
            'bookingMode',
            'minimumLeadMinutes',
            'reservationMinutes',
            'showPrices',
            'staff',
            'services',
          ].includes(k),
      )
    )
      throw fail(400, 'Некорректные настройки онлайн-записи.');
    return transaction(() => {
      const current = actor(token);
      if (!manager(current)) throw fail(403, 'Настройки меняет владелец или администратор.');
      const org = current.organizationId,
        prior = settings(org);
      if (values.revision !== prior.revision)
        throw fail(409, 'Настройки изменились. Откройте их заново.');
      if (values.showPrices !== undefined && typeof values.showPrices !== 'boolean')
        throw fail(400, 'Проверьте настройку отображения стоимости.');
      if (values.bookingMode !== undefined && !['approval', 'classic'].includes(values.bookingMode))
        throw fail(400, 'Проверьте вид онлайн-записи.');
      if (
        !['any', 'sequential'].includes(values.mode) ||
        !Number.isSafeInteger(values.minimumLeadMinutes) ||
        values.minimumLeadMinutes < 0 ||
        values.minimumLeadMinutes > 20160 ||
        !Number.isSafeInteger(values.reservationMinutes) ||
        values.reservationMinutes < 1 ||
        values.reservationMinutes > 1440
      )
        throw fail(
          400,
          'Проверьте режим и время: резерв от 1 минуты до суток, срок до визита от 0 до 14 дней.',
        );
      const object = (value) =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length <= 2000;
      if (!object(values.staff) || !object(values.services))
        throw fail(400, 'Проверьте сотрудников и услуги.');
      const members = new Set(context.workspaceMembers(org).map((m) => m.accountId));
      const staff = {};
      // A global/defaults-only write may come from an older form that does not
      // render every member. Omission never resets another member's saved rules.
      for (const [id, entry] of Object.entries(prior.staff)) {
        if (!members.has(id) || Object.hasOwn(values.staff, id)) continue;
        staff[id] = {
          enabled: entry.enabled !== false,
          manageOwnRequests: entry.manageOwnRequests !== false,
        };
        if (['inherit', 'any', 'sequential'].includes(entry.mode)) staff[id].mode = entry.mode;
        if (['inherit', 'approval', 'classic'].includes(entry.bookingMode))
          staff[id].bookingMode = entry.bookingMode;
      }
      for (const [id, entry] of Object.entries(values.staff)) {
        if (
          !members.has(id) ||
          !object(entry) ||
          Object.keys(entry).some(
            (k) => !['enabled', 'manageOwnRequests', 'mode', 'bookingMode'].includes(k),
          ) ||
          typeof entry.enabled !== 'boolean' ||
          typeof entry.manageOwnRequests !== 'boolean' ||
          (Object.hasOwn(entry, 'mode') &&
            !['inherit', 'any', 'sequential'].includes(entry.mode)) ||
          (Object.hasOwn(entry, 'bookingMode') &&
            !['inherit', 'approval', 'classic'].includes(entry.bookingMode))
        )
          throw fail(400, 'Некорректное разрешение сотрудника.');
        staff[id] = {
          enabled: entry.enabled,
          manageOwnRequests: entry.manageOwnRequests,
        };
        // Older clients do not send the new fields. Their permission edits must
        // preserve this same member's explicit rules instead of resetting them.
        for (const field of ['mode', 'bookingMode']) {
          const value = Object.hasOwn(entry, field) ? entry[field] : prior.staff[id]?.[field];
          if (value !== undefined) staff[id][field] = value;
        }
      }
      const services = Object.create(null);
      for (const [id, ids] of Object.entries(values.services)) {
        if (
          !serviceIds.has(id) ||
          !Array.isArray(ids) ||
          ids.length > 100 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => !members.has(id))
        )
          throw fail(400, 'Услуге можно назначить только сотрудников организации.');
        services[id] = [...ids];
      }
      const next = {
        revision: prior.revision + 1,
        mode: values.mode,
        bookingMode: values.bookingMode ?? prior.bookingMode,
        minimumLeadMinutes: values.minimumLeadMinutes,
        reservationMinutes: values.reservationMinutes,
        showPrices: values.showPrices ?? prior.showPrices,
        staff,
        services,
      };
      const row = db.prepare('SELECT value FROM organizations WHERE id=?').get(org);
      db.prepare('UPDATE organizations SET value=? WHERE id=?').run(
        seal({ ...open(row.value), onlineBooking: next }),
        org,
      );
      audit('online_booking_settings_updated', current.accountId, org, {
        revision: next.revision,
      });
      return view(token);
    });
  }
  function providers(org, serviceIds, catalog = [], snapshot = providerSnapshot(org)) {
    return catalogProviders(snapshot.members, catalog, serviceIds, snapshot.ownerId);
  }
  function assertRequestPermission(token, staffId) {
    const current = actor(token);
    if (
      !manager(current) &&
      (current.accountId !== staffId ||
        settings(current.organizationId).staff[staffId]?.manageOwnRequests === false)
    )
      throw fail(403, 'Управление этой заявкой недоступно.');
    return current;
  }
  return { settings, actor, view, save, providers, providerSnapshot, assertRequestPermission };
}
module.exports = { createBookingSettings, defaults, assignedProviders };
