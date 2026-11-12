const { readCabinetSnapshot } = require('../../infrastructure/cabinet-read-snapshot.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { startsAt, fingerprint, clientNotificationEvents } = require('./appointments.cjs');
const { createDueRunner } = require('./notification-due-runner.cjs');

function createClientDueScheduler({ platform, tenantStore, store, links, policy, enqueue, clock }) {
  const schedule = platform.notificationSchedule;
  function rebuild(org, patient) {
    let tasks = [];
    const settings = platform.telegram.settings(org),
      plan = platform.subscription(org);
    if (
      schedule.linked(org, patient) &&
      settings.enabled &&
      clientNotificationEvents(settings.events).includes('reminder') &&
      (!store.hasReminderRecipients ||
        store.hasReminderRecipients(org, policy.configuredChannels())) &&
      platform.organization(org).status === 'active' &&
      plan.status === 'active' &&
      plan.limits.automaticNotifications
    ) {
      const storage = tenantStore(org);
      // Addressed read: no date-window scan, no other patients' profiles/history.
      tasks = readCabinetSnapshot(storage, () => {
        const appointments = storage.readPatientAppointments
          ? storage.readPatientAppointments(patient)
          : storage.readSelected([patient]).patients[0]?.appointments || [];
        return appointments.filter(isActiveAppointment).flatMap((a) => {
          const expiresAt = startsAt(a, settings.timeZone);
          if (!(expiresAt > clock())) return [];
          return [
            {
              entity: a.id,
              dueAt: Math.max(clock(), expiresAt - settings.leadMinutes * 60000),
              expiresAt,
              value: { stamp: platform.appointmentConfirmations.stamp(a, settings.timeZone) },
            },
          ];
        });
      });
    }
    schedule.replaceTasks('client', org, patient, tasks);
  }
  function dispatch(task, admit) {
    const org = task.organization_id,
      patient = task.subject,
      appointment = task.entity;
    const finish = (nextAt = null) =>
      admit((onEntered) => schedule.finishTask(task, nextAt, onEntered));
    const settings = platform.telegram.settings(org);
    if (
      task.expires_at <= clock() ||
      !settings.enabled ||
      !clientNotificationEvents(settings.events).includes('reminder') ||
      (store.hasReminderRecipients &&
        !store.hasReminderRecipients(org, policy.configuredChannels()))
    ) {
      finish();
      return;
    }
    // Readiness can recover without a settings mutation. Keep the due task and
    // check indexed bindings before reopening a temporarily disconnected cabinet.
    const ready = policy.readyChannels();
    if (
      !ready.length ||
      (store.linkedPatients && !store.linkedPatients(org, [patient], ready).has(patient))
    ) {
      finish(Math.min(task.expires_at, clock() + 30000));
      return;
    }
    const current = policy.current(org, patient, appointment, null, { kind: 'reminder' });
    if (!current || current.confirmed || !schedule.linked(org, patient)) {
      finish();
      return;
    }
    const dueAt = current.expiresAt - current.settings.leadMinutes * 60000;
    if (dueAt > clock()) {
      finish(dueAt);
      return;
    }
    // The callback checks the deadline again inside fresh platform -> cabinet
    // locks. A move racing with this read cannot send an early notification.
    admit((onEntered) => enqueue(org, patient, appointment, onEntered, 'reminder', true));
    const jobs = store.list(org, patient, appointment, current.stamp);
    const channels = [];
    if (
      platform.notificationChannels?.enabled?.('telegram') !== false &&
      platform.telegram.link(org, patient)
    )
      channels.push('telegram');
    const max = links.link(org, patient);
    if (platform.notificationChannels?.enabled?.('max') !== false && max && !max.restoredPaused)
      channels.push('max');
    const legacy = platform.telegram.delivery(
      org,
      patient,
      fingerprint(current.a, current.settings.timeZone),
    );
    const complete = channels.every(
      (channel) =>
        (channel === 'telegram' && ['sending', 'sent', 'failed'].includes(legacy)) ||
        jobs.some((job) => job.channel === channel && job.status !== 'cancelled'),
    );
    // Temporarily unready providers are retried only for an actually due task;
    // failed/uncertain deliveries remain governed by their existing queue policy.
    finish(complete ? null : Math.min(current.expiresAt, clock() + 30000));
  }
  const recover = () =>
    schedule.recoverExpired(
      (org) => {
        const settings = platform.telegram.settings(org);
        if (
          !settings.enabled ||
          !clientNotificationEvents(settings.events).includes('reminder') ||
          (store.hasReminderRecipients &&
            !store.hasReminderRecipients(org, policy.configuredChannels()))
        )
          return;
        const storage = tenantStore(org);
        readCabinetSnapshot(storage, () => storage.readSelected([], []));
      },
      clock(),
      1,
    );
  return createDueRunner({ schedule, kind: 'client', rebuild, dispatch, recover, clock });
}
module.exports = { createClientDueScheduler };
