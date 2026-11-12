const { fail } = require('../../../shared/errors.cjs');
// Keep historical defaults explicit: adding another supported event must not opt old links in.
const LEGACY_EVENTS = Object.freeze(['new-request', 'client-agreed', 'client-declined']);
const APPOINTMENT_EVENTS = Object.freeze([
  'created',
  'moved',
  'cancelled',
  'completed',
  'no_show',
  'restored',
  'removed',
  'updated',
  'confirmation',
]);
const STAFF_EVENTS = Object.freeze([...LEGACY_EVENTS, ...APPOINTMENT_EVENTS]);
function channelEnabled(platform, channel) {
  return platform.notificationChannels?.enabled(channel) !== false;
}
function channelVersion(platform, channel) {
  return platform.notificationChannels?.version(channel) || '';
}
function storedEvents(value) {
  if (value?.events === undefined) return [...LEGACY_EVENTS];
  if (!Array.isArray(value.events)) return [];
  return STAFF_EVENTS.filter((event) => value.events.includes(event));
}
function validateUpdate(value, disconnect = false) {
  const enabled = Object.hasOwn(value || {}, 'enabled');
  const events = Object.hasOwn(value || {}, 'events');
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['bindingId', 'enabled', 'events'].includes(key)) ||
    typeof value.bindingId !== 'string' ||
    (!disconnect && !enabled && !events) ||
    (enabled && typeof value.enabled !== 'boolean') ||
    (events &&
      (!Array.isArray(value.events) ||
        new Set(value.events).size !== value.events.length ||
        Array.from(value.events).some((event) => !STAFF_EVENTS.includes(event))))
  )
    throw fail(400, 'Проверьте настройку уведомлений.');
}
function cancelEvents(c, table, org, account, removed) {
  if (!removed.length) return;
  if (!['staff_notification_jobs', 'staff_max_jobs'].includes(table))
    throw Error('Unknown staff notification queue.');
  const rows = c.db
    .prepare(
      `SELECT id,value FROM ${table} WHERE organization_id=? AND account_id=? AND status IN ('pending','sending')`,
    )
    .all(org, account);
  const cancel = c.db.prepare(
    `UPDATE ${table} SET status='cancelled',lease_id=NULL,lease_until=0 WHERE id=? AND organization_id=? AND account_id=? AND status IN ('pending','sending')`,
  );
  for (const row of rows)
    if (removed.includes(c.open(row.value).event)) cancel.run(row.id, org, account);
}
function eventVersions(current, next, randomId) {
  const versions = { ...current.eventVersions },
    previous = storedEvents(current);
  for (const event of STAFF_EVENTS)
    if (
      current.enabled !== next.enabled ||
      previous.includes(event) !== next.events.includes(event)
    )
      versions[event] = randomId();
  return versions;
}
module.exports = {
  STAFF_EVENTS,
  APPOINTMENT_EVENTS,
  storedEvents,
  validateUpdate,
  cancelEvents,
  eventVersions,
  channelEnabled,
  channelVersion,
};
