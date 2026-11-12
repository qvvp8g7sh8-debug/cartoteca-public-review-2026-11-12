const LIMIT = 50;
const statuses = {
  pending: 'queued',
  reserved: 'queued',
  sending: 'sending',
  sent: 'accepted',
  failed: 'failed',
  uncertain: 'unknown',
  cancelled: 'cancelled',
};
const kinds = ['reminder', 'booking-confirmed', 'created', 'moved', 'cancelled'];
const time = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
function createNotificationHistory({ db, open, clock = Date.now }) {
  const jobs = db.prepare(
    'SELECT id,channel,value,status,lease_until FROM notification_channel_jobs WHERE organization_id=? AND patient_id=? AND appointment_id=? ORDER BY expires_at DESC,id DESC LIMIT ?',
  );
  const receipts = db.prepare(
    'SELECT value FROM notification_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=? ORDER BY stamp DESC LIMIT ?',
  );
  const manual = db.prepare(
    'SELECT value FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
  );
  // Legacy appointment IDs live inside encrypted values. Bound the indexed patient
  // selection as well as the response; never scan/decrypt an entire organization.
  const legacy = db.prepare(
    'SELECT j.id,j.value,j.status,j.lease_until,c.confirmed_at FROM telegram_jobs j LEFT JOIN telegram_confirmations c ON c.organization_id=j.organization_id AND c.patient_id=j.patient_id AND c.fingerprint=j.fingerprint WHERE j.organization_id=? AND j.patient_id=? ORDER BY j.expires_at DESC,j.id DESC LIMIT ?',
  );
  function read(org, patient, appointment) {
    const rows = jobs.all(org, patient, appointment, LIMIT + 1),
      confirmations = receipts.all(org, patient, appointment, LIMIT + 1),
      old = legacy.all(org, patient, LIMIT + 1),
      items = [],
      confirmed = new Set();
    function delivery(row, value, channel, prefix) {
      if (!['telegram', 'max'].includes(channel)) return;
      items.push({
        id: prefix + row.id,
        channel,
        kind: kinds.includes(value.kind) ? value.kind : value.kind ? 'unknown' : 'reminder',
        status:
          row.status === 'sending' && row.lease_until <= clock()
            ? 'unknown'
            : statuses[row.status] || 'unknown',
        createdAt: time(value.createdAt),
        updatedAt: time(value.updatedAt),
        acceptedAt: time(value.acceptedAt),
        eventAt: time(value.eventAt),
        confirmedAt: null,
      });
    }
    function confirmation(channel, value) {
      const confirmedAt = time(value);
      if (!confirmedAt || !['telegram', 'max'].includes(channel)) return;
      const key = channel + ':' + confirmedAt;
      if (confirmed.has(key)) return;
      confirmed.add(key);
      items.push({
        id: 'client-confirmed:' + key,
        channel,
        kind: 'confirmation',
        status: 'client-confirmed',
        createdAt: null,
        updatedAt: confirmedAt,
        acceptedAt: null,
        eventAt: null,
        confirmedAt,
      });
    }
    for (const row of rows.slice(0, LIMIT)) delivery(row, open(row.value), row.channel, 'channel:');
    for (const row of confirmations.slice(0, LIMIT)) {
      const value = open(row.value);
      confirmation(value.notificationConfirmedChannel, value.notificationConfirmedAt);
    }
    for (const row of old.slice(0, LIMIT)) {
      const value = open(row.value);
      if (value.appointmentId !== appointment) continue;
      delivery(row, value, 'telegram', 'legacy:');
      confirmation('telegram', row.confirmed_at);
    }
    const staffReceipt = manual.get(org, patient, appointment);
    const staffConfirmedAt = staffReceipt ? time(open(staffReceipt.value).confirmedAt) : null;
    if (staffConfirmedAt)
      items.push({
        id: 'staff-confirmed:' + staffConfirmedAt,
        channel: 'manual',
        kind: 'confirmation',
        status: 'staff-confirmed',
        createdAt: null,
        updatedAt: staffConfirmedAt,
        acceptedAt: null,
        eventAt: null,
        confirmedAt: staffConfirmedAt,
      });
    const recent = (item) =>
      Math.max(
        item.createdAt || 0,
        item.updatedAt || 0,
        item.acceptedAt || 0,
        item.eventAt || 0,
        item.confirmedAt || 0,
      );
    items.sort((left, right) => recent(right) - recent(left) || left.id.localeCompare(right.id));
    return {
      items: items.slice(0, LIMIT),
      limited:
        rows.length > LIMIT ||
        confirmations.length > LIMIT ||
        old.length > LIMIT ||
        items.length > LIMIT,
    };
  }
  return { read };
}
module.exports = { createNotificationHistory };
