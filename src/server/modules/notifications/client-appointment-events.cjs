const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const crypto = require('node:crypto');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { clientNotificationEvents, fingerprint, startsAt } = require('./appointments.cjs');
const journal = require('./appointment-event-journal.cjs');

const lifecycleKinds = ['created', 'moved', 'cancelled'];
const eventStamp = (entry) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify(['client-appointment-event-v1', entry.id, entry.kind, entry.sourceStamp]),
    )
    .digest('hex');
const snapshot = (a) =>
  Object.fromEntries(
    ['id', 'date', 'time', 'duration', 'staffId', 'status']
      .filter((key) => a[key] !== undefined)
      .map((key) => [key, a[key]]),
  );
function recipients(platform, org, patientId) {
  const telegram =
    platform.notificationChannels?.enabled?.('telegram') !== false
      ? platform.telegram.link(org, patientId)
      : null;
  const max =
    platform.notificationChannels?.enabled?.('max') !== false
      ? platform.maxLinks?.link(org, patientId)
      : null;
  return {
    ...(telegram
      ? {
          telegram: {
            chatId: String(telegram.chatId),
            bindingId: String(telegram.linkedAt),
            channelVersion: platform.notificationChannels?.version?.('telegram') || '',
          },
        }
      : {}),
    ...(max && !max.restoredPaused
      ? {
          max: {
            userId: max.userId,
            botId: max.botId,
            bindingId: max.bindingId,
            channelVersion: platform.notificationChannels?.version?.('max') || '',
          },
        }
      : {}),
  };
}
const sameBinding = (left, right) =>
  Boolean(
    left &&
    right &&
    ['chatId', 'userId', 'botId', 'bindingId'].every((key) => left[key] === right[key]),
  );
function recordClientAppointmentChanges(platform, org, storage, before, next, now = Date.now()) {
  if (
    !['telegram', 'max'].some(
      (channel) => platform.notificationChannels?.enabled?.(channel) !== false,
    )
  )
    return [];
  const settings = platform.telegram.settings(org);
  const selected = clientNotificationEvents(settings.events);
  if (!settings.enabled || !lifecycleKinds.some((kind) => selected.includes(kind))) return [];
  const prior = new Map(
    before.patients.flatMap((p) =>
      p.appointments.map((a) => [JSON.stringify([p.id, a.id]), { patientId: p.id, a }]),
    ),
  );
  const events = [];
  function add(patientId, a, kind, removed = false, previous = null) {
    if (!selected.includes(kind) || !(startsAt(a, settings.timeZone) > now)) return;
    const bindings = recipients(platform, org, patientId);
    if (!Object.keys(bindings).length) return;
    events.push({
      patientId,
      appointmentId: a.id,
      kind,
      removed,
      staffId: a.staffId || '',
      sourceStamp: platform.appointmentConfirmations.stamp(a, settings.timeZone),
      preferenceVersion: settings.eventVersions?.[kind] || '',
      sourceRevision: next.revision,
      recipients: bindings,
      snapshot: snapshot(a),
      ...(previous ? { previous: { date: previous.date, time: previous.time } } : {}),
      expiresAt: Math.min(startsAt(a, settings.timeZone), now + 86400000),
    });
  }
  for (const p of next.patients)
    for (const a of p.appointments) {
      const key = JSON.stringify([p.id, a.id]),
        old = prior.get(key)?.a;
      prior.delete(key);
      if (a.status === 'cancelled') {
        if (old && isActiveAppointment(old)) add(p.id, a, 'cancelled');
      } else if (isActiveAppointment(a)) {
        if (!old || !isActiveAppointment(old)) add(p.id, a, 'created');
        else if (fingerprint(old, settings.timeZone) !== fingerprint(a, settings.timeZone))
          add(p.id, a, 'moved', false, old);
      }
    }
  const remainingPatients = new Set(next.patients.map((p) => p.id));
  for (const { patientId, a } of prior.values())
    if (remainingPatients.has(patientId) && isActiveAppointment(a))
      add(patientId, a, 'cancelled', true);
  return journal.record(storage, 'client', events, now);
}
function createClientAppointmentEvents({ platform, tenantStore, store, policy, clock }) {
  function replayOrganization(org) {
    if (!policy.readyChannels().length) return 0;
    const settings = platform.telegram.settings(org);
    const selected = clientNotificationEvents(settings.events);
    if (!settings.enabled || !lifecycleKinds.some((kind) => selected.includes(kind))) return 0;
    const storage = tenantStore(org);
    if (!journal.pending(storage, clock(), 'client').length) return 0;
    const nested = store.inTransaction?.() === true;
    const project = () =>
      storage.transaction(() =>
        journal.replay(
          storage,
          'client',
          (entry) => {
            if (!lifecycleKinds.includes(entry.kind)) return true;
            const intended = Object.entries(entry.recipients).filter(
              ([channel, expected]) =>
                platform.notificationChannels?.enabled?.(channel) !== false &&
                (expected.channelVersion || '') ===
                  (platform.notificationChannels?.version?.(channel) || ''),
            );
            if (!intended.length) return true;
            const current = policy.current(org, entry.patientId, entry.appointmentId, null, {
              kind: entry.kind,
              event: entry,
            });
            if (!current || current.stamp !== entry.sourceStamp) return true;
            const bindings = recipients(platform, org, entry.patientId);
            let complete = true;
            for (const [channel, expected] of intended) {
              if (!sameBinding(expected, bindings[channel])) continue;
              if (!current.channels.includes(channel)) {
                complete = false;
                continue;
              }
              store.enqueue(
                {
                  org,
                  patient: entry.patientId,
                  appointment: entry.appointmentId,
                  stamp: eventStamp(entry),
                  sourceStamp: entry.sourceStamp,
                  channel,
                  channelVersion: expected.channelVersion || '',
                  recipient: current.recipients[channel],
                  kind: entry.kind,
                  eventId: entry.id,
                  eventAt: entry.createdAt,
                  sourceRevision: entry.sourceRevision,
                  preferenceVersion: entry.preferenceVersion,
                  removed: entry.removed === true,
                  snapshot: entry.removed ? entry.snapshot : undefined,
                  previous: entry.previous,
                  expiresAt: entry.expiresAt,
                },
                clock(),
              );
            }
            return complete;
          },
          clock(),
        ),
      );
    const ids = nested
      ? project()
      : platform.withCompoundMutation
        ? compoundMutation(platform, storage, org, 'journal', project)
        : store.transaction(project);
    // An enclosing caller may still roll its platform transaction back. In that
    // case keep the journal; the next replay observes the queue's stable event key.
    if (!nested) storage.transaction(() => journal.retire(storage, ids, clock()));
    return ids.length;
  }
  return { replayOrganization };
}
module.exports = {
  recordClientAppointmentChanges,
  createClientAppointmentEvents,
  lifecycleKinds,
  eventStamp,
};
