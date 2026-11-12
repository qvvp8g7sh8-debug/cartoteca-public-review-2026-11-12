const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { safeTree, plainFile, readKey } = require('../infrastructure/backup/snapshot.cjs');
const { syncFile, syncDirectory } = require('../infrastructure/backup/durable.cjs');
const { configureSqlite } = require('../infrastructure/sqlite-configuration.cjs');
const { validatePaidSchema } = require('../modules/billing/prepared-schema.cjs');
const { initialState, validateState } = require('../modules/assistant/access/defaults.cjs');
const {
  stateName,
  MAX_BYTES,
  readStateBytes,
} = require('../modules/assistant/access/state-file.cjs');
const rows = require('../modules/assistant/access/row-schema.cjs');
const repository = require('../modules/assistant/access/row-store.cjs');
const sentinel = require('../modules/assistant/access/row-sentinel.cjs');
const {
  assistantContext,
  validateAssistantSnapshot,
} = require('../infrastructure/backup/assistant-state.cjs');
const MARKER = 'assistant-state-rows-preparation-v1';

function replaceState(directory, bytes) {
  const target = path.join(directory, stateName),
    temporary = path.join(directory, '.assistant-prepare-' + randomUUID() + '.tmp');
  if (fs.existsSync(target)) plainFile(target);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    syncFile(temporary);
    fs.renameSync(temporary, target);
    syncDirectory(directory);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function migrateAssistantStateRows(directory, { rollback = false } = {}) {
  directory = path.resolve(directory);
  safeTree(directory);
  const marker = path.join(path.dirname(directory), '.restore-in-progress');
  plainFile(marker);
  if (fs.readFileSync(marker, 'utf8') !== MARKER)
    throw Error('Assistant rows require an offline preparation copy');
  const filename = path.join(directory, 'platform.sqlite');
  plainFile(filename);
  const key = readKey(path.join(directory, 'platform.key')),
    db = new DatabaseSync(filename);
  try {
    configureSqlite(db);
    db.exec('PRAGMA foreign_keys=ON');
    const platformVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (![19, 20].includes(platformVersion))
      throw Error('Unsupported assistant rows platform schema');
    validatePaidSchema(db);
    const context = assistantContext(db, key, directory);
    const previous = validateAssistantSnapshot(context);
    if (rollback ? !previous : Boolean(previous))
      throw Error('Unexpected source assistant state backend');
    const sourceBytes = readStateBytes(directory);
    let bytes, receipt;
    db.exec('BEGIN IMMEDIATE');
    if (rollback) {
      // Export CURRENT rows, including post-activation changes. Never restore the
      // import file or silently truncate data that an old binary cannot represent.
      const current = repository
        .createAssistantRowStore(context, { directory })
        .exportLegacyState();
      validateState(current);
      bytes = context.seal(current);
      if (bytes.length > MAX_BYTES) throw Error('Assistant rows cannot fit the legacy state limit');
      for (const table of [...rows.tables].reverse()) db.exec('DROP TABLE ' + table);
      db.exec('DROP TABLE assistant_state_schema');
      receipt = { exportedRevision: current.revision };
    } else {
      const state = sourceBytes ? validateState(context.open(sourceBytes)) : initialState();
      const sourceHash = createHash('sha256')
        .update(sourceBytes || Buffer.alloc(0))
        .digest('hex');
      db.exec(rows.schema);
      const imported = repository.importRows(context, state, {
        storeId: randomUUID(),
        sourceHash,
        now: Date.now(),
      });
      const registration = rows.validate(db, { required: true });
      repository.validateSnapshot(context, registration);
      bytes = sentinel.sealSentinel(context, registration);
      receipt = {
        importedRevision: registration.imported_revision,
        importSummary: {
          grants: imported.grants,
          reservations: imported.reservations,
          orphanReservations: imported.orphanReservations,
          months: imported.months,
          ...(imported.rounding ? { rounding: imported.rounding } : {}),
        },
      };
    }
    validatePaidSchema(db);
    if (
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw Error('Assistant rows preparation integrity failed');
    db.exec('COMMIT');
    // The already-durable parent marker keeps every startup blocked across the
    // SQL/file boundary. Failure retains that marker and the original source.
    replaceState(directory, bytes);
    validateAssistantSnapshot(context);
    return {
      componentVersion: rollback ? 0 : 1,
      platformVersion,
      backend: rollback ? 'file' : 'rows-v1',
      ...receipt,
    };
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
module.exports = { migrateAssistantStateRows, MARKER };
