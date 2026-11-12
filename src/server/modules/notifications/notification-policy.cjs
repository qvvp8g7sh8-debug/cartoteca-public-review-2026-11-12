const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { fingerprint, serviceFingerprint, startsAt } = require('./appointments.cjs');
const { deliveryChannels } = require('./delivery-channels.cjs');
const { classicConfirmation } = require('../booking/classic-confirmation.cjs');
const { appointmentRows, pairKey } = require('./appointment-state-batch.cjs');
const { clientNotificationEvents } = require('./appointments.cjs');
const { lifecycleKinds, eventStamp } = require('./client-appointment-events.cjs');

// Equality is checked against the current physical tenant snapshot, never just
// a matching patient/appointment ID. No response values survive this call.
function sameResponseEntries(entries, response) {
  if (
    ![response.entries, response.receiptEntries].every(
      (rows) => Array.isArray(rows) && rows.length === entries.length,
    ) ||
    ![response.manual, response.legacy, response.receipts].every((value) => value instanceof Map)
  )
    return false;
  return [response.entries, response.receiptEntries].every((rows) => {
    const visible = new Map(
      rows.map((entry) => [pairKey(entry.patient, entry.appointment), entry]),
    );
    return (
      visible.size === entries.length &&
      entries.every((entry) => {
        const prior = visible.get(pairKey(entry.patient, entry.appointment));
        return (
          prior &&
          ['stamp', 'fingerprint', 'services', 'active'].every((key) => prior[key] === entry[key])
        );
      })
    );
  });
}

