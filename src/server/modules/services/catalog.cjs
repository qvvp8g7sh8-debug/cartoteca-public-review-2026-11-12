const { fail } = require('../../../shared/errors.cjs');
const { isDeepStrictEqual } = require('node:util');

// Missing ownership in older encrypted JSON belongs to the original owner.
// This projection never rewrites saved services or historical procedure snapshots.
const serviceOwner = (service, ownerId) => service.staffId || ownerId;
function catalogProviders(members, catalog, ids, ownerId) {
  const services = new Map(catalog.map((service) => [service.id, service]));
  return members.filter((member) =>
    ids.every(
      (id) => services.has(id) && serviceOwner(services.get(id), ownerId) === member.accountId,
    ),
  );
}
function changedRecordServices(before, next, ownerId) {
  const selected = [];
  const patients = new Map(before.patients.map((patient) => [patient.id, patient]));
  for (const patient of next.patients) {
    const prior = patients.get(patient.id);
    for (const kind of ['appointments', 'visits']) {
      const records = new Map((prior?.[kind] || []).map((record) => [record.id, record]));
      for (const record of patient[kind]) {
        const previous = records.get(record.id);
        const staffId = record.staffId || ownerId;
        const unchangedStaff = !previous || (previous.staffId || ownerId) === staffId;
        const inherited =
          kind === 'visits' && !previous && record.appointmentId
            ? prior?.appointments.find(
                (appointment) =>
                  appointment.id === record.appointmentId &&
                  (appointment.staffId || ownerId) === staffId,
              )
            : null;
        for (const item of record.serviceItems || []) {
          const preserved =
            unchangedStaff &&
            (previous?.serviceItems || inherited?.serviceItems || []).some((saved) =>
              isDeepStrictEqual(saved, item),
            );
          if (preserved) continue;
          selected.push({ item, staffId });
        }
      }
    }
  }
  return selected;
}
function assertSelection(selected, catalog, ownerId) {
  const services = new Map(catalog.map((service) => [service.id, service]));
  for (const { item, staffId } of selected) {
    const service = services.get(item.id);
    if (!service || serviceOwner(service, ownerId) !== staffId)
      throw fail(400, 'Выберите услуги из каталога указанного сотрудника.');
  }
}
function assertRecordServices(before, next, catalog, ownerId) {
  assertSelection(changedRecordServices(before, next, ownerId), catalog, ownerId);
}
function createServiceCatalog(context) {
  function serviceCatalog(org) {
    const members = context.workspaceIdentities(org);
    return {
      ownerId: members.find((member) => member.role === 'owner')?.accountId || '',
    };
  }
  function assertServiceCatalog(
    org,
    before,
    next,
    storage,
    identities = context.workspaceIdentities(org),
  ) {
    const ownerId = identities.find((member) => member.role === 'owner')?.accountId || '';
    const members = new Set(
      identities
        .filter(
          (member) =>
            member.status === 'active' && ['owner', 'cosmetologist'].includes(member.role),
        )
        .map((member) => member.accountId),
    );
    const prior = new Map(before.services.map((service) => [service.id, service]));
    for (const service of next.services) {
      const staffId = serviceOwner(service, ownerId),
        previous = prior.get(service.id);
      if (previous && serviceOwner(previous, ownerId) !== staffId)
        throw fail(
          400,
          'Принадлежность сохранённой услуги менять нельзя. Создайте услугу в другом каталоге.',
        );
      if (!previous && (!staffId || !members.has(staffId)))
        throw fail(400, 'Услуга должна принадлежать действующему сотруднику организации.');
    }
    const selected = changedRecordServices(before, next, ownerId);
    if (!selected.length) return;
    const ids = new Set(selected.map(({ item }) => item.id));
    const catalog = storage.readSelected([], [...ids]).services;
    const deleted = new Set(
      before.services
        .filter((service) => !next.services.some((s) => s.id === service.id))
        .map((service) => service.id),
    );
    const merged = new Map(
      catalog.filter((service) => !deleted.has(service.id)).map((service) => [service.id, service]),
    );
    for (const service of next.services) merged.set(service.id, service);
    assertSelection(selected, [...merged.values()], ownerId);
  }
  return { serviceCatalog, assertServiceCatalog };
}
module.exports = {
  createServiceCatalog,
  serviceOwner,
  catalogProviders,
  assertRecordServices,
};
