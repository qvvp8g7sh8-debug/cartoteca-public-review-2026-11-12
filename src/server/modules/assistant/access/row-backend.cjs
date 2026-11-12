const { validate } = require('./row-schema.cjs');
const { readSentinel } = require('./row-sentinel.cjs');
const { readStateBytes } = require('./state-file.cjs');
function assertAssistantStateBackend(context, { directory, backend = 'file' } = {}) {
  if (!['file', 'rows-v1'].includes(backend)) throw Error('Unsupported assistant state backend');
  const registration = context.db ? validate(context.db) : null;
  if (backend === 'rows-v1') {
    if (!registration) throw Error('Prepare complete assistant rows copy before startup');
    readSentinel({ ...context, directory }, registration);
    return registration;
  }
  if (registration) throw Error('Prepared assistant rows require rows-v1 backend');
  // Preserve lazy failure handling for an ordinary damaged legacy file. Only an
  // authenticated rows fence without its SQL component is an eager mode failure.
  let value;
  try {
    const bytes = readStateBytes(directory);
    if (bytes) value = context.open(bytes);
  } catch {
    return null;
  }
  if (value?.schema === 'assistant-rows-v1-only')
    throw Error('Assistant rows component is missing');
  return null;
}
module.exports = { assertAssistantStateBackend };
