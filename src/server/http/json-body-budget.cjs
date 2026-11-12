const { fail } = require('../../shared/errors.cjs');
// Raw body-capacity reservations, not an estimate of parsed heap/RSS.
function createJsonBodyBudget({
  maxBytes = 64 * 1024 * 1024,
  maxRequests = 32,
  maxLargePerIdentity = 1,
} = {}) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isInteger(maxRequests) ||
    maxRequests < 1 ||
    !Number.isInteger(maxLargePerIdentity) ||
    maxLargePerIdentity < 1
  )
    throw Error('Invalid JSON admission budget.');
  let bytes = 0,
    requests = 0;
  const identities = new Map();
  function acquire(limit, identity = 'anonymous') {
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error('Invalid JSON body limit.');
    const large = limit >= 1024 * 1024,
      key = String(identity),
      used = identities.get(key) || 0;
    if (
      limit > maxBytes ||
      bytes + limit > maxBytes ||
      requests >= maxRequests ||
      (large && used >= maxLargePerIdentity)
    )
      throw Object.assign(
        fail(503, 'Сервер обрабатывает другие загрузки. Повторите через несколько секунд.'),
        { code: 'UPLOAD_CAPACITY', retryAfter: 2, outcomeUnknown: false },
      );
    bytes += limit;
    requests++;
    if (large) identities.set(key, used + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bytes -= limit;
      requests--;
      if (large) {
        const next = identities.get(key) - 1;
        if (next) identities.set(key, next);
        else identities.delete(key);
      }
    };
  }
  return {
    acquire,
    stats: () => ({ bytes, requests, identities: identities.size, maxBytes, maxRequests }),
  };
}
// Shared by all HTTP server instances in this Node process, including legacy/setup.
const jsonBodyBudget = createJsonBodyBudget();
function createJsonBodyScope(identity, budget = jsonBodyBudget) {
  let closed = false;
  const holds = new Set();
  function retain(release) {
    let reading = true,
      done = false;
    const finish = () => {
      if (!done && closed && !reading) {
        done = true;
        holds.delete(finish);
        release();
      }
    };
    holds.add(finish);
    return () => {
      reading = false;
      finish();
    };
  }
  return {
    options: { identity, budget, retain },
    close() {
      closed = true;
      for (const finish of [...holds]) finish();
    },
  };
}
module.exports = { createJsonBodyBudget, jsonBodyBudget, createJsonBodyScope };
