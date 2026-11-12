const SQLSTATE =
  /^(?:00|01|02|03|08|09|0A|0B|0F|0L|0P|0Z|20|21|22|23|24|25|26|27|28|2B|2D|2F|34|38|39|3B|3D|3F|40|42|44|53|54|55|57|58|72|F0|HV|P0|XX)[0-9A-Z]{3}$/;
const CODES = new Set([
  'POSTGRES_ROLE_AUTHORITY_ARGUMENT',
  'POSTGRES_ROLE_AUTHORITY_UNAVAILABLE',
  'POSTGRES_ROLE_AUTHORITY_BUSY',
  'POSTGRES_ROLE_AUTHORITY_CONFLICT',
  'POSTGRES_ROLE_AUTHORITY_CAPACITY',
  'POSTGRES_ROLE_AUTHORITY_LOST',
  'POSTGRES_ROLE_AUTHORITY_QUERY_FAILED',
  'POSTGRES_ROLE_AUTHORITY_CLOSE_TIMEOUT',
  'POSTGRES_ROLE_SCHEMA_INVALID',
  'POSTGRES_ROLE_LINEAGE_MISMATCH',
  'POSTGRES_ROLE_CHANNEL_PROTOCOL',
  'POSTGRES_ROLE_COORDINATION_REQUIRED',
  'POSTGRES_QUEUE_WRITE_FORBIDDEN',
  'POSTGRES_PROVISION_INTENT_FORBIDDEN',
  'POSTGRES_AUTHORITY_INTENT_FORBIDDEN',
  'ERR_SQLITE_ERROR',
  'POSTGRES_ARGUMENT_COUNT',
  'POSTGRES_ASSET_LINEAGE_MISMATCH',
  'POSTGRES_ASYNC_TRANSACTION',
  'POSTGRES_AUTHORITY_ALREADY_OWNED',
  'POSTGRES_AUTHORITY_BUSY',
  'POSTGRES_AUTHORITY_LOST',
  'POSTGRES_AUTHORITY_UNAVAILABLE',
  'POSTGRES_BUSY',
  'POSTGRES_CATALOG_INVALID',
  'POSTGRES_CATALOG_VERSION_MISMATCH',
  'POSTGRES_CHANNEL_POISONED',
  'POSTGRES_CLOSED',
  'POSTGRES_COMMAND_TOO_LARGE',
  'POSTGRES_CONNECTION_FAILED',
  'POSTGRES_CONTROL_INVALID',
  'POSTGRES_CURSOR_LIMIT',
  'POSTGRES_CURSOR_READ_ONLY',
  'POSTGRES_CURSOR_SCOPE',
  'POSTGRES_FENCE_RELEASE_FAILED',
  'POSTGRES_INTEGER_RANGE',
  'POSTGRES_ISOLATED_OWNER_REQUIRED',
  'POSTGRES_NOT_READY',
  'POSTGRES_NUMERIC_RANGE',
  'POSTGRES_OPERATION_INVALID',
  'POSTGRES_PLAN_INVALID',
  'POSTGRES_PROTOCOL_ERROR',
  'POSTGRES_PROVISION_SCOPE',
  'POSTGRES_QUERY_FAILED',
  'POSTGRES_QUERY_ONLY',
  'POSTGRES_REENTRANT_RPC',
  'POSTGRES_REPLY_TOO_LARGE',
  'POSTGRES_RESULT_INVALID',
  'POSTGRES_RPC_TIMEOUT',
  'POSTGRES_SCHEMA_INVALID',
  'POSTGRES_SCOPE_INVALID',
  'POSTGRES_SQL_INVALID',
  'POSTGRES_STARTUP_TIMEOUT',
  'POSTGRES_STORE_MISSING',
  'POSTGRES_TEMPLATE_MISSING',
  'POSTGRES_TIMEOUT_INVALID',
  'POSTGRES_TRANSACTION_MISSING',
  'POSTGRES_TRANSACTION_MODE',
  'POSTGRES_TRANSACTION_NESTING',
  'POSTGRES_TRANSACTION_ORDER',
  'POSTGRES_WORKER_EXIT',
  'POSTGRES_WORKER_FAILED',
]);
const boolean = (value) => (typeof value === 'boolean' ? value : null);
const code = (value) =>
  typeof value === 'string' && (CODES.has(value) || SQLSTATE.test(value)) ? value : 'UNKNOWN';
