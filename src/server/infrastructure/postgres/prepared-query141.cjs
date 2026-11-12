// Connection-local server plans contain SQL only. Values, tenant settings and
// transaction authority are always supplied afresh by the ordinary driver.
function createPreparedQueries({ maxPlans = 48, maxBytes = 256 * 1024 } = {}) {
  const plans = new Map();
  const seen = new Map();
  let bytes = 0,
    seenBytes = 0,
    sequence = 0;
  return (text, values) => {
    const known = plans.get(text);
    if (known) return { text, values, name: known };
    const size = Buffer.byteLength(text);
    if (plans.size >= maxPlans || bytes + size > maxBytes || size > 32 * 1024 || text.includes(';'))
      return { text, values };
    // One-off inspection/cold SQL must not consume the bounded server plan set.
    if (seen.has(text)) {
      seen.delete(text);
      seenBytes -= size;
      const name = 'ct_query_' + ++sequence;
      plans.set(text, name);
      bytes += size;
      return { text, values, name };
    }
    while (seen.size && (seen.size >= 96 || seenBytes + size > maxBytes)) {
      const first = seen.keys().next().value;
      seenBytes -= Buffer.byteLength(first);
      seen.delete(first);
    }
    seen.set(text, true);
    seenBytes += size;
    return { text, values };
  };
}

// Queue dependent SQL on the same pg connection in order, then consume EVERY
// result before recovery. PostgreSQL still executes it sequentially; no SQL or
// tenant work is parallelized within a transaction.
async function orderedResults(start, { deferError = () => false } = {}) {
  const pending = [];
  try {
    for (const run of start) pending.push(Promise.resolve(run()));
  } catch (error) {
    pending.push(Promise.reject(error));
  }
  const results = await Promise.allSettled(pending);
  // A healthy client-side capacity fallback must never hide a later SQL error
  // that has aborted the physical transaction. All commands have drained first.
  const failures = results.filter((result) => result.status === 'rejected');
  const failure = failures.find((result) => !deferError(result.reason)) || failures[0];
  if (failure) throw failure.reason;
  return results.map((result) => result.value);
}
module.exports = { createPreparedQueries, orderedResults };
