const { createHash } = require('node:crypto');
const { calendarFeed, feedWindow } = require('./feed.cjs');
const { fail } = require('../../../shared/errors.cjs');
function matchesEtag(header, etag) {
  if (typeof header !== 'string') return false;
  const normalize = (value) => value.trim().replace(/^W\//, '');
  return header
    .split(',')
    .some((value) => value.trim() === '*' || normalize(value) === normalize(etag));
}
function createCalendarFeedCache({ budget, maxBytes = 8 * 1024 * 1024, maxEntries = 512 } = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(identity, releaseBudget = true) {
    const entry = entries.get(identity);
    if (!entry) return;
    entries.delete(identity);
    bytes -= entry.bytes;
    if (releaseBudget) budget?.remove(entry.token);
  }
  function descriptor(current, storage, platform, now) {
    const { zone, personalVersion, personalVersions } =
      platform.calendarSubscription.metadata(current);
    const period = feedWindow(now, zone);
    const admin = current.role === 'salon_admin';
    const version = JSON.stringify([
      admin ? 'organization-ics-v1-staff-name-10m' : 'staff-ics-v3-name-10m',
      current.organizationId,
      current.accountId,
      ...(admin ? [current.selection, current.selectionRevision, current.specialists] : []),
      admin
        ? current.specialists.map((staff) => [staff.id, storage.calendarOccupancyVersion(staff.id)])
        : storage.calendarOccupancyVersion(current.accountId),
      admin ? personalVersions : personalVersion,
      zone,
      period.from,
      period.to,
    ]);
    return {
      version,
      zone,
      period,
      etag: 'W/"' + createHash('sha256').update(version).digest('hex') + '"',
    };
  }
  function read({ current, storage, platform, ifNoneMatch, now = Date.now() }) {
    const identity = JSON.stringify([
      current.organizationId,
      current.accountId,
      ...(current.role === 'salon_admin' ? ['organization', current.selectionRevision] : []),
    ]);
    // All work is synchronous in this worker: concurrent requests cannot start a second build.
    // Other workers share persisted staff versions, rather than connection-local epochs.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = descriptor(current, storage, platform, now);
      if (matchesEtag(ifNoneMatch, before.etag)) return { etag: before.etag, unchanged: true };
      const cached = entries.get(identity);
      if (cached?.version === before.version) {
        entries.delete(identity);
        entries.set(identity, cached);
        budget?.touch(cached.token);
        return { etag: before.etag, body: cached.body, unchanged: false };
      }
      remove(identity);
      const body = calendarFeed({
        current,
        storage,
        platform,
        now,
        zone: before.zone,
        period: before.period,
      });
      // Never label a mixed read as the latest version if another worker wrote during generation.
      if (descriptor(current, storage, platform, now).version !== before.version) continue;
      const entry = {
        version: before.version,
        body,
        token: {},
        bytes: Buffer.byteLength(body) + Buffer.byteLength(before.version),
      };
      while (entries.size && (entries.size >= maxEntries || bytes + entry.bytes > maxBytes))
        remove(entries.keys().next().value);
      if (
        maxEntries > 0 &&
        entry.bytes <= maxBytes &&
        (!budget || budget.retain(entry.token, entry.bytes, () => remove(identity, false), entries))
      ) {
        entries.set(identity, entry);
        bytes += entry.bytes;
      }
      return { etag: before.etag, body, unchanged: false };
    }
    const error = fail(503, 'Расписание изменяется. Повторите обновление календаря.');
    error.retryAfter = 1;
    throw error;
  }
  function clear() {
    for (const key of entries.keys()) remove(key);
  }
  return { read, clear };
}
module.exports = { createCalendarFeedCache, matchesEtag };
