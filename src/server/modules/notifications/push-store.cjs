const { createPushDevices } = require('./push-devices.cjs');
const { createPushQueue } = require('./push-queue.cjs');
function createStaffPush(c) {
  const devices = createPushDevices(c);
  const organizationPage = c.db.prepare(
    'SELECT DISTINCT organization_id id FROM staff_push_devices WHERE organization_id>? ORDER BY organization_id LIMIT ?',
  );
  return {
    ...devices,
    ...createPushQueue(c, devices),
    keys: () =>
      c.open(c.db.prepare("SELECT value FROM staff_push_config WHERE id='vapid'").get().value),
    organizations: () =>
      c.db
        .prepare('SELECT DISTINCT organization_id id FROM staff_push_devices')
        .all()
        .map((row) => row.id),
    organizationPage(cursor = '', limit = 10) {
      if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw Error('Invalid push organization page.');
      const rows = organizationPage.all(cursor, limit).map((row) => row.id);
      return { organizations: rows, cursor: rows.length === limit ? rows.at(-1) : '' };
    },
    booking(org, record, event, now = Date.now()) {
      const kind = ['new-request', 'new-classic-booking'].includes(event)
        ? 'new-request'
        : 'confirmation';
      if (!devices.hasEnabledEvents(org, kind)) return;
      this.enqueue(
        org,
        record.staffId,
        kind,
        {
          kind: 'request',
          id: record.id,
          revision: record.revision,
          notice: event === 'new-request' && record.kind === 'other-time' ? 'other-time' : event,
        },
        JSON.stringify(['request', record.id, event, record.revision]),
        now + 86400000,
      );
    },
    confirmation(org, patientId, a) {
      if (!devices.hasEnabledEvents(org, 'confirmation')) return;
      const stamp = require('./appointments.cjs').fingerprint(a, c.organizationTimeZone(org));
      this.enqueue(
        org,
        a.staffId,
        'confirmation',
        { kind: 'appointment', patientId, id: a.id, stamp },
        JSON.stringify(['confirmed', a.id, stamp]),
      );
    },
  };
}
module.exports = { createStaffPush };
