// Only static stages/codes may enter request diagnostics. Never retain an error,
// message, stack, SQL, request body, cookie or identifier from the original failure.
const stages = new Set([
  'request-security',
  'request-auth',
  'request-body',
  'request-handler',
  'save-open',
  'save-identity',
  'save-initial-read',
  'save-validation',
  'photo-preparation',
  'save-preparation',
  'save-notification-intent',
  'save-intent-guard',
  'save-platform-lock',
  'save-cabinet-lock',
  'save-revalidation',
  'save-write',
  'save-receipt',
  'save-cabinet-commit',
  'save-trusted-commit',
  'save-platform-commit',
  'save-shared-lock',
  'save-shared-revalidation',
  'save-shared-write',
  'save-shared-commit',
  'save-response',
]);
const codes = new Set([
  'ERR_SQLITE_ERROR',
  'ERR_INVALID_STATE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ECONNRESET',
  'EPIPE',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EIO',
  'ENOENT',
  'EMFILE',
  'ENFILE',
]);
const names = new Set(['TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
function safeStage(value) {
  return stages.has(value) ? value : 'unclassified';
}
function safeFailure(error, status) {
  const result = {
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    code: 'OTHER',
    sqliteCode: null,
  };
  try {
    const code = error?.code,
      name = error?.name,
      errorStatus = error?.status,
      sqliteCode = error?.errcode;
    if (codes.has(code)) result.code = code;
    else if (names.has(name)) result.code = name;
    else if (Number.isInteger(errorStatus)) result.code = 'HTTP_ERROR';
    if (
      result.code === 'ERR_SQLITE_ERROR' &&
      Number.isInteger(sqliteCode) &&
      sqliteCode >= 1 &&
      sqliteCode <= 65535
    )
      result.sqliteCode = sqliteCode;
  } catch {
    // Even an unusual error object must not prevent the original response.
  }
  return result;
}
module.exports = { safeStage, safeFailure };
