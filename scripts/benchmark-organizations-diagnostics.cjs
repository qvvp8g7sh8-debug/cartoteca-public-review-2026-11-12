// Aggregate only bounded, allowlisted classifications; never retain messages or request data.
const names = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'AssertionError',
  'RangeError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'UnresolvedWrite',
]);
const codes = new Set([
  'ERR_ASSERTION',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INVALID_STATE',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_HTTP_HEADERS_SENT',
  'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
  'ERR_SQLITE_ERROR',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'UND_ERR_DESTROYED',
  'UND_ERR_CLOSED',
  'UND_ERR_INVALID_ARG',
  'UND_ERR_INVALID_RETURN_VALUE',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_RESPONSE_EXCEEDED_MAX_SIZE',
]);
const routes = new Set([
  'search',
  'calendar',
  'card',
  'save',
  'public-info',
  'public-dates',
  'public-availability',
  'receipt',
  'verify',
  'isolation',
]);
const stages = new Set([
  'request-prepare',
  'fetch',
  'response-status',
  'http-status',
  'response-release',
  'response-decode',
  'response-assertion',
  'action',
  'action-prepare',
  'unknown-write-guard',
  'receipt-assertion',
  'verification-assertion',
]);
const remembered = new WeakMap();
const objectLike = (value) => value !== null && ['object', 'function'].includes(typeof value);
function field(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}
function code(value) {
  return codes.has(value) ? value : value == null ? null : 'other';
}
function status(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function captureFailure(error, context = {}) {
  const name = field(error, 'name');
  const result = Object.freeze({
    route: routes.has(context.route) ? context.route : 'other',
    stage: stages.has(context.stage) ? context.stage : 'action',
    name: names.has(name) ? name : 'OtherError',
    code: code(field(error, 'code')),
    causeCode: code(field(field(error, 'cause'), 'code')),
    httpStatus: Object.hasOwn(context, 'httpStatus')
      ? status(context.httpStatus)
      : status(field(error, 'status')),
  });
  if (objectLike(error)) remembered.set(error, result);
  return result;
}
function failureDetails(error, context = {}) {
  return (objectLike(error) && remembered.get(error)) || captureFailure(error, context);
}
function createFailureSummary(maxGroups = 64) {
  if (!Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 256)
    throw Error('Invalid synthetic diagnostic group limit');
  const groups = new Map();
  let total = 0,
    otherCount = 0;
  return {
    add(error, context) {
      this.addDetails(failureDetails(error, context));
    },
    addDetails(value) {
      // Re-sanitize even supplied records: callers cannot smuggle data into a result.
      const detail = captureFailure(
        { name: value.name, code: value.code, cause: { code: value.causeCode } },
        value,
      );
      const key = JSON.stringify(detail);
      total++;
      const previous = groups.get(key);
      if (previous) previous.count++;
      else if (groups.size < maxGroups) groups.set(key, { ...detail, count: 1 });
      else otherCount++;
    },
    snapshot() {
      return { total, groups: [...groups.values()].map((group) => ({ ...group })), otherCount };
    },
  };
}
function summarizeFailures(samples) {
  const summary = createFailureSummary();
  for (const sample of samples) if (sample.failure) summary.addDetails(sample.failure);
  return summary.snapshot();
}
module.exports = { captureFailure, failureDetails, createFailureSummary, summarizeFailures };
