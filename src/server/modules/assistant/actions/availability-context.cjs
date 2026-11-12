const { readSteps } = require('../read-steps.cjs');
const { fail } = require('../../../../shared/errors.cjs');
const { duration } = require('../../cabinet/validation.cjs');
const { serviceOwner } = require('../../services/catalog.cjs');
const { serviceMatches } = require('../language/services/service-matching.cjs');

// Trusted internal projections only. Never put the catalog or identities into a model prompt.
function appointmentContext(c, staffId = '') {
  return readSteps(function* () {
    c.assertCurrent?.();
    const current = c.current;
    if (
      !current?.organizationId ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(current.role)
    )
      throw fail(403, 'Нет доступа к записи этой организации.');
    const snapshot = c.assistantReads ? yield c.assistantReads.appointmentContext() : null;
    const all = snapshot ? snapshot.members : c.platform.workspaceMembers(current.organizationId);
    const ownerId = all.find((member) => member.role === 'owner')?.accountId || '';
    const members = all
      .filter(
        (member) =>
          member.status === 'active' &&
          ['owner', 'cosmetologist'].includes(member.role) &&
          (current.role !== 'cosmetologist' || member.accountId === current.accountId) &&
          (!staffId || member.accountId === staffId),
      )
      .map(({ accountId, displayName, role }) => ({ accountId, displayName, role }));
    if (staffId && !members.length)
      throw fail(403, 'Выберите доступного специалиста этой организации.');
    const allowed = new Set(members.map((member) => member.accountId));
    const services = (
      snapshot ? snapshot.services : c.tenantStore(current.organizationId).readServices()
    )
      .filter((service) => allowed.has(serviceOwner(service, ownerId)))
      .map((service) => ({
        id: service.id,
        name: service.name,
        duration: duration(service.duration ?? 60),
        staffId: serviceOwner(service, ownerId),
        ...(typeof service.category === 'string' && service.category
          ? { category: service.category }
          : {}),
      }))
      .filter(
        (service) =>
          Number.isSafeInteger(service.duration) &&
          service.duration >= 5 &&
          service.duration <= 1440 &&
          service.duration % 5 === 0,
      );
    return { members, ownerId, services };
  }).call(this);
}
function resolveService(services, query) {
  return services.filter((service) => serviceMatches(service.name, query));
}
module.exports = { appointmentContext, resolveService };
