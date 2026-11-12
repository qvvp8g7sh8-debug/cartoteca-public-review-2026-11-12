const { randomUUID } = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { timeZoneRule, DEFAULT_TIME_ZONE } = require('../organizations/time-zone.cjs');
// Personal comments never affect the exported occupancy version.
function updatePersonalVersions(profile, before, after) {
  const old = new Map(before.map((event) => [event.id, event]));
  const affected = new Set();
  const fingerprint = (event) =>
    JSON.stringify([event.staffId, event.date, event.time, event.duration]);
  for (const event of after) {
    const prior = old.get(event.id);
    if (!prior || fingerprint(prior) !== fingerprint(event)) {
      if (prior?.staffId) affected.add(prior.staffId);
      if (event.staffId) affected.add(event.staffId);
    }
    old.delete(event.id);
  }
  for (const event of old.values()) if (event.staffId) affected.add(event.staffId);
  if (!affected.size) return profile;
  const versions = { ...profile.calendarPersonalVersions };
  for (const staffId of affected) versions[staffId] = randomUUID();
  return { ...profile, calendarPersonalVersions: versions };
}
function createPersonalFeedState({ db, open }, { maxBytes = 1024 * 1024, maxEntries = 128 } = {}) {
  const entries = new Map();
  let bytes = 0,
    stampQuery,
    valueQuery;
  function remove(key) {
    const prior = entries.get(key);
    if (prior) {
      bytes -= prior.bytes;
      entries.delete(key);
    }
  }
  function metadata(current) {
    const org = current.organizationId;
    // AES-GCM nonce + tag change on every encrypted profile write, across workers.
    // Compare only these 28 bytes; unchanged requests do not decrypt personal events.
    stampQuery ||= db.prepare('SELECT substr(value,1,28) AS stamp FROM organizations WHERE id=?');
    const row = stampQuery.get(org);
    if (!row) throw fail(404, 'Организация не найдена.');
    const stamp = Buffer.from(row.stamp);
    let entry = entries.get(org);
    if (!entry || !entry.stamp.equals(stamp)) {
      valueQuery ||= db.prepare('SELECT value FROM organizations WHERE id=?');
      const stored = valueQuery.get(org);
      if (!stored) throw fail(404, 'Организация не найдена.');
      const profile = open(stored.value);
      const value = {
        zone: timeZoneRule(profile.timeZone || DEFAULT_TIME_ZONE, fail),
        versions: { ...profile.calendarPersonalVersions },
      };
      const size = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(org) + 28;
      remove(org);
      entry = {
        ...value,
        stamp: Buffer.from(Buffer.from(stored.value).subarray(0, 28)),
        bytes: size,
      };
      while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes))
        remove(entries.keys().next().value);
      if (size <= maxBytes && maxEntries > 0) {
        entries.set(org, entry);
        bytes += size;
      }
    } else {
      entries.delete(org);
      entries.set(org, entry);
    }
    if (current.role === 'salon_admin')
      return {
        zone: entry.zone,
        personalVersions: current.specialists.map((staff) => [
          staff.id,
          entry.versions[staff.id] || '',
        ]),
      };
    return { zone: entry.zone, personalVersion: entry.versions[current.accountId] || '' };
  }
  return { metadata };
}
module.exports = { createPersonalFeedState, updatePersonalVersions };
