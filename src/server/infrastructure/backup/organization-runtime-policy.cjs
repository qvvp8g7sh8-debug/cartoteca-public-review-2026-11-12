const { STAFF_EVENTS } = require('../../modules/notifications/staff-event-preferences.cjs');
const { EVENTS } = require('../../modules/notifications/push-validation.cjs');
// Resolve self-test ownership against the unchanged source, before job rows are reset.
function organizationInterestPolicy(db, org) {
  const selfTests = new Set();
  for (const [channel, table] of [
    ['telegram', 'staff_notification_jobs'],
    ['max', 'staff_max_jobs'],
  ]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      for (const row of db.prepare('SELECT id FROM ' + table + ' WHERE organization_id=?').all(org))
        selfTests.add('staff-selftest-v1:' + channel + ':' + row.id);
  }
  return (key) => {
    if (selfTests.has(key)) return true;
    if (
      ['all', 'reminder', 'lifecycle'].some(
        (type) => key === 'client-interest-v1:' + type + ':' + org,
      )
    )
      return true;
    const tuple = JSON.stringify([org]).slice(0, -1) + ',';
    if (
      ['telegram', 'max'].some((channel) =>
        ['delivery', 'appointment', ...STAFF_EVENTS].some((type) =>
          key.startsWith('staff-interest-v1:' + channel + ':' + type + ':' + tuple),
        ),
      )
    )
      return true;
    return [...EVENTS, 'all', 'change'].some((type) =>
      key.startsWith('push-interest-v1:' + type + ':' + encodeURIComponent(org) + ':'),
    );
  };
}
module.exports = { organizationInterestPolicy };
