const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { patientFullName } = require('../../../shared/patient-names.cjs');
const { cachedRows } = require('../cabinet/directory.cjs');

function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^[78]\d{10}$/.test(digits) && !/^\s*\+8/.test(value) ? '7' + digits.slice(1) : digits;
}
function matchingContacts(storage, phone, organizationId) {
  const key = phoneKey(phone);
  return cachedRows(storage, { role: 'owner', organizationId }).rows.filter(
    (p) => phoneKey(p.phone) === key,
  );
}
function requestContacts(context, id) {
  if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Выберите заявку.');
  const { platform, token, current } = context;
  const storage = context.tenantStore(current.organizationId);
  return compoundMutation(platform, storage, current.organizationId, 'booking', () => {
    context.assertCurrent();
    const actor = platform.onlineBooking.actor(token);
    if (actor.organizationId !== current.organizationId) throw fail(403, 'Кабинет изменился.');
    const record = platform.bookingRequests.get(actor.organizationId, id);
    if (!record) throw fail(404, 'Заявка не найдена.');
    platform.onlineBooking.assertRequestPermission(token, record.staffId);
    const matches = matchingContacts(storage, record.phone, actor.organizationId),
      visible = new Set(
        storage.indexes
          .summaries(
            actor,
            matches.map((p) => p.id),
          )
          .map((p) => p.id),
      );
    const needsAdministrator = matches.some((p) => !visible.has(p.id));
    if (matches.length > 50) throw fail(409, 'Слишком много совпадений. Проверьте дубли карточек.');
    return {
      needsAdministrator,
      items: needsAdministrator
        ? []
        : matches.map((p) => ({ id: p.id, name: patientFullName(p), phone: p.phone })),
    };
  });
}
module.exports = { phoneKey, matchingContacts, requestContacts };
