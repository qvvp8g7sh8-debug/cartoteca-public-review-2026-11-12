const { compoundMutation } = require('../cabinet/compound-mutation133.cjs');
const { fingerprint, serviceFingerprint } = require('./appointments.cjs');
const { createNotificationPolicy } = require('./notification-policy.cjs');
const { createNotificationWorker } = require('./notification-worker.cjs');
const { fail } = require('../../../shared/errors.cjs');
const { classicNotices } = require('../booking/classic-confirmation.cjs');
const { classicConfirmation } = require('../booking/classic-confirmation.cjs');
const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const { appointmentRows, pairKey } = require('./appointment-state-batch.cjs');
const { createNotificationScheduler } = require('./notification-scheduler.cjs');
const { createClientAppointmentEvents } = require('./client-appointment-events.cjs');
const { clientNotificationEvents } = require('./appointments.cjs');

// Explicit staging composition. No tokens, migrations, timers or provider calls here.
function createNotificationCoordinator({
  platform,
  tenantStore,
  store,
  links,
  providers,
  clock = Date.now,
  runBackgroundWork,
}) {
  const policy = createNotificationPolicy({
    platform,
    tenantStore,
    store,
    links,
    providers,
    clock,
  });
  const worker = createNotificationWorker({
    platform,
    tenantStore,
    store,
    policy,
    providers,
    clock,
    runBackgroundWork,
  });
  const clientEvents = createClientAppointmentEvents({
    platform,
    tenantStore,
    store,
    policy,
    clock,
  });
  function enqueue(
    org,
    patient,
    appointment,
    authorize = () => {},
    kind = 'reminder',
    onlyDue = false,
  ) {
    if (!policy.readyChannels().length) return null;
    const storage = tenantStore(org);
    const commit = (callback) =>
      store.inTransaction?.() === true
        ? callback()
        : platform.withCompoundMutation
          ? compoundMutation(platform, storage, org, 'journal', callback)
          : store.transaction(callback);
    return commit(() =>
      storage.transaction(() => {
        authorize();
        const current = policy.current(org, patient, appointment, null, { kind });
        if (
          !current ||
          (kind !== 'booking-confirmed' &&
            !clientNotificationEvents(current.settings.events).includes(kind)) ||
          !current.channels.length ||
          (onlyDue && current.expiresAt - clock() > current.settings.leadMinutes * 60000) ||
          (kind === 'booking-confirmed' ? !current.automatic : current.confirmed)
        )
          return null;
        // Honor legacy messages already sent or in flight. Cancel only never-sent legacy work.
        const legacy = platform.telegram.delivery(
          org,
          patient,
          fingerprint(current.a, current.settings.timeZone),
        );
        if (legacy === 'pending')
          store.cancelLegacyPending(
            org,
            patient,
            fingerprint(current.a, current.settings.timeZone),
          );
        const jobs = current.channels
          // Existing Telegram delivery suppresses only another Telegram send, not MAX.
          .filter(
            (channel) => channel !== 'telegram' || !['sending', 'sent', 'failed'].includes(legacy),
          )
          .map((channel) =>
            store.enqueue(
              {
                org,
                patient,
                appointment,
                stamp: current.stamp,
                channel,
                channelVersion: platform.notificationChannels?.version?.(channel) || '',
                recipient: current.recipients[channel],
                expiresAt: current.expiresAt,
                kind,
              },
              clock(),
            ),
          );
        return jobs[0] || null;
      }),
    );
  }
  function* scheduleOrganization(org) {
    clientEvents.replayOrganization(org);
    yield;
    const plan = platform.subscription(org);
    if (
      platform.organization(org).status !== 'active' ||
      plan.status !== 'active' ||
      !plan.limits.automaticNotifications
    )
      return;
    const settings = platform.telegram.settings(org);
    if (!settings.enabled || !clientNotificationEvents(settings.events).includes('reminder'))
      return;
    for (const entry of classicNotices(tenantStore(org), clock())) {
      enqueue(org, entry.patientId, entry.appointmentId, undefined, 'booking-confirmed');
      yield;
    }
    const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: settings.timeZone });
    const rows = tenantStore(org).indexes.appointments(
      formatter.format(new Date(clock())),
      formatter.format(new Date(clock() + settings.leadMinutes * 60000)),
    );
    for (let offset = 0; offset < rows.length; offset += 200) {
      const batch = rows.slice(offset, offset + 200);
      const linked = store.linkedPatients?.(
        org,
        batch.map((row) => row.patientId).filter(Boolean),
        policy.readyChannels(),
      );
      for (const row of batch) {
        // A link added after this small candidate snapshot is picked up by the
        // next pass. Removed/rebound/paused links still face both fresh checks.
        if (row.patientId && (!linked || linked.has(row.patientId))) {
          const current = policy.current(org, row.patientId, row.id);
          if (
            current?.channels.length &&
            current.expiresAt - clock() <= current.settings.leadMinutes * 60000
          )
            enqueue(org, row.patientId, row.id);
        }
        yield;
      }
    }
  }
  const scheduler = createNotificationScheduler({
    organizations: () => store.organizations(policy.readyChannels()),
    organizationBatch: store.organizationBatch
      ? (cursor, limit) => store.organizationBatch(cursor, limit, policy.readyChannels())
      : null,
    work: scheduleOrganization,
  });
  const reminderScheduler = platform.notificationSchedule?.enabled
    ? require('./client-due-scheduler.cjs').createClientDueScheduler({
        platform,
        tenantStore,
        store,
        links,
        policy,
        enqueue,
        clock,
      })
    : scheduler;
  // The prepared schema18 due scheduler does not enumerate organizations. Keep
  // lifecycle outbox recovery bounded and independent of reminder due dates.
  const lifecycleScheduler = platform.notificationSchedule?.enabled
    ? createNotificationScheduler({
        organizations: () => store.organizations(policy.readyChannels(), 'lifecycle'),
        organizationBatch: store.organizationBatch
          ? (cursor, limit) =>
              store.organizationBatch(cursor, limit, policy.readyChannels(), 'lifecycle')
          : null,
        work: function* (org) {
          clientEvents.replayOrganization(org);
          yield;
        },
      })
    : null;
  const runReminders = () =>
    !lifecycleScheduler ||
    !store.hasReminderRecipients ||
    store.hasReminderRecipients('', policy.configuredChannels()) ||
    Boolean(platform.notificationSchedule.nextDirty('client'));
  let preparing = false;
  const schedule = () => {
    if (preparing) return false;
    if (!policy.readyChannels().length) return true;
    return (
      (!lifecycleScheduler || lifecycleScheduler.schedule()) &&
      (!runReminders() || reminderScheduler.schedule())
    );
  };
  const scheduleBatched = async (options = {}) => {
    if (preparing) return false;
    preparing = true;
    try {
      if (options.signal?.aborted || (options.canRun && !options.canRun())) return false;
      if (!policy.readyChannels().length) return true;
      const reminders = runReminders();
      if (!lifecycleScheduler)
        return reminders ? await reminderScheduler.scheduleBatched(options) : true;
      const controller = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      let failed = false,
        firstError;
      const observe = (work) =>
        Promise.resolve()
          .then(work)
          .catch((error) => {
            if (!failed) {
              failed = true;
              firstError = error;
            }
            controller.abort();
            throw error;
          });
      const run = (scheduler) => observe(() => scheduler.scheduleBatched({ ...options, signal }));
      // Each lane keeps its existing bounded synchronous callbacks/admission.
      // No transaction or borrowed DB cursor spans a callback's await boundary;
      // the scheduler's JavaScript work iterator may remain alive between batches.
      const lifecycle = run(lifecycleScheduler);
      const due = reminders
        ? run(reminderScheduler)
        : observe(async () => {
            if ((await lifecycle) !== true || signal.aborted) return false;
            return runReminders()
              ? reminderScheduler.scheduleBatched({ ...options, signal })
              : true;
          });
      const outcomes = await Promise.allSettled([lifecycle, due]);
      if (failed) throw firstError;
      return outcomes.every((result) => result.status === 'fulfilled' && result.value === true);
    } finally {
      preparing = false;
    }
  };
  // Caller owns platform → cabinet locks. In-flight deliveries cannot be recalled.
  function cancelPending(org, patient, appointment = '') {
    store.cancel(org, patient, appointment);
  }
  function confirm(channel, token, recipient) {
    const job = store.callback(token);
    if (!job || job.decoded.channel !== channel) return null;
    const expected = job.decoded.recipient;
    if (
      (channel === 'max' &&
        (expected.userId !== recipient.userId || expected.botId !== recipient.botId)) ||
      (channel === 'telegram' && expected.chatId !== recipient.chatId)
    )
      return null;
    return worker.locked(job, () => {
      const fresh = store.callback(token);
      if (!fresh) return null;
      const current = policy.valid(fresh, { confirmation: true });
      if (!current) return null;
      // Staff or a legacy Telegram button may have confirmed before either new bot.
      if (current.confirmed) {
        store.cancelKinds(
          fresh.organization_id,
          ['reminder'],
          fresh.patient_id,
          fresh.appointment_id,
        );
        return typeof current.confirmed === 'object'
          ? { ...current.confirmed, first: false }
          : { telegramConfirmedAt: current.confirmed, first: false };
      }
      const receipt = store.confirm(fresh, clock());
      if (receipt.first) {
        platform.staffPush?.confirmation(fresh.organization_id, fresh.patient_id, current.a);
        require('./staff-appointment-events.cjs').staffConfirmation(
          platform,
          fresh.organization_id,
          fresh.patient_id,
          current.a,
          clock(),
        );
      }
      return receipt;
    });
  }
  function confirmLegacy(job, chatId) {
    return worker.locked(job, () => {
      const fresh = platform.telegram.callback(job.decoded.callback);
      if (!fresh || fresh.id !== job.id || fresh.fingerprint !== job.fingerprint) return null;
      job = fresh;
      const current = policy.current(
        job.organization_id,
        job.patient_id,
        job.decoded.appointmentId,
      );
      if (
        !current ||
        current.recipients.telegram?.chatId !== chatId ||
        String(job.decoded.chatId) !== chatId ||
        fingerprint(current.a, current.settings.timeZone) !== job.fingerprint ||
        (job.decoded.serviceFingerprint &&
          job.decoded.serviceFingerprint !== serviceFingerprint(current.a))
      )
        return null;
      if (current.confirmed) {
        store.cancelKinds(job.organization_id, ['reminder'], job.patient_id, current.a.id);
        return typeof current.confirmed === 'object'
          ? { ...current.confirmed, first: false }
          : { telegramConfirmedAt: current.confirmed, first: false };
      }
      const receipt = store.confirm(
        {
          ...job,
          appointment_id: current.a.id,
          stamp: current.stamp,
          decoded: { channel: 'telegram' },
        },
        clock(),
      );
      if (receipt.first) {
        platform.staffPush?.confirmation(job.organization_id, job.patient_id, current.a);
        require('./staff-appointment-events.cjs').staffConfirmation(
          platform,
          job.organization_id,
          job.patient_id,
          current.a,
          clock(),
        );
      }
      return receipt;
    });
  }
  function describe(org, patient, a, read = null) {
    const current = policy.current(org, patient, a.id, read?.policy);
    const zone = read ? read.zone : platform.organizationTimeZone(org),
      stamp = read
        ? read.stamps.get(pairKey(patient, a.id))
        : platform.appointmentConfirmations.stamp(a, zone);
    const jobs = read
      ? read.jobs.get(pairKey(patient, a.id)) || []
      : store.list(org, patient, a.id, stamp);
    const statuses = jobs.map((job) => job.status);
    const status =
      ['sending', 'pending', 'reserved', 'uncertain', 'failed', 'sent'].find((value) =>
        statuses.includes(value),
      ) || null;
    const channels = current?.channels || [];
    return {
      ...(read
        ? isActiveAppointment(a)
          ? classicConfirmation(platform, read.policy.storage, patient, a, zone) ||
            read.receipts.get(pairKey(patient, a.id))
          : null
        : policy.receipt(org, patient, a, zone)),
      deliveryReady: true,
      // Preserve scalar compatibility; channels are authoritative for new clients.
      deliveryChannel: channels[0] || '',
      deliveryChannels: channels,
      deliveryStatuses: jobs.map((job) => ({ channel: job.decoded.channel, status: job.status })),
      deliveryStatus:
        status ||
        (!clientNotificationEvents(
          (read?.policy.settings || platform.telegram.settings(org)).events,
        ).includes('reminder')
          ? 'disabled'
          : !channels.length && !current?.confirmed
            ? 'blocked'
            : null),
    };
  }
  function responseReadRequests(org, patients, entries) {
    const ids = patients.map((p) => p.id);
    const staff = patients.flatMap((p) => p.appointments.map((a) => a.staffId).filter(Boolean));
    return [
      ...(platform.telegram.confirmedMany.readRequests?.(org, entries) || []),
      ...(platform.appointmentConfirmations.readMany.readRequests?.(org, entries) || []),
      ...(store.readMany.readRequests?.(org, entries) || []),
      ...(platform.telegram.linksMany.readRequests?.(org, ids) || []),
      ...(links.linksMany.readRequests?.(org, ids) || []),
      ...(links.membersMany.readRequests?.(org, staff) || []),
    ];
  }
  function prefetchResponseReads(org, patients, entries) {
    return store.prefetchReads
      ? store.prefetchReads(responseReadRequests(org, patients, entries))
      : false;
  }

  function describeMany(
    org,
    patients,
    {
      zone = platform.organizationTimeZone(org),
      entries = appointmentRows(patients, zone, platform.appointmentConfirmations),
      responseRead = null,
    } = {},
  ) {
    const batch = store.readMany(org, entries);
    const read = {
      ...batch,
      zone,
      stamps: new Map(
        entries.map((entry) => [pairKey(entry.patient, entry.appointment), entry.stamp]),
      ),
      policy: policy.readContext(
        org,
        patients,
        responseRead
          ? { ...responseRead, receiptEntries: entries, receipts: batch.receipts }
          : null,
      ),
    };
    return new Map(
      patients.flatMap((p) =>
        p.appointments.map((a) => [pairKey(p.id, a.id), describe(org, p.id, a, read)]),
      ),
    );
  }
  function remind(org, patient, appointment, authorize) {
    const job = enqueue(org, patient, appointment, authorize);
    if (!job) throw fail(409, 'Запись подтверждена или нет доступных подключённых каналов.');
    return job;
  }
  return {
    schedule,
    scheduleBatched,
    replayAppointmentEvents: clientEvents.replayOrganization,
    tick: worker.tick,
    tickManaged: worker.tickManaged,
    stop: worker.close,
    cancelPending,
    confirm,
    confirmLegacy,
    describe,
    describeMany,
    prefetchResponseReads,
    responseReadRequests,
    receipt: policy.receipt,
    remind,
    booked: (org, patient, appointment) =>
      enqueue(org, patient, appointment, undefined, 'booking-confirmed'),
  };
}
module.exports = { createNotificationCoordinator };