const ROLES = new Set(['combined', 'background', 'web']);
const MAX_RECORDS = 64;
function milliseconds(value, signed = false) {
  if (!Number.isFinite(value)) return null;
  return Math.trunc(Math.max(signed ? -86400000 : 0, Math.min(86400000, value)));
}
function cleanBeforeBeginBusy(error) {
  return Boolean(
    error?.postgres === true &&
    error.postgresCode === 'POSTGRES_BUSY' &&
    error.code === 'ERR_SQLITE_ERROR' &&
    error.errcode === 5 &&
    error.retryableBeforeBegin === true &&
    error.transactionOpen === false &&
    error.channelPoisoned === false &&
    error.outcomeUnknown !== true,
  );
}
function cleanLeaseBusy(error) {
  return Boolean(
    error?.postgres === true &&
    (error.code === 'POSTGRES_ROLE_AUTHORITY_BUSY' ||
      error.postgresCode === 'POSTGRES_ROLE_AUTHORITY_BUSY') &&
    error.leaseUnchanged === true &&
    error.transactionOpen === false &&
    error.channelPoisoned === false &&
    error.outcomeUnknown !== true,
  );
}
// Diagnostics describe the existing decision; they never authorize renewal,
// extend ownership, replay a transaction, stop delivery or change HTTP health.
function renewalRecord(error, timing, role) {
  const finiteTimes = [
    timing?.attemptedAt,
    timing?.expectedAt,
    timing?.finishedAt,
    timing?.confirmedUntil,
  ].every(Number.isFinite);
  const leaseExpired = finiteTimes ? timing.finishedAt >= timing.confirmedUntil : null;
  const beforeBeginBusy = error !== null && cleanBeforeBeginBusy(error);
  const leaseBusy = error !== null && cleanLeaseBusy(error);
  const renewalState =
    leaseExpired === null
      ? 'timing-unavailable'
      : error === null
        ? leaseExpired === true
          ? 'expired-not-renewed'
          : 'not-renewed'
        : error?.outcomeUnknown === true
          ? 'outcome-unknown'
          : error?.channelPoisoned === true
            ? 'channel-poisoned'
            : leaseBusy
              ? leaseExpired === true
                ? 'lease-busy-expired'
                : 'lease-busy-valid'
              : beforeBeginBusy
                ? leaseExpired === true
                  ? 'before-begin-busy-expired'
                  : 'before-begin-busy-valid'
                : leaseExpired === true
                  ? 'expired-exception'
                  : 'other-exception';
  return {
    event: 'background_role_renewal_failure',
    role: ROLES.has(role) ? role : 'unknown',
    renewalState,
    reason: error === null ? 'not_renewed' : 'exception',
    code: error === null ? 'LEASE_NOT_RENEWED' : code(error?.code),
    postgresCode: error === null ? null : code(error?.postgresCode),
    postgres: boolean(error?.postgres),
    retryableBeforeBegin: boolean(error?.retryableBeforeBegin),
    leaseUnchanged: boolean(error?.leaseUnchanged),
    transactionOpen: boolean(error?.transactionOpen),
    channelPoisoned: boolean(error?.channelPoisoned),
    outcomeUnknown: boolean(error?.outcomeUnknown),
    cleanBeforeBeginBusy: beforeBeginBusy,
    cleanLeaseBusy: leaseBusy,
    elapsedMs: finiteTimes ? milliseconds(timing.finishedAt - timing.attemptedAt) : null,
    timerLateMs: finiteTimes ? milliseconds(timing.attemptedAt - timing.expectedAt) : null,
    remainingLeaseMs: finiteTimes
      ? milliseconds(timing.confirmedUntil - timing.finishedAt, true)
      : null,
    leaseExpired,
  };
}
// One finite budget per owning server lifetime, no registry keyed by owners,
// tokens, SQL, error text or tenants and no additional timer/background work.
function createRoleRenewalDiagnostics({ role, write = console.error } = {}) {
  let records = 0,
    suppressed = 0;
  return {
    report(error, timing) {
      if (records >= MAX_RECORDS) {
        suppressed = Math.min(Number.MAX_SAFE_INTEGER, suppressed + 1);
        return false;
      }
      const sample = ++records;
      try {
        const record = renewalRecord(error, timing, role);
        record.sample = sample;
        record.diagnosticsCapped = records === MAX_RECORDS;
        write(JSON.stringify(record));
        return true;
      } catch {
        // The attempt consumed one budget item even if a getter/sink throws.
        // Never throw the original Error or any diagnostic sink exception.
        return false;
      }
    },
    stats: () => ({ records, suppressed, limit: MAX_RECORDS }),
  };
}
module.exports = { createRoleRenewalDiagnostics, renewalRecord };
