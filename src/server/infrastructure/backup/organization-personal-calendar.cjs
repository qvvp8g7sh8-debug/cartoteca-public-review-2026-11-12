const { openValue } = require('./snapshot.cjs');
const { personalCollection, personalOccupancy } = require('../../../shared/personal-calendar.cjs');
const identityError = () => Error('Current identity, access or subscription changed.');
const versionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionMap = (value) => value && typeof value === 'object' && !Array.isArray(value);

function affectedStaff(before, after) {
  const previous = new Map(before.map((event) => [event.id, event]));
  const affected = new Set();
  for (const event of after) {
    const prior = previous.get(event.id);
    if (
      !prior ||
      JSON.stringify(personalOccupancy(prior)) !== JSON.stringify(personalOccupancy(event))
    ) {
      if (prior) affected.add(prior.staffId);
      affected.add(event.staffId);
    }
    previous.delete(event.id);
  }
  for (const event of previous.values()) affected.add(event.staffId);
  return affected;
}

function preserveDerivedVersions(profile, baseline, affected) {
  if (!affected.size) return;
  const before = baseline.calendarPersonalVersions;
  const after = profile.calendarPersonalVersions;
  if ((before !== undefined && !versionMap(before)) || !versionMap(after)) throw identityError();
  const expected = new Set([...Object.keys(before || {}), ...affected]);
  if (
    Object.keys(after).length !== expected.size ||
    Object.keys(after).some((staffId) => !expected.has(staffId))
  )
    throw identityError();
  for (const staffId of expected) {
    const value = after[staffId];
    if (
      affected.has(staffId)
        ? typeof value !== 'string' || !versionPattern.test(value) || value === before?.[staffId]
        : JSON.stringify(value) !== JSON.stringify(before[staffId])
    )
      throw identityError();
  }
  // Only independently verified invalidations are normalized for the identity
  // comparison. Every unaffected version and all other profile fields stay exact.
  if (Object.hasOwn(baseline, 'calendarPersonalVersions'))
    profile.calendarPersonalVersions = before;
  else delete profile.calendarPersonalVersions;
}

function comparableOrganizations(rows, organizationId, key, baselineRows = rows) {
  const baselineRow = baselineRows.find((row) => row.id === organizationId);
  if (!baselineRow) throw identityError();
  const baseline = JSON.parse(openValue(key, baselineRow.value).toString('utf8'));
  const previous = personalCollection(baseline.personalEvents);
  return rows.map((row) => {
    if (row.id !== organizationId) return row;
    const profile = JSON.parse(openValue(key, row.value).toString('utf8'));
    const recovered = personalCollection(profile.personalEvents);
    preserveDerivedVersions(profile, baseline, affectedStaff(previous.events, recovered.events));
    // Personal calendar data follows the recovered cabinet. Every other protected
    // organization property and every relational identity column must stay current.
    delete profile.personalEvents;
    return { ...row, value: JSON.stringify(profile) };
  });
}

function assertOrganizationsPreserved(original, actual, organizationId, key) {
  if (
    JSON.stringify(comparableOrganizations(original, organizationId, key)) !==
    JSON.stringify(comparableOrganizations(actual, organizationId, key, original))
  )
    throw identityError();
}
module.exports = { assertOrganizationsPreserved };
