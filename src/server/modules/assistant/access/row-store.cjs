const { initialState, validateState } = require('./defaults.cjs');
const { validate } = require('./row-schema.cjs');
const { createRowReader } = require('./row-state.cjs');
const { createRowAccounting } = require('./row-accounting.cjs');
const {
  importRows,
  updateAdmin,
  writeSettings,
  writeHistory,
  writeGrant,
  requireTransaction,
} = require('./row-write.cjs');
const { readSentinel } = require('./row-sentinel.cjs');
function snapshot(context, callback) {
  if (context.db.isTransaction) return callback();
  // Initial scope reads are fresh RR reads, not reservations. The accounting
  // callback rechecks them under its policy barrier before any state change.
  if (
    context.db.dialect === 'postgres' &&
    context.db.revisionProfile === 3 &&
    context.readOnlySnapshot
  )
    return context.readOnlySnapshot(callback);
  if (context.readSnapshot) return context.readSnapshot(callback);
  context.db.exec('BEGIN DEFERRED');
  try {
    const result = callback();
    context.db.exec('COMMIT');
    return result;
  } catch (error) {
    if (context.db.isTransaction) context.db.exec('ROLLBACK');
    throw error;
  }
}
function createAssistantRowStore(context, { directory, validateFence = true } = {}) {
  const registration = validate(context.db, { required: true });
  if (validateFence) readSentinel({ ...context, directory }, registration);
  const reader = createRowReader(context, registration),
    accounting = createRowAccounting(context, registration, reader);
  return {
    backend: 'rows-v1',
    registration,
    readPolicy: reader.readPolicy,
    readScope: reader.readScope,
    grant: reader.grant,
    month: reader.month,
    day: reader.day,
    readSnapshot: (callback) => snapshot(context, callback),
    adminSnapshot: () => snapshot(context, reader.adminSnapshot),
    updateAdmin: (callback) => updateAdmin(context, registration, reader, callback),
    reservePilot: accounting.reservePilot,
    markOutbound: accounting.markOutbound,
    settlePilot: accounting.settlePilot,
    exportLegacyState: () =>
      snapshot(context, () => validateState(reader.adminSnapshot({ fullUsage: true }))),
  };
}
function resetRestoredRows(context) {
  requireTransaction(context.db);
  const registration = validate(context.db, { required: true }),
    reader = createRowReader(context, registration);
  const accounting = createRowAccounting(context, registration, reader);
  for (const row of context.db
    .prepare('SELECT id FROM assistant_reservations ORDER BY id')
    .iterate())
    accounting.settleNow(row, null);
  const state = { ...initialState(), ...structuredClone(reader.readPolicy()) };
  state.revision++;
  state.policy.mode = 'off';
  state.credentials = {};
  state.behavior = { version: state.behavior.version + 1, current: null, history: [] };
  writeSettings(context, registration, state);
  writeHistory(context, registration, state);
  for (const row of context.db.prepare('SELECT * FROM assistant_grants').all())
    writeGrant(context, registration, reader.decodeGrant(row), row.position, false);
  context.db.exec('DELETE FROM assistant_admin_operations;');
  return { mode: 'off', accountingPreserved: true };
}
module.exports = {
  createAssistantRowStore,
  importRows,
  resetRestoredRows,
  validateSnapshot: (...args) => require('./row-validation.cjs').validateSnapshot(...args),
};
