const { fail } = require('../../../shared/errors.cjs');
// A read-only connection refresh for an already-visible partial card. Client
// IDs select canonical rows; they cannot grant visibility or supply their values.
function patientViewStatus(context, { appointments = true } = {}) {
  const { url, current } = context;
  if (url.searchParams.get('view') !== 'card') return null;
  const patientId = url.searchParams.get('patientId');
  if (!patientId || patientId.length > 120) throw fail(400, 'Укажите карточку.');
  const requestUrl = new URL(url);
  requestUrl.searchParams.set('id', patientId);
  const text = url.searchParams.get('appointmentIds');
  let ids = [];
  if (appointments) {
    try {
      const revision = url.searchParams.get('revision');
      if (
        revision === null ||
        !/^(0|[1-9][0-9]*)$/.test(revision) ||
        !Number.isSafeInteger(Number(revision))
      )
        throw Error('revision');
      if (text === null || text.length > 16384) throw Error('ids');
      ids = JSON.parse(text);
      if (
        !Array.isArray(ids) ||
        ids.length > 50 ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => typeof id !== 'string' || !id || id.length > 120)
      )
        throw Error('ids');
    } catch {
      throw fail(400, 'Укажите до 50 записей карточки.');
    }
  }
  const storage = context.tenantStore(current.organizationId);
  if (!storage.patientViewAppointments) return { viewUnsupported: true };
  return storage.patientViewAppointments(current, requestUrl, ids);
}
module.exports = { patientViewStatus };
