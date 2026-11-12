const roles = new Set(['web', 'background', 'command']);
const phases = new Set([
  'handshake',
  'postgres-owner',
  'composition',
  'lifecycle',
  'background',
  'identity',
  'listener',
  'ready',
]);
const causes = new Set([
  'POSTGRES_BUSY',
  'ERR_SQLITE_ERROR',
  'POSTGRES_EXECUTOR_FAILED',
  'POSTGRES_REVISION_PROFILE_INVALID',
  'POSTGRES_ASSET_LINEAGE_MISMATCH',
  'POSTGRES_ASSET_LINEAGE_REQUIRED',
  'POSTGRES_SCOPE_INVALID',
  'POSTGRES_CHANNEL_POISONED',
  'POSTGRES_SERVER_AUTHORITY_LOST',
  'POSTGRES_AUTHORITY_BUSY',
  'POSTGRES_AUTHORITY_UNAVAILABLE',
  'POSTGRES_QUERY_ONLY',
  'POSTGRES_TRANSACTION_ORDER',
  'POSTGRES_TRANSACTION_NESTING',
  'POSTGRES_RESULT_INVALID',
  'POSTGRES_INTEGER_RANGE',
  'NATIVE_MEMORY_ATTESTATION',
  'NATIVE_MEMORY_BUDGET_MISMATCH',
  'NATIVE_LISTENER_FAILED',
  'NATIVE_STARTUP_FAILED',
  '55P03',
  '57014',
  '40001',
  '40P01',
  '23505',
  '42501',
  '42P01',
  '42804',
  'EADDRINUSE',
  'EACCES',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UNCLASSIFIED',
]);
// Closed technical categories only. Never copy raw text, SQL, arguments, paths,
// serialized errors or provider/account details across the diagnostic boundary.
function nativeFailureDiagnostic(role, phase, error) {
  const candidate = causes.has(error?.postgresCode) ? error.postgresCode : error?.code;
  return {
    role: roles.has(role) ? role : 'unknown',
    phase: phases.has(phase) ? phase : 'unknown',
    cause: causes.has(candidate) ? candidate : 'UNCLASSIFIED',
  };
}
module.exports = { nativeFailureDiagnostic };
