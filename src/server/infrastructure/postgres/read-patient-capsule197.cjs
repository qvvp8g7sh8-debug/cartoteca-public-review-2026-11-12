const { createPatientHistoryReader } = require('../patient-history-read145.cjs');
const { editSelection } = require('../../modules/cabinet/appointment-edit161.cjs');
const { historyLookup } = require('./read-history-bundle152.cjs');
const { fail } = require('../../../shared/errors.cjs');

// A transport hint only. It contains no cursor/crypto/authority proof; the
// existing canonical projector runs with freshly checked keys after SQL.
function prepareUnkeyedPatientSelection198({ url, current, catalog }) {
  if (
    catalog?.version !== 2 ||
    !catalog.tables?.cabinet_history_entries ||
    !catalog.tables?.cabinet_history_manifests ||
    !['owner', 'salon_admin'].includes(current?.role) ||
    current.globalAdmin ||
    url.searchParams.get('cursor')
  )
    return null;
  let kind,
    id,
    appointmentId = null;
  if (url.pathname === '/api/cabinet/patient' && url.searchParams.get('view') === 'appointment') {
    if (url.searchParams.get('details') === '1') return null;
    const selected = editSelection(url);
    kind = 'appointment';
    id = selected.patientId;
    appointmentId = selected.id;
  } else {
    kind =
      url.pathname === '/api/cabinet/patient/history'
        ? 'history'
        : url.pathname === '/api/cabinet/patient/upcoming'
          ? 'upcoming'
          : url.pathname === '/api/cabinet/patient' && url.searchParams.get('view') === 'card'
            ? 'card'
            : null;
    if (!kind) return null;
    id = url.searchParams.get('id') || url.searchParams.get('patientId');
    if (typeof id !== 'string' || !id || id.length > 120) throw fail(400, 'Укажите карточку.');
  }
  if (!current.sessionId || !current.accountId || !current.organizationId)
    throw fail(403, 'Сеанс завершён.');
  return { kind, id, appointmentId, audience: '*', cursor: { visit: 0, outcome: 0, upcoming: 0 } };
}

function preparePatientCapsule197({ url, current, crypto, catalog }) {
  if (catalog?.version !== 2) return null;
  if (url.pathname === '/api/cabinet/patient' && url.searchParams.get('view') === 'appointment') {
    if (url.searchParams.get('details') === '1') return null;
    const selection = editSelection(url);
    return {
      kind: 'appointment',
      id: selection.patientId,
      appointmentId: selection.id,
      audience: current.role === 'cosmetologist' ? crypto.hash('staff:' + current.accountId) : '*',
      cursor: { visit: 0, outcome: 0, upcoming: 0 },
    };
  }
  if (
    !['/api/cabinet/patient/history', '/api/cabinet/patient/upcoming'].includes(url.pathname) &&
    !(url.pathname === '/api/cabinet/patient' && url.searchParams.get('view') === 'card')
  )
    return null;
  const reader = createPatientHistoryReader({
    db: { catalog },
    encode: crypto.encode,
    decode: crypto.decode,
    hash: crypto.hash,
    schemaVersion: 2,
  });
  if (!reader.supported) return null;
  const { id, mode, cursor } = reader.parameters(current, url);
  return {
    kind: mode,
    id,
    appointmentId: null,
    audience: current.role === 'cosmetologist' ? crypto.hash('staff:' + current.accountId) : '*',
    cursor: { visit: cursor.visit, outcome: cursor.outcome, upcoming: cursor.upcoming },
  };
}

function patientCapsule197(operation, selection) {
  if (!selection || typeof operation.patientCapsule197 !== 'function') return null;
  const packet = operation.patientCapsule197(selection);
  if (packet === null) return null;
  if (
    !packet ||
    typeof packet.then === 'function' ||
    !Array.isArray(packet.rows) ||
    !packet.bound ||
    typeof packet.bound !== 'object'
  )
    throw Object.assign(Error('Invalid admitted patient capsule'), {
      status: 503,
      code: 'POSTGRES_PATIENT_CAPSULE',
    });
  return packet;
}

function projectPatientCapsule197(packet, reader, current, url) {
  return reader.readPrepared(current, url, historyLookup(packet.rows));
}

module.exports = {
  prepareUnkeyedPatientSelection198,
  preparePatientCapsule197,
  patientCapsule197,
  projectPatientCapsule197,
};
