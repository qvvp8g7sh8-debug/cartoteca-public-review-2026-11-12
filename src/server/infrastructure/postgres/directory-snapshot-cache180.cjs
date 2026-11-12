const {
  directorySnapshotIndexInfo180,
  directorySnapshotProofs185,
  createDirectorySnapshotIndex185,
  createDirectorySnapshotIndex196,
  resolveDirectorySnapshot196,
  peekDirectorySnapshot196,
  renderDirectorySnapshotProven196,
} = require('./directory-snapshot-index180.cjs');
function head196(value) {
  if (!value || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 256)
    return null;
  const result = { epoch: value.epoch };
  for (const key of ['seq', 'floorSeq', 'resetSeq']) {
    if (
      typeof value[key] !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(value[key]) ||
      BigInt(value[key]) > 9223372036854775807n
    )
      return null;
    result[key] = value[key];
  }
  return BigInt(result.floorSeq) <= BigInt(result.seq) &&
    BigInt(result.resetSeq) <= BigInt(result.seq)
    ? Object.freeze(result)
    : null;
}
const generation196 = (value) => value !== null && typeof value === 'object';
function createDirectorySnapshotCache180({
  budget,
  now = Date.now,
  ttlMs = 60000,
  maxEntries = 128,
  maxRows = budget?.directoryMaxRows ?? 50000,
} = {}) {
  if (
    !budget ||
    !['retain', 'touch', 'remove', 'releaseOwner'].every(
      (name) => typeof budget[name] === 'function',
    ) ||
    typeof now !== 'function' ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 60000 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 128 ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 150000
  )
    throw Error('Invalid private directory snapshot bounds');
  const entries = new Map(),
    claims = new Map(),
    owner = {},
    totals = { hits: 0, misses: 0, rejected: 0, expired: 0, evicted: 0 },
    logicalTotals196 = { hits: 0, misses: 0, peeks: 0, patches: 0, bootstraps: 0, fallback: 0 };
  let rows = 0;
  function unlink(entry, release, evicted = false) {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    rows -= entry.rows;
    const bucket = claims.get(entry.claim);
    bucket?.delete(entry);
    if (bucket?.size === 0) claims.delete(entry.claim);
    if (release) budget.remove(entry.token);
    if (evicted) totals.evicted++;
  }
  function current(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expires <= now()) {
      totals.expired++;
      unlink(entry, true);
      return null;
    }
    return entry;
  }
  const valid = (value, maximum) =>
    typeof value === 'string' && value.length > 0 && value.length <= maximum;
  function same196(entry, state, keyGeneration) {
    return (
      entry &&
      entry.logical196 &&
      entry.token === state?.token &&
      entry.logical196.head.epoch === state.epoch &&
      entry.logical196.head.seq === state.seq &&
      generation196(keyGeneration) &&
      entry.logical196.keyGeneration === keyGeneration
    );
  }
  function usable196(entry, state, head, keyGeneration) {
    return (
      same196(entry, state, keyGeneration) &&
      head &&
      head.epoch === state.epoch &&
      BigInt(head.seq) >= BigInt(state.seq) &&
      BigInt(state.seq) >= BigInt(head.floorSeq) &&
      BigInt(state.seq) >= BigInt(head.resetSeq)
    );
  }
  return {
    hasClaim180(claim) {
      if (!valid(claim, 2048)) return false;
      const bucket = claims.get(claim);
      if (!bucket) return false;
      for (const entry of bucket) if (current(entry.key) === entry) return true;
      return false;
    },
    hasStamp180(key, stamp) {
      return valid(stamp, 8192) && entries.get(key)?.stamp === stamp;
    },
    has(key) {
      return current(key) !== null;
    },
    proofs185(key, timeZone) {
      const entry = current(key);
      const proofs = entry && directorySnapshotProofs185(entry.index, timeZone);
      // Detached IDs/hash bytes only. The plain token has no reverse reference
      // to an entry/index and cannot pin an evicted clinical representation.
      return proofs ? { token: entry.token, ...proofs } : null;
    },
    build185(key, token, rows, options) {
      const entry = current(key);
      // This synchronous factory is the only old-index borrower. No caller
      // receives old clinical data and no await occurs while it is borrowed.
      return createDirectorySnapshotIndex185(
        entry && entry.token === token ? entry.index : null,
        rows,
        options,
      );
    },
    initialize196(index, options) {
      const result = createDirectorySnapshotIndex196(index, [], options);
      if (!result) logicalTotals196.fallback++;
      return result;
    },
    state196(key, { keyGeneration, timeZone } = {}) {
      const entry = current(key),
        logical = entry?.logical196;
      if (
        !logical ||
        !generation196(keyGeneration) ||
        logical.keyGeneration !== keyGeneration ||
        logical.timeZone !== timeZone
      )
        return null;
      return Object.freeze({
        token: entry.token,
        epoch: logical.head.epoch,
        seq: logical.head.seq,
      });
    },
    resolve196(key, state, identities, { keyGeneration } = {}) {
      const entry = current(key);
      return same196(entry, state, keyGeneration)
        ? resolveDirectorySnapshot196(entry.index, identities)
        : null;
    },
    build196(key, state, changes, { head, keyGeneration, timeZone, revision } = {}) {
      const entry = current(key),
        parsed = head196(head);
      if (
        !usable196(entry, state, parsed, keyGeneration) ||
        entry.logical196.timeZone !== timeZone
      ) {
        logicalTotals196.fallback++;
        return null;
      }
      // Trusted completed same-RR delta only. No SQL await or clinical graph
      // borrow escapes this synchronous factory; null means legacy bootstrap.
      const result = createDirectorySnapshotIndex196(entry.index, changes, { timeZone, revision });
      if (!result) logicalTotals196.fallback++;
      return result;
    },
    previewChanges196(key, state, changes, options, input) {
      const entry = current(key),
        parsed = head196(options?.head);
      if (
        !usable196(entry, state, parsed, options?.keyGeneration) ||
        entry.logical196.timeZone !== options.timeZone
      )
        return null;
      // The temporary candidate never escapes. Only detached selected proofs
      // survive the next SQL await; final build must acquire the entry again.
      const candidate = createDirectorySnapshotIndex196(entry.index, changes, options);
      return candidate ? peekDirectorySnapshot196(candidate, input) : null;
    },
    peekForClaim196(claim, { url, cursorCrypto, keyGeneration } = {}) {
      const unkeyedHint =
        keyGeneration === undefined && url instanceof URL && !url.searchParams.has('cursor');
      if (!valid(claim, 2048) || (!unkeyedHint && !generation196(keyGeneration))) return null;
      const bucket = claims.get(claim);
      if (!bucket) return null;
      for (const entry of bucket) {
        if (
          current(entry.key) !== entry ||
          !entry.logical196 ||
          (!unkeyedHint && entry.logical196.keyGeneration !== keyGeneration)
        )
          continue;
        const logical = entry.logical196;
        let proofs;
        try {
          proofs = peekDirectorySnapshot196(entry.index, {
            current: logical.current,
            url,
            cursorCrypto,
          });
        } catch {
          return null;
        }
        if (!proofs) return null;
        logicalTotals196.peeks++;
        return Object.freeze({
          key: entry.key,
          token: entry.token,
          stamp: entry.stamp,
          head: logical.head,
          epoch: logical.head.epoch,
          seq: logical.head.seq,
          audience: entry.audience,
          timeZone: logical.timeZone,
          current: logical.current,
          proofs,
        });
      }
      return null;
    },
    publish({ key, stamp, claim, audience, index, logical196 = null }) {
      const info = directorySnapshotIndexInfo180(index);
      let logical = null;
      if (logical196) {
        const head = head196(logical196.head),
          source = logical196.current,
          timeZone = logical196.timeZone;
        if (
          !head ||
          !info?.logical196 ||
          !generation196(logical196.keyGeneration) ||
          !valid(timeZone, 80) ||
          !source ||
          !['accountId', 'organizationId', 'sessionId', 'role'].every((name) =>
            valid(source[name], 120),
          )
        ) {
          totals.rejected++;
          return false;
        }
        logical = Object.freeze({
          head,
          keyGeneration: logical196.keyGeneration,
          timeZone,
          current: Object.freeze({
            accountId: source.accountId,
            organizationId: source.organizationId,
            sessionId: source.sessionId,
            role: source.role,
          }),
        });
      }
      if (
        !valid(key, 2048) ||
        !valid(stamp, 8192) ||
        !valid(claim, 2048) ||
        !(audience === '*' || /^[a-f0-9]{64}$/.test(audience)) ||
        !info ||
        info.rows > maxRows ||
        info.charge > 32 * 1024 * 1024
      ) {
        totals.rejected++;
        return false;
      }
      const old = entries.get(key);
      if (old) unlink(old, true);
      while (entries.size && (entries.size >= maxEntries || rows + info.rows > maxRows))
        unlink(entries.values().next().value, true, true);
      const entry = {
        key,
        stamp,
        claim,
        audience,
        index,
        rows: info.rows,
        expires: now() + ttlMs,
        token: {},
        logical196: logical,
      };
      const charge =
        info.charge +
        2 * (key.length + stamp.length + claim.length + audience.length) +
        1024 +
        (logical
          ? 2048 +
            2 *
              (logical.head.epoch.length +
                logical.head.seq.length +
                logical.head.floorSeq.length +
                logical.head.resetSeq.length +
                logical.timeZone.length +
                Object.values(logical.current).reduce((n, value) => n + value.length, 0))
          : 0);
      if (!budget.retain(entry.token, charge, () => unlink(entry, false, true), owner)) {
        totals.rejected++;
        return false;
      }
      entries.set(key, entry);
      rows += info.rows;
      if (!claims.has(claim)) claims.set(claim, new Set());
      claims.get(claim).add(entry);
      if (logical) {
        if (info.kind196 === 'bootstrap') logicalTotals196.bootstraps++;
        else logicalTotals196.patches++;
      }
      return true;
    },
    render196(key, { token, head, keyGeneration } = {}, input) {
      const entry = current(key),
        parsed = head196(head),
        state = entry?.logical196 && {
          token,
          epoch: entry.logical196.head.epoch,
          seq: entry.logical196.head.seq,
        };
      if (
        !usable196(entry, state, parsed, keyGeneration) ||
        parsed.seq !== state.seq ||
        entry.audience !== input?.audience ||
        !Array.isArray(input?.expectedSelected196) ||
        !['accountId', 'organizationId', 'sessionId', 'role'].every(
          (name) => input?.current?.[name] === entry.logical196.current[name],
        ) ||
        !Number.isSafeInteger(input?.revision) ||
        input.revision < 0
      ) {
        totals.misses++;
        logicalTotals196.misses++;
        return null;
      }
      const serialized = renderDirectorySnapshotProven196(
        entry.index,
        input,
        input.expectedSelected196,
      );
      if (serialized === null) {
        totals.misses++;
        logicalTotals196.misses++;
        return null;
      }
      totals.hits++;
      logicalTotals196.hits++;
      budget.touch(entry.token);
      entries.delete(key);
      entries.set(key, entry);
      entry.expires = now() + ttlMs;
      return serialized;
    },
    render(key, stamp, input) {
      const entry = current(key);
      if (!entry || entry.stamp !== stamp || entry.audience !== input.audience) {
        totals.misses++;
        return null;
      }
      // Final lookup happens only after fresh authority/assets. No caller ever
      // receives the private index, summaries, typed arrays, or cached crypto.
      const serialized = directorySnapshotIndexInfo180(entry.index).render(input);
      if (serialized === null) {
        totals.misses++;
        return null;
      }
      totals.hits++;
      budget.touch(entry.token);
      entries.delete(key);
      entries.set(key, entry);
      entry.expires = now() + ttlMs;
      return serialized;
    },
    clear() {
      entries.clear();
      claims.clear();
      rows = 0;
      budget.releaseOwner(owner);
    },
    stats: () => ({ ...totals, entries: entries.size, rows, maxEntries, maxRows }),
    stats196: () => ({
      ...logicalTotals196,
      entries: [...entries.values()].filter((entry) => entry.logical196).length,
    }),
  };
}
module.exports = { createDirectorySnapshotCache180 };