function createNotificationPolicy({ platform, tenantStore, store, links, providers, clock }) {
  const configuredChannels = () =>
    ['telegram', 'max'].filter(
      (channel) =>
        platform.notificationChannels?.enabled?.(channel) !== false &&
        providers[channel]?.status?.().configured === true,
    );
  const readyChannels = () =>
    configuredChannels().filter((channel) => providers[channel].status().connected === true);
  // Read contexts live for one synchronous response only. Dispatch/confirmation
  // never use them: those paths continue checking current permissions and bindings.
  function readContext(org, patients, responseRead = null) {
    const response = responseRead?.organizationId === org ? responseRead : null;
    const organization = platform.organization(org),
      plan = platform.subscription(org),
      settings = response?.settings || platform.telegram.settings(org),
      zone = settings.timeZone;
    const requested = new Set(
      patients.flatMap((p) => p.appointments.map((a) => pairKey(p.id, a.id))),
    );
    const storage = tenantStore(org);
    const requestedPatients = new Set(patients.map((p) => p.id));
    const snapshotPatients =
      response &&
      Array.isArray(response.sourcePatients) &&
      platform.isProjectionSnapshot?.(response.readSnapshot, org) === true
        ? response.sourcePatients.filter((p) => requestedPatients.has(p.id))
        : null;
    const selected =
      organization.status === 'active' &&
      plan.status === 'active' &&
      plan.limits.automaticNotifications &&
      settings.enabled
        ? (
            snapshotPatients ||
            (response?.boundedCanonical === true && storage.readAppointment
              ? patients.map((patient) => ({
                  id: patient.id,
                  appointments: patient.appointments
                    .map((appointment) => storage.readAppointment(patient.id, appointment.id))
                    .filter(Boolean),
                }))
              : storage.readSelectedAppointments
                ? storage.readSelectedAppointments(patients.map((p) => p.id))
                : storage.readSelected(patients.map((p) => p.id)).patients)
          ).map((p) => ({
            id: p.id,
            appointments: p.appointments.filter((a) => requested.has(pairKey(p.id, a.id))),
          }))
        : [];
    const entries = appointmentRows(selected, zone, platform.appointmentConfirmations);
    const reusable = response && response.zone === zone && sameResponseEntries(entries, response);
    return {
      organization,
      plan,
      settings,
      storage,
      stamps: new Map(
        entries.map((entry) => [pairKey(entry.patient, entry.appointment), entry.stamp]),
      ),
      appointments: new Map(
        selected.flatMap((p) => p.appointments.map((a) => [pairKey(p.id, a.id), a])),
      ),
      telegram: platform.telegram.linksMany(
        org,
        selected.map((p) => p.id),
      ),
      max: links.linksMany(
        org,
        selected.map((p) => p.id),
      ),
      members: links.membersMany(
        org,
        selected.flatMap((p) => p.appointments.map((a) => a.staffId).filter(Boolean)),
      ),
      manual: reusable ? response.manual : platform.appointmentConfirmations.readMany(org, entries),
      legacy: reusable ? response.legacy : platform.telegram.confirmedMany(org, entries),
      receipts: reusable
        ? response.receipts
        : store.readMany(org, entries, { includeJobs: false }).receipts,
      providers: Object.fromEntries(
        ['telegram', 'max'].map((channel) => [channel, providers[channel]?.status()]),
      ),
      // This context belongs to one synchronous response snapshot. Dispatch and
      // confirmation use current(..., null) and still read channel authority fresh.
      channelEnabled: Object.fromEntries(
        (entries.length ? ['telegram', 'max'] : []).map((channel) => [
          channel,
          platform.notificationChannels?.enabled?.(channel) !== false,
        ]),
      ),
    };
  }
  function current(
    org,
    patientId,
    appointmentId,
    read = null,
    { kind = '', event = null, confirmation = false } = {},
  ) {
    const organization = read ? read.organization : platform.organization(org),
      plan = read ? read.plan : platform.subscription(org);
    const settings = read ? read.settings : platform.telegram.settings(org),
      zone = settings.timeZone;
    if (
      organization.status !== 'active' ||
      plan.status !== 'active' ||
      !plan.limits.automaticNotifications ||
      !settings.enabled ||
      (kind &&
        !confirmation &&
        kind !== 'booking-confirmed' &&
        !clientNotificationEvents(settings.events).includes(kind)) ||
      (event && (settings.eventVersions?.[kind] || '') !== (event.preferenceVersion || ''))
    )
      return null;
    const pair = pairKey(patientId, appointmentId);
    const storage = read ? null : tenantStore(org);
    let a = read
      ? read.appointments.get(pair)
      : storage.readAppointment
        ? storage.readAppointment(patientId, appointmentId)
        : storage
            .readSelected([patientId])
            .patients[0]?.appointments.find((a) => a.id === appointmentId);
    const removed = !a && kind === 'cancelled' && event?.removed === true;
    if (removed) {
      const exists = storage.indexes?.summaryRows
        ? storage.indexes.summaryRows({ role: 'owner' }, [patientId]).length > 0
        : storage.readSelected([patientId]).patients.length > 0;
      if (!exists) return null;
      a = {
        ...event.snapshot,
        id: appointmentId,
        staffId: event.staffId || event.snapshot?.staffId || '',
        status: 'cancelled',
      };
    }
    if (
      !a ||
      (kind === 'cancelled' ? a.status !== 'cancelled' : !isActiveAppointment(a)) ||
      !(startsAt(a, zone) > clock()) ||
      (a.staffId && !(read ? read.members.get(a.staffId) : links.member(org, a.staffId)))
    )
      return null;
    const stamp = removed
      ? event.sourceStamp
      : read
        ? read.stamps.get(pair)
        : platform.appointmentConfirmations.stamp(a, zone);
    const telegram = read ? read.telegram.get(patientId) : platform.telegram.link(org, patientId),
      max = read ? read.max.get(patientId) : links.link(org, patientId);
    const status = (channel) => (read ? read.providers[channel] : providers[channel]?.status());
    const recipients = {
      telegram: telegram
        ? {
            chatId: String(telegram.chatId),
            bindingId: String(telegram.linkedAt),
            botId: status('telegram')?.botId || '',
          }
        : null,
      max:
        max && !max.restoredPaused && max.botId === status('max')?.botId
          ? { userId: max.userId, botId: max.botId, bindingId: max.bindingId }
          : null,
    };
    const flags = Object.fromEntries(
      ['telegram', 'max'].map((channel) => [
        channel,
        {
          ...status(channel),
          enabled: read
            ? read.channelEnabled[channel] === true
            : platform.notificationChannels?.enabled?.(channel) !== false,
          linked: Boolean(recipients[channel]),
        },
      ]),
    );
    const channels = deliveryChannels(flags);
    const lifecycle = lifecycleKinds.includes(kind);
    const automatic = lifecycle
      ? null
      : classicConfirmation(platform, read ? read.storage : tenantStore(org), patientId, a, zone);
    const confirmed = lifecycle
      ? null
      : automatic ||
        (read ? read.receipts.get(pair) : store.confirmed(org, patientId, a.id, stamp)) ||
        (read
          ? read.manual.get(pair)
          : platform.appointmentConfirmations.read(org, patientId, a, zone)) ||
        (read
          ? read.legacy.get(pair)
          : platform.telegram.confirmed(
              org,
              patientId,
              fingerprint(a, zone),
              serviceFingerprint(a),
            )) ||
        null;
    return {
      a,
      stamp,
      settings,
      channels,
      recipients,
      confirmed,
      automatic,
      expiresAt: startsAt(a, zone),
    };
  }
  const sameRecipient = (left, right) =>
    Boolean(
      left &&
      right &&
      ['userId', 'chatId', 'botId', 'bindingId'].every((key) => left[key] === right[key]),
    );
  function valid(job, { confirmation = false } = {}) {
    const kind = job.decoded.kind || 'reminder';
    if (
      !confirmation &&
      (platform.notificationChannels?.enabled?.(job.decoded.channel) === false ||
        (job.decoded.channelVersion || '') !==
          (platform.notificationChannels?.version?.(job.decoded.channel) || ''))
    )
      return null;
    const lifecycle = lifecycleKinds.includes(kind);
    if (lifecycle && (confirmation || job.expires_at <= clock())) return null;
    const event = lifecycle
      ? {
          id: job.decoded.eventId,
          kind,
          sourceStamp: job.decoded.sourceStamp,
          preferenceVersion: job.decoded.preferenceVersion,
          removed: job.decoded.removed,
          snapshot: job.decoded.snapshot,
        }
      : null;
    const result = current(job.organization_id, job.patient_id, job.appointment_id, null, {
      kind,
      event,
      confirmation,
    });
    if (
      !result ||
      result.stamp !== (lifecycle ? job.decoded.sourceStamp : job.stamp) ||
      (lifecycle && eventStamp(event) !== job.stamp) ||
      !sameRecipient(job.decoded.recipient, result.recipients[job.decoded.channel])
    )
      return null;
    if (lifecycle)
      return !confirmation && result.channels.includes(job.decoded.channel) ? result : null;
    // Both delivered buttons may confirm, but never after stop/unlink/edit.
    const booked = job.decoded.kind === 'booking-confirmed';
    if (booked && (confirmation || !result.automatic)) return null;
    if (
      !confirmation &&
      ((!booked && result.confirmed) || !result.channels.includes(job.decoded.channel))
    )
      return null;
    return result;
  }
  function receipt(org, patient, a, zone) {
    return isActiveAppointment(a)
      ? classicConfirmation(platform, tenantStore(org), patient, a, zone) ||
          store.confirmed(org, patient, a.id, platform.appointmentConfirmations.stamp(a, zone))
      : null;
  }
  return { current, valid, receipt, readContext, readyChannels, configuredChannels };
}
module.exports = { createNotificationPolicy };
