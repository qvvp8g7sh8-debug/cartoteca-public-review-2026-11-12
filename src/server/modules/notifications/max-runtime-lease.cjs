const { performance } = require('node:perf_hooks');
const LEASE_MS = 30000;
const RENEW_MS = 10000;

// Only explicit admission renews durable ownership. Cancellation guards never
// touch SQL; a provider/claim callback separately verifies fresh durable state.
function createMaxRuntimeLease({
  inbox,
  botId,
  owner,
  clock = Date.now,
  monotonicClock = () => performance.now(),
}) {
  let epoch = 0,
    held = false,
    blocked = false,
    until = 0,
    monoUntil = 0,
    nextAt = 0,
    lastWall = -Infinity,
    lastMono = -Infinity;
  function invalidate() {
    epoch++;
    held = false;
  }
  function sample() {
    const wall = clock(),
      mono = monotonicClock();
    if (
      blocked ||
      !Number.isFinite(wall) ||
      !Number.isFinite(mono) ||
      wall < lastWall ||
      mono < lastMono ||
      inbox.isOpen?.() === false
    ) {
      blocked = true;
      invalidate();
      return null;
    }
    lastWall = wall;
    lastMono = mono;
    return { wall, mono };
  }
  function valid(at) {
    if (!at || !held) return false;
    if (at.wall >= until || at.mono >= monoUntil) {
      invalidate();
      return false;
    }
    return true;
  }
  function guardFor(version) {
    const guard = () => version === epoch && valid(sample());
    guard.authority = () => (guard() ? { owner, until } : null);
    guard.verify = () => {
      if (!guard()) return false;
      try {
        const matches = inbox.isCurrent(botId, owner, until, lastWall);
        if (!matches) {
          invalidate();
          return false;
        }
        return guard(); // A slow ownership read cannot mint extra lifetime.
      } catch (error) {
        blocked = true;
        invalidate();
        throw error;
      }
    };
    return guard;
  }
  function cleanBusy(error) {
    return (
      error?.postgres === true &&
      error.postgresCode === 'POSTGRES_BUSY' &&
      error.code === 'ERR_SQLITE_ERROR' &&
      error.errcode === 5 &&
      error.retryableBeforeBegin === true &&
      error.transactionOpen === false &&
      error.channelPoisoned === false &&
      error.outcomeUnknown !== true
    );
  }
  function ensure() {
    const at = sample();
    if (!at) return null;
    const wasHeld = valid(at);
    if (at.mono < nextAt) return wasHeld ? guardFor(epoch) : null;
    try {
      const confirmed = wasHeld
        ? inbox.renew(botId, owner, until, at.wall)
        : inbox.acquire(botId, owner, at.wall);
      nextAt = at.mono + (confirmed ? RENEW_MS : 1000);
      if (!confirmed) {
        invalidate();
        return null;
      }
      until = at.wall + LEASE_MS;
      monoUntil = at.mono + LEASE_MS;
      held = true;
      const guard = guardFor(epoch);
      return guard() ? guard : null;
    } catch (error) {
      if (cleanBusy(error)) {
        nextAt = at.mono + 1000;
        return wasHeld && valid(sample()) ? guardFor(epoch) : null;
      }
      blocked = true;
      invalidate();
      throw error;
    }
  }
  function release() {
    const owned = held;
    invalidate();
    nextAt = 0;
    if (owned) inbox.release(botId, owner);
  }
  return { ensure, release };
}
module.exports = { createMaxRuntimeLease, LEASE_MS };
