const crypto = require('node:crypto');
const { openValue } = require('./snapshot.cjs');
const { readStateBytes } = require('../../modules/assistant/access/state-file.cjs');
const { validateState } = require('../../modules/assistant/access/defaults.cjs');
const rows = require('../../modules/assistant/access/row-schema.cjs');
const sentinel = require('../../modules/assistant/access/row-sentinel.cjs');
const repository = require('../../modules/assistant/access/row-store.cjs');

// Offline context only: never instantiate runtime services, grants or providers.
function assistantContext(db, key, directory) {
  return {
    db,
    directory,
    id: crypto.randomUUID,
    open: (value) => JSON.parse(openValue(key, value).toString('utf8')),
    seal(value) {
      const iv = crypto.randomBytes(12),
        cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
  };
}
function validateAssistantSnapshot(context) {
  const registration = rows.validate(context.db);
  if (registration) {
    sentinel.readSentinel(context, registration);
    repository.validateSnapshot(context, registration);
  } else {
    const bytes = readStateBytes(context.directory);
    if (bytes) validateState(context.open(bytes));
  }
  return registration;
}
function resetRestoredAssistantRows(context) {
  const registration = rows.validate(context.db);
  if (!registration) return false;
  if (!context.db.isTransaction)
    throw Error('Restored assistant rows require platform transaction');
  sentinel.readSentinel(context, registration);
  repository.resetRestoredRows(context);
  repository.validateSnapshot(context, registration);
  return true;
}
module.exports = { assistantContext, validateAssistantSnapshot, resetRestoredAssistantRows };
