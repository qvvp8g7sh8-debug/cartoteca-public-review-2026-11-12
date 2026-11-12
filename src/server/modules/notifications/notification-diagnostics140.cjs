const phases = new Set([
  'planning',
  'discovery',
  'recovery',
  'rebuild',
  'dispatch',
  'delivery',
  'lease',
  'poll',
]);
const codes = new Set([
  'POSTGRES_BUSY',
  'POSTGRES_RPC_TIMEOUT',
  'POSTGRES_QUERY_ONLY',
  'POSTGRES_SCOPED_QUEUE_FORBIDDEN',
  'POSTGRES_SCOPED_QUEUE_SCOPE_INVALID',
  'POSTGRES_TRANSACTION_ORDER',
  'POSTGRES_COMPOUND_UNAVAILABLE',
  'POSTGRES_READ_BUNDLE_SCOPE',
  'POSTGRES_READ_BUNDLE_SCHEMA',
  'POSTGRES_READ_BUNDLE_CAPACITY',
  'POSTGRES_READ_BUNDLE_INVALID',
  'POSTGRES_CLOSED',
  'POSTGRES_NOT_READY',
  'POSTGRES_REENTRANT_RPC',
  'POSTGRES_COMMAND_TOO_LARGE',
  'POSTGRES_REPLY_TOO_LARGE',
  'POSTGRES_PROTOCOL_ERROR',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ERR_SQLITE_BUSY',
  'ABORT_ERR',
]);
const origins = new WeakMap();
function markNotificationPhase(error, phase) {
  if (error && (typeof error === 'object' || typeof error === 'function') && phases.has(phase))
    origins.set(error, phase);
}
// Closed technical enums only. No message/stack, tenant, payload or provider data.
function createNotificationDiagnostics() {
  let failures = 0,
    last = null;
  return {
    record(phase, error) {
      failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1);
      last = {
        phase: phases.has(phase) ? phase : 'planning',
        code: 'UNCLASSIFIED',
        status: null,
        retryableBeforeBegin: false,
        outcomeUnknown: false,
        channelPoisoned: false,
      };
      try {
        if (origins.has(error)) last.phase = origins.get(error);
        last.code =
          [error?.postgresCode, error?.code].find((code) => codes.has(code)) || 'UNCLASSIFIED';
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599)
          last.status = error.status;
        for (const key of ['retryableBeforeBegin', 'outcomeUnknown', 'channelPoisoned'])
          last[key] = error?.[key] === true;
      } catch {
        /* Diagnostics never change the original operation's outcome. */
      }
    },
    snapshot: () => ({ failures, last: last ? { ...last } : null }),
  };
}
module.exports = { markNotificationPhase, createNotificationDiagnostics };
