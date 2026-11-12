const { stateName, MAX_BYTES, readStateBytes } = require('./state-file.cjs');
function createSentinel(registration) {
  return {
    schema: 'assistant-rows-v1-only',
    componentVersion: 1,
    storeId: registration.store_id,
    importSha256: registration.import_sha256,
  };
}
function sealSentinel(context, registration) {
  return context.seal(createSentinel(registration));
}
function readSentinel(context, registration) {
  const bytes = readStateBytes(context.directory);
  if (
    !bytes ||
    bytes.length > MAX_BYTES ||
    JSON.stringify(context.open(bytes)) !== JSON.stringify(createSentinel(registration))
  )
    throw Error('Assistant rows legacy fence mismatch');
  return true;
}
module.exports = { stateName, createSentinel, sealSentinel, readSentinel };
