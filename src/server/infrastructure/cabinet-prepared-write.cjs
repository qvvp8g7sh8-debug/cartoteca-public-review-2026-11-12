const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { createReadCacheBudget } = require('./read-cache-budget.cjs');

// These tickets are a disposable crypto optimization, never authorization or a
// replacement for current revision, lifecycle, photo, uniqueness or ACL checks.
function createPreparedWrites({
  prepare: buildPlan,
  budget = createReadCacheBudget({ maxBytes: 8 * 1024 * 1024 }),
  maxBytes = 4 * 1024 * 1024,
  copyInput = true,
}) {
  if (
    typeof buildPlan !== 'function' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    typeof copyInput !== 'boolean'
  )
    throw Error('Invalid prepared cabinet write options');
  const tickets = new WeakMap(),
    owner = {};
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
    return value;
  };
  function discard(token) {
    if (!token || !tickets.has(token)) return;
    tickets.delete(token);
    budget.remove(token);
  }
  function prepare(before, next, changedIds) {
    if (
      !maxBytes ||
      !Number.isSafeInteger(before?.revision) ||
      before.revision < 0 ||
      next?.revision !== before.revision ||
      next.patients.some((patient) =>
        patient.visits.some((visit) =>
          (visit.photos || []).some((photo) => String(photo.data).startsWith('data:')),
        ),
      )
    )
      return null;
    // Approximate retained serialized content (not total V8 heap). Reject large
    // imports before cloning/encrypting, and account tickets in the shared budget.
    const serialized = JSON.stringify({ before, next, changedIds });
    let bytes = 2 * Buffer.byteLength(serialized);
    if (bytes > maxBytes) return null;
    const binding = copyInput ? null : createHash('sha256').update(serialized).digest('hex');
    // The private storage builder is synchronous/read-only. Its compact ticket
    // retains only the binding and changed ciphers, never another full history.
    const snapshot = copyInput
        ? freeze(structuredClone({ before, next, changedIds }))
        : Object.freeze({ before, next, changedIds }),
      built = buildPlan(snapshot);
    if (!(built instanceof Map)) throw Error('Invalid prepared cabinet cipher plan');
    const plan = new Map();
    for (const [json, cipher] of built) {
      if (typeof json !== 'string' || !Buffer.isBuffer(cipher))
        throw Error('Invalid prepared cabinet cipher entry');
      bytes += 2 * Buffer.byteLength(json) + cipher.length;
      if (bytes > maxBytes) return null;
      plan.set(json, Buffer.from(cipher));
    }
    if (!plan.size) return null;
    const token = Object.freeze({});
    tickets.set(token, copyInput ? { ...snapshot, plan } : { binding, plan });
    if (!budget.retain(token, bytes, () => tickets.delete(token), owner)) {
      tickets.delete(token);
      return null;
    }
    return token;
  }
  function take(token, before, next, changedIds) {
    const ticket = token && tickets.get(token);
    if (!ticket) return null;
    discard(token);
    if (ticket.binding) {
      const binding = createHash('sha256')
        .update(JSON.stringify({ before, next, changedIds }))
        .digest('hex');
      return binding === ticket.binding ? ticket.plan : null;
    }
    if (
      before?.revision !== ticket.before.revision ||
      next?.revision !== ticket.next.revision ||
      !isDeepStrictEqual(before, ticket.before) ||
      !isDeepStrictEqual(next, ticket.next) ||
      !isDeepStrictEqual(changedIds, ticket.changedIds)
    )
      return null;
    return ticket.plan;
  }
  return { prepare, take, discard, clear: () => budget.releaseOwner(owner) };
}

module.exports = { createPreparedWrites };
