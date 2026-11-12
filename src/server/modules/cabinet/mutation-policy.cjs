const { fail } = require('../../../shared/errors.cjs');
const { validateState } = require('./validation.cjs');
const { alignEarlierVisits, assertLifecycleChange } = require('./lifecycle.cjs');
const { authorizeCabinetChange, assertPhotoReferences } = require('../access/cabinet-policy.cjs');
const { assertReservationChanges } = require('../booking/reservation-guard.cjs');

function assertPlan(platform, current, next, before, storage, partial) {
  const plan = platform.subscription(current.organizationId);
  if (plan.status !== 'active') throw fail(403, 'Доступ по тарифу приостановлен.');
  const countPhotos = (patients) =>
    patients.reduce(
      (sum, p) => sum + p.visits.reduce((count, v) => count + (v.photos || []).length, 0),
      0,
    );
  const totals = partial ? storage.indexes.totals() : { patients: 0, photos: 0, services: 0 };
  const patients = next.patients.length + (partial ? totals.patients - before.patients.length : 0);
  const services = next.services.length + (partial ? totals.services - before.services.length : 0);
  if (patients > 20000 || services > 2000) throw fail(400, 'Превышено число карточек или услуг.');
  if (patients > plan.limits.patients)
    throw fail(402, `Тариф: не более ${plan.limits.patients} клиентов.`);
  const photos =
    countPhotos(next.patients) + (partial ? totals.photos - countPhotos(before.patients) : 0);
  if (photos > plan.limits.photos)
    throw fail(402, `Тариф: не более ${plan.limits.photos} фотографий.`);
}
function assertChange(
  platform,
  current,
  before,
  next,
  storage,
  partial,
  acknowledgement,
  acceptance,
) {
  validateState(next);
  alignEarlierVisits(before, next);
  assertPlan(platform, current, next, before, storage, partial);
  assertLifecycleChange(before, next, {
    actorId: current.accountId,
    timeZone: platform.organizationTimeZone(current.organizationId),
  });
  authorizeCabinetChange(current, before, next);
  platform.personalEvents?.assertAppointments(current.organizationId, before, next);
  // Local to this synchronous validation. Reloaded after every await and under writer.
  const identities = platform.workspaceIdentities(current.organizationId);
  platform.workSchedules.assertChanges(current, before, next, acknowledgement, identities);
  assertReservationChanges(platform, current.organizationId, before, next, Date.now(), acceptance);
  assertPhotoReferences(current, next, (id) => storage.indexes.photoVisible(id, current));
  platform.assertServiceGroups(current.organizationId, before, next);
  platform.assertServiceCatalog(current.organizationId, before, next, storage, identities);
  if (partial) {
    storage.indexes.assertUnique(
      next.patients,
      before.patients.map((p) => p.id),
    );
    platform.assertWorkspaceSelection(current.organizationId, next, storage, identities);
  } else platform.assertWorkspace(current.organizationId, next, identities);
}
module.exports = { assertChange };
