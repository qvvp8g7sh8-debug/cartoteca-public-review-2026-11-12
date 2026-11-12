const { isActiveAppointment } = require('../../../shared/appointment-status.cjs');
const {
  fingerprint,
  serviceFingerprint,
  startsAt,
  clientNotificationEvents,
} = require('./appointments.cjs');
const { senderTitle, appointmentMessage } = require('./telegram-messages.cjs');
const { randomUUID } = require('node:crypto');
const { createTelegramPacing } = require('./telegram-pacing.cjs');
const { createNotificationScheduler } = require('./notification-scheduler.cjs');
const { createDeliveryLoops } = require('./delivery-loops.cjs');
const { createNotificationDiagnostics } = require('./notification-diagnostics140.cjs');
function createTelegramRuntime({
  platform,
  tenantStore,
  bot,
  clock = Date.now,
  pacing = createTelegramPacing(),
  origin = '',
  coordinator = null,
  canRun = () => true,
  runBackgroundWork = (callback) => callback(),
}) {
  const store = platform.telegram;
  const staff = require('./staff-runtime.cjs').createStaffTelegramRuntime({
    platform,
    tenantStore,
    bot,
    pacing,
    clock,
    origin,
    runBackgroundWork,
  });
  let running = false,
    connected = false,
    botId = '',
    username = '',
    error = '',
    controller,
    timer,
    busy = false;
  const pollOwner = randomUUID();
  const deliveryLoops = createDeliveryLoops();
  const queueDiagnostics = createNotificationDiagnostics();
  let nextSchedule = 0,
    generation = 0,
    scheduling = null,
    nextLeaseCheck = 0,
    lastLeaseCheck = null;
  let leader = false,
    polling = false,
    leaderTimer;
  const status = () => ({
    configured: Boolean(bot),
    connected,
    username,
    botId,
    error,
    queue: queueDiagnostics.snapshot(),
  });
  function resetLeaseProof() {
    nextLeaseCheck = 0;
    lastLeaseCheck = null;
  }
  function acquirePollLease() {
    const now = clock();
    try {
      leader = store.acquirePollLease(pollOwner, now);
      if (leader) {
        lastLeaseCheck = now;
        nextLeaseCheck = now + 10000;
      } else resetLeaseProof();
      return leader;
    } catch (failure) {
      queueDiagnostics.record('lease', failure);
      leader = false;
      resetLeaseProof();
      throw failure;
    }
  }
  function allowed(org) {
    try {
      return (
        platform.organization(org).status === 'active' &&
        platform.subscription(org).status === 'active' &&
        platform.subscription(org).limits.automaticNotifications
      );
    } catch {
      return false;
    }
  }
  function patient(org, id) {
    if (!allowed(org)) return null;
    return tenantStore(org).readSelected([id]).patients[0] || null;
  }
  function valid(job, { confirmation = false } = {}) {
    const config = store.settings(job.organization_id);
    if (
      !config.enabled ||
      (!confirmation &&
        (platform.notificationChannels?.enabled('telegram') === false ||
          (job.decoded.channelVersion || '') !==
            (platform.notificationChannels?.version('telegram') || '') ||
          !clientNotificationEvents(config.events).includes('reminder')))
    )
      return null;
    const p = patient(job.organization_id, job.patient_id),
      a = p?.appointments.find((a) => a.id === job.decoded.appointmentId),
      recipient = store.link(job.organization_id, job.patient_id);
    if (
      !a ||
      !isActiveAppointment(a) ||
      !recipient ||
      String(recipient.chatId) !== String(job.decoded.chatId) ||
      fingerprint(a, config.timeZone) !== job.fingerprint
    )
      return null;
    if (job.decoded.serviceFingerprint && job.decoded.serviceFingerprint !== serviceFingerprint(a))
      return null;
    const start = startsAt(a, config.timeZone);
    return start > clock() ? { appointment: a, settings: config, recipient, start } : null;
  }
  function privacyMarkup(org, id, callback = '') {
    const recipient = store.link(org, id),
      token = store.consentToken(org, id);
    if (!token) return null;
    const allow = !recipient.servicesConsent;
    return {
      inline_keyboard: [
        [
          {
            text: allow ? 'Показывать услуги' : 'Скрывать услуги',
            callback_data: `svc${allow ? 1 : 0}_${token}${callback ? '_' + callback : ''}`,
          },
        ],
      ],
    };
  }
  function reminderMarkup(job, current) {
    const rows = [
      [{ text: 'Подтвердить запись', callback_data: 'confirm_' + job.decoded.callback }],
    ];
    if (current.settings.showServices)
      rows.push(
        ...privacyMarkup(job.organization_id, job.patient_id, job.decoded.callback).inline_keyboard,
      );
    return { inline_keyboard: rows };
  }
  function buildMessage(job, current, confirmed = false) {
    return appointmentMessage(
      store.messageIdentity(job.organization_id, current.appointment.staffId),
      current.appointment,
      current.settings,
      {
        showServices: current.settings.showServices && current.recipient.servicesConsent === true,
        confirmed,
      },
    );
  }
  async function initialize(signal = controller?.signal) {
    if (!bot) return status();
    const epoch = generation;
    try {
      const info = await bot.initialize(signal);
      if (signal?.aborted || epoch !== generation) return status();
      username = info.username;
      botId = info.botId || '';
      connected = true;
      error = '';
    } catch (e) {
      if (signal?.aborted || epoch !== generation) return status();
      connected = false;
      username = '';
      error = e.status ? e.message : 'Telegram не подключён.';
    }
    return status();
  }
  function* scheduleOrganization(org, sliceVersion = () => 0) {
    const now = clock();
    if (!allowed(org)) return;
    const config = store.settings(org);
    if (
      !config.enabled ||
      !clientNotificationEvents(config.events).includes('reminder') ||
      platform.notificationChannels?.enabled('telegram') === false ||
      store.hasReminderRecipients?.(org) === false
    )
      return;
    const localDate = (time) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: config.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(time);
      const get = (type) => parts.find((p) => p.type === type).value;
      return get('year') + '-' + get('month') + '-' + get('day');
    };
    const candidates = tenantStore(org).indexes.appointments(
      localDate(now),
      localDate(now + config.leadMinutes * 60000),
    );
    let checkedSlice = sliceVersion(),
      current = config;
    for (const a of candidates) {
      // A yielded pass may resume after settings, plan or binding changes.
      if (checkedSlice !== sliceVersion()) {
        if (!allowed(org)) return;
        current = store.settings(org);
        if (
          !current.enabled ||
          !clientNotificationEvents(current.events).includes('reminder') ||
          platform.notificationChannels?.enabled('telegram') === false
        )
          return;
        checkedSlice = sliceVersion();
      }
      const currentNow = clock();
      const patientId = a.patientId,
        recipient = store.link(org, patientId);
      if (!recipient || !isActiveAppointment(a)) {
        yield;
        continue;
      }
      const start = startsAt(a, current.timeZone),
        stamp = fingerprint(a, current.timeZone);
      if (
        start > currentNow &&
        start - currentNow <= current.leadMinutes * 60000 &&
        !store.confirmed(org, patientId, stamp, serviceFingerprint(a)) &&
        !platform.appointmentConfirmations.read(org, patientId, a, current.timeZone)
      )
        store.enqueue(org, patientId, a, stamp, recipient, start, currentNow);
      yield;
    }
  }
  const scheduler = createNotificationScheduler({
    organizations: () =>
      store.reminderOrganizations ? store.reminderOrganizations() : store.organizations(),
    organizationBatch:
      store.reminderOrganizationBatch || store.organizationBatch
        ? (cursor, limit) =>
            store.reminderOrganizationBatch
              ? store.reminderOrganizationBatch(cursor, limit)
              : store.organizationBatch(cursor, limit)
        : null,
    work: scheduleOrganization,
  });
  function schedule() {
    if (!canRun()) return false;
    if (
      !coordinator &&
      (platform.notificationChannels?.enabled('telegram') === false ||
        store.hasReminderRecipients?.() === false)
    )
      return true;
    return coordinator ? coordinator.schedule() : scheduler.schedule();
  }
  function scheduleBatched(options = {}) {
    const epoch = generation,
      managed = running;
    const guard = () =>
      epoch === generation &&
      (!managed || (running && leader)) &&
      canRun() &&
      (!options.canRun || options.canRun());
    const signal = options.signal || controller?.signal;
    if (
      !coordinator &&
      (platform.notificationChannels?.enabled('telegram') === false ||
        store.hasReminderRecipients?.() === false)
    )
      return Promise.resolve(true);
    const runWork =
      options.runWork ||
      (managed
        ? (callback, org) => runBackgroundWork(() => (guard() ? callback() : null), org, guard)
        : undefined);
    return coordinator
      ? coordinator.scheduleBatched({ ...options, signal, canRun: guard, runWork })
      : scheduler.scheduleBatched({ ...options, signal, canRun: guard, runWork });
  }
  function beginScheduling(signal, active, epoch) {
    if (scheduling) return scheduling;
    const pending = Promise.resolve()
      .then(() => (active() ? scheduleBatched({ signal, canRun: active }) : false))
      .then((completed) => {
        if (completed && epoch === generation && active()) nextSchedule = clock() + 30000;
        return completed;
      })
      .catch((failure) => {
        if (epoch === generation && !signal?.aborted) {
          queueDiagnostics.record('planning', failure);
          error = 'Не удалось подготовить очередь напоминаний.';
          nextSchedule = clock() + 30000;
        }
        return false;
      })
      .finally(() => {
        if (scheduling === pending) scheduling = null;
      });
    scheduling = pending;
    return pending;
  }
  function deliveryContext() {
    const signal = controller?.signal,
      epoch = generation,
      managed = running;
    const active = () => {
      if (
        !canRun() ||
        signal?.aborted ||
        epoch !== generation ||
        (managed && (!running || !leader))
      )
        return false;
      if (managed) {
        const now = clock();
        if (lastLeaseCheck === null || now < lastLeaseCheck || now >= nextLeaseCheck)
          acquirePollLease();
      }
      return !managed || leader;
    };
    return { signal, epoch, managed, active };
  }
  async function tick() {
    if ((!connected && !coordinator) || busy || !canRun()) return;
    busy = true;
    const { signal, epoch, managed, active } = deliveryContext();
    try {
      if (!active()) return;
      if (!running || clock() >= nextSchedule) {
        // A live worker drains ready jobs while the global scan yields to HTTP.
        // Explicit one-shot callers still await preparation before delivery.
        if (managed) beginScheduling(signal, active, epoch);
        else {
          if (!(await scheduleBatched({ signal, canRun: active }))) return;
          if (!active()) return;
          nextSchedule = clock() + 30000;
        }
      }
      if (!active()) return;
      if (connected) await deliveryLoops.start('staff', () => staff.tick(signal, active));
      if (coordinator) {
        if (active()) await coordinator.tick(signal, active);
        return;
      }
      await deliveryLoops.start('legacy', () => drainLegacy(signal, active));
    } finally {
      busy = false;
    }
  }
  async function drainLegacy(signal, active, managed = false) {
    const runWork = (callback, org = '') =>
      managed ? runBackgroundWork(() => (active() ? callback() : null), org, active) : callback();
    if (
      platform.notificationChannels?.enabled('telegram') === false ||
      store.hasReminderRecipients?.() === false
    )
      return;
    for (let i = 0; i < 40; i++) {
      if (!active()) return;
      const claim = runWork(() =>
        managed && store.claimManaged ? store.claimManaged(clock()) : store.claim(clock()),
      );
      const job = claim && typeof claim.then === 'function' ? await claim : claim;
      if (!job) break;
      let acquired = false,
        acknowledged = false,
        providerStarted = false,
        leaseHandled = false;
      try {
        const validate = runWork(() => {
          const check = () => {
            const current = deliverable(job);
            if (!current) {
              leaseHandled = true;
              store.finish(job, 'cancelled');
            }
            return current;
          };
          return store.deliveryFor ? store.deliveryFor(job, check) : check();
        }, job.organization_id);
        if (!(validate && typeof validate.then === 'function' ? await validate : validate))
          continue;
        if (
          !(await (pacing.acquireDelivery || pacing.acquire).call(
            pacing,
            job.decoded.chatId,
            signal,
            1000,
          ))
        ) {
          const nextAt = clock() + Math.max(1000, pacing.remaining(job.decoded.chatId));
          leaseHandled = true;
          store.defer(job, nextAt);
          break;
        }
        acquired = true;
        if (!active()) return;
        // Waiting must not deliver a cancelled, changed or confirmed appointment.
        const prepare = runWork(() => {
          // Only a legacy binding without a capability needs this policy
          // initialization. Repeat every delivery guard after it, under ownership.
          if (store.deliveryFor) store.consentToken?.(job.organization_id, job.patient_id);
          const check = () => {
            const current = deliverable(job);
            if (!current) {
              leaseHandled = true;
              store.finish(job, 'cancelled');
              return null;
            }
            return { text: buildMessage(job, current), markup: reminderMarkup(job, current) };
          };
          const prepared = store.deliveryFor ? store.deliveryFor(job, check) : check();
          if (!prepared) return null;
          providerStarted = true;
          return { pending: bot.send(job.decoded.chatId, prepared.text, prepared.markup, signal) };
        }, job.organization_id);
        const prepared = prepare && typeof prepare.then === 'function' ? await prepare : prepare;
        if (!prepared) continue;
        await prepared.pending;
        acknowledged = true;
        store.finish(job, 'sent');
      } catch (e) {
        if (e.outcomeUnknown || e.channelPoisoned) {
          leaseHandled = true;
          throw e;
        }
        if (!providerStarted || acknowledged) throw e;
        if (signal?.aborted) return;
        if (e.status === 403) {
          store.finish(job, 'failed');
          store.stopChat(job.decoded.chatId);
          platform.staffNotifications?.stopChat(job.decoded.chatId);
        } else if (e.status === 429) {
          pacing.pause(e.retryAfter);
          store.defer(job, clock() + Math.max(1, Number(e.retryAfter) || 30) * 1000);
          break;
        } else
          store.finish(
            job,
            job.attempts >= 5 ? 'failed' : 'pending',
            clock() +
              Math.max(Number(e.retryAfter) || 0, Math.min(3600, 30 * 2 ** job.attempts)) * 1000,
          );
      } finally {
        // Admission/validation/pacing stopped before POST: exact lease CAS
        // returns this attempt promptly and cannot revive a changed job.
        try {
          // An explicit cancellation/cooldown already attempted this exact lease.
          // Do not issue another SQL write, including after an uncertain write error.
          if (!providerStarted && !leaseHandled)
            store.defer(job, Math.max(job.next_at || 0, clock() + 1000));
        } finally {
          if (acquired) pacing.releaseDelivery?.(job.decoded.chatId);
        }
      }
    }
  }
  async function managedTick() {
    if (!running || (!connected && !coordinator) || busy || !canRun()) return;
    const { signal, epoch, active } = deliveryContext();
    if (!active()) return;
    const failed = (failure) => {
      if (epoch === generation && running && !signal?.aborted) {
        queueDiagnostics.record('delivery', failure);
        error = 'Не удалось обработать очередь напоминаний.';
      }
    };
    if (clock() >= nextSchedule) beginScheduling(signal, active, epoch);
    if (connected)
      deliveryLoops.start('staff', () => (staff.tickManaged || staff.tick)(signal, active), failed);
    if (coordinator?.tickManaged) {
      // Each free channel can drain another bounded batch while its sibling or
      // staff delivery still awaits a provider. The worker owns channel overlap.
      void coordinator.tickManaged(signal, active).catch(failed);
    } else if (coordinator) {
      deliveryLoops.start('client', () => coordinator.tick(signal, active), failed);
    } else {
      deliveryLoops.start('legacy', () => drainLegacy(signal, active, true), failed);
    }
  }
  function deliverable(job) {
    const current = valid(job);
    if (
      !current ||
      !current.settings.enabled ||
      store.confirmed(
        job.organization_id,
        job.patient_id,
        job.fingerprint,
        serviceFingerprint(current.appointment),
      ) ||
      platform.appointmentConfirmations.read(
        job.organization_id,
        job.patient_id,
        current.appointment,
        current.settings.timeZone,
      )
    )
      return null;
    return current;
  }
  async function reply(chatId, text, markup = null) {
    try {
      await pacing.acquire(chatId, controller?.signal);
      await bot.send(chatId, text, markup, controller?.signal);
    } catch (e) {
      if (e.status === 429) pacing.pause(e.retryAfter);
      if (e.status === 403 || e.providerCode === 400) {
        store.stopChat(chatId);
        platform.staffNotifications?.stopChat(chatId);
        return;
      }
      throw e;
    }
  }
  async function handleUpdate(update) {
    const message = update.message;
    if (message?.chat?.type === 'private' && String(message.from?.id) === String(message.chat.id)) {
      const chatId = String(message.chat.id),
        command = (message.text || '').trim();
      if (/^\/stop(?:@\w+)?$/.test(command)) {
        store.stopChat(chatId);
        platform.staffNotifications?.stopChat(chatId);
        await reply(
          chatId,
          'Уведомления отключены. Клиенту нужна новая ссылка от специалиста; сотруднику — из своего аккаунта картотеки.',
        );
        return;
      }
      if (platform.staffNotifications && (await staff.handleStart(command, chatId, reply))) return;
      if (/^\/privacy(?:@\w+)?$/.test(command)) {
        const links = store
          .chatLinks(chatId)
          .filter((row) => Boolean(patient(row.organization_id, row.patient_id)));
        if (!links.length)
          await reply(chatId, 'Сначала подключите Telegram по персональной ссылке организации.');
        for (const row of links)
          await reply(
            chatId,
            `${senderTitle(store.messageIdentity(row.organization_id))}\n\nВы выбираете, показывать ли названия услуг в напоминаниях этой организации. Они могут быть видны на экране блокировки.`,
            privacyMarkup(row.organization_id, row.patient_id),
          );
        return;
      }
      if (/^\/start(?:@\w+)?(?:\s|$)/.test(command)) {
        const token = command.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{43})$/)?.[1];
        let text =
            'Для подключения напоминаний откройте персональную ссылку, полученную от организации. Отключить сообщения: /stop',
          markup = null;
        if (token) {
          try {
            const row = store.consumeLink(
              token,
              chatId,
              (org, id, actor, role) => {
                const p = patient(org, id);
                return Boolean(
                  p &&
                  (role !== 'cosmetologist' ||
                    p.createdBy === actor ||
                    p.visits.some((v) => v.staffId === actor) ||
                    p.appointments.some((a) => a.staffId === actor)),
                );
              },
              clock(),
            );
            const org = row.organization_id,
              id = row.patient_id,
              details = store.settings(org).showServices,
              visible = store.link(org, id).servicesConsent;
            text = `${senderTitle(store.messageIdentity(org))}\n\nTelegram подключён. Здесь будут напоминания с датой, временем и длительностью записи.\n${details ? (visible ? 'Названия услуг включены.' : 'Названия услуг скрыты по вашему выбору.') + ' Они могут быть видны на экране блокировки.\n' : ''}Подтвердить запись можно кнопкой под напоминанием. Показ услуг: /privacy. Отключить сообщения: /stop`;
            if (details) markup = privacyMarkup(org, id);
          } catch (e) {
            text = e.status
              ? e.message
              : 'Не удалось подключить Telegram. Обратитесь к специалисту.';
          }
        }
        await reply(chatId, text, markup);
      }
    }
    const callback = update.callback_query;
    if (callback) {
      let text = 'Эта кнопка больше не действует. Свяжитесь со специалистом.';
      const privacy = callback.data?.match(
        /^svc([01])_([A-Za-z0-9_-]{27})(?:_([A-Za-z0-9_-]{27}))?$/,
      );
      if (
        privacy &&
        callback.message?.chat?.type === 'private' &&
        String(callback.from?.id) === String(callback.message.chat.id)
      ) {
        const chatId = String(callback.from.id),
          allow = privacy[1] === '1',
          row = store.serviceConsent(
            privacy[2],
            chatId,
            allow,
            (org, id) => Boolean(patient(org, id)),
            clock(),
          );
        if (row) {
          text = allow
            ? 'Показ услуг включён для этой организации.'
            : 'Названия услуг будут скрыты.';
          if (row.changed) {
            const job = privacy[3] ? store.callback(privacy[3]) : null,
              current =
                job &&
                String(job.decoded.chatId) === chatId &&
                job.organization_id === row.organization_id &&
                job.patient_id === row.patient_id
                  ? valid(job)
                  : null;
            if (allow && current && current.settings.showServices) {
              const confirmed = Boolean(
                store.confirmed(
                  job.organization_id,
                  job.patient_id,
                  job.fingerprint,
                  serviceFingerprint(current.appointment),
                ),
              );
              await reply(
                chatId,
                buildMessage(job, current, confirmed),
                confirmed
                  ? privacyMarkup(row.organization_id, row.patient_id)
                  : reminderMarkup(job, current),
              );
            } else
              await reply(
                chatId,
                `${senderTitle(store.messageIdentity(row.organization_id))}\n\n${text}\nИзменить выбор: /privacy. Отключить сообщения: /stop`,
                privacyMarkup(
                  row.organization_id,
                  row.patient_id,
                  current ? job.decoded.callback : '',
                ),
              );
          }
        }
      }
      const token = callback.data?.match(/^confirm_([A-Za-z0-9_-]{27})$/)?.[1];
      if (
        token &&
        callback.message?.chat?.type === 'private' &&
        String(callback.from?.id) === String(callback.message.chat.id)
      ) {
        const job = store.callback(token),
          chatId = String(callback.from.id);
        const shared = coordinator?.confirm('telegram', token, { chatId });
        if (shared) text = 'Спасибо! Вы подтвердили запись.';
        const current =
          job && String(job.decoded.chatId) === chatId ? valid(job, { confirmation: true }) : null;
        if (current) {
          const receipt = coordinator
            ? coordinator.confirmLegacy(job, chatId)
            : { first: store.confirm(job, chatId, clock()) };
          if (receipt) {
            if (!coordinator && receipt.first)
              platform.withWriteLock(() => {
                platform.staffPush?.confirmation(
                  job.organization_id,
                  job.patient_id,
                  current.appointment,
                );
                require('./staff-appointment-events.cjs').staffConfirmation(
                  platform,
                  job.organization_id,
                  job.patient_id,
                  current.appointment,
                  clock(),
                );
              });
            text = 'Спасибо! Вы подтвердили запись.';
          }
        }
      }
      try {
        await bot.answer(callback.id, text, controller?.signal);
        if (
          token &&
          callback.message?.chat?.type === 'private' &&
          String(callback.from?.id) === String(callback.message.chat.id) &&
          bot.clearButtons &&
          Number.isSafeInteger(callback.message.message_id)
        ) {
          try {
            const contact =
              callback.message.reply_markup?.inline_keyboard
                ?.flat()
                .find(
                  (item) =>
                    typeof item.url === 'string' &&
                    item.url.startsWith('https://wa.me/') &&
                    /^[1-9]\d{6,14}$/.test(item.url.slice(14)),
                )?.url || '';
            await bot.clearButtons(
              String(callback.from.id),
              callback.message.message_id,
              controller?.signal,
              contact,
            );
          } catch {
            /* Confirmation is already committed; UI cleanup never changes its result. */
          }
        }
      } catch (e) {
        if (e.providerCode !== 400 && e.status !== 403) throw e;
      }
    }
    if (
      update.my_chat_member?.chat?.type === 'private' &&
      update.my_chat_member.new_chat_member?.status === 'kicked'
    ) {
      store.stopChat(String(update.my_chat_member.chat.id));
      platform.staffNotifications?.stopChat(String(update.my_chat_member.chat.id));
    }
  }
  async function poll(signal) {
    while (running && leader && !signal.aborted && canRun()) {
      try {
        if (!connected) {
          await initialize(signal);
          if (!running || !leader || signal.aborted || !canRun()) break;
          if (!connected) throw Error('Disconnected');
        }
        const updates = await bot.updates(store.offset(), signal);
        if (!running || !leader || signal.aborted || !canRun()) break;
        if (!acquirePollLease()) {
          leader = false;
          break;
        }
        for (const update of updates) {
          if (!running || !leader || signal.aborted || !canRun()) break;
          await handleUpdate(update);
          if (!running || !leader || signal.aborted || !canRun()) break;
          store.offset(update.update_id + 1);
        }
      } catch (failure) {
        if (!running || !leader || signal.aborted) break;
        queueDiagnostics.record('poll', failure);
        resetLeaseProof();
        if (connected || !error) error = 'Нет связи с Telegram. Повторяем подключение.';
        connected = false;
        await new Promise((resolve) => {
          let retry;
          const finish = () => {
            clearTimeout(retry);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          retry = setTimeout(finish, 5000);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    }
  }
  function coordinate() {
    if (!running) return;
    if (!canRun()) {
      leader = false;
      resetLeaseProof();
      controller?.abort();
      return;
    }
    try {
      acquirePollLease();
      if (!leader) {
        controller?.abort();
        controller = undefined;
        return;
      }
      const replaced = !controller || controller.signal.aborted;
      if (replaced) controller = new AbortController();
      if ((!polling || replaced) && bot) {
        const current = controller;
        polling = true;
        void poll(current.signal)
          .catch(() => {
            if (controller === current && !current.signal.aborted)
              error = 'Не удалось обработать Telegram.';
          })
          .finally(() => {
            if (controller === current) polling = false;
          });
      }
    } catch {
      leader = false;
      resetLeaseProof();
      controller?.abort();
      error = 'Не удалось получить доступ к обработке Telegram.';
    }
  }
  function start() {
    if ((!bot && !coordinator) || running) return;
    resetLeaseProof();
    generation++;
    running = true;
    coordinate();
    if (!leader && bot) void initialize(); // Every web worker can show a valid bot identity; only the leader polls.
    leaderTimer = setInterval(coordinate, 10000);
    timer = setInterval(() => {
      if (leader)
        void managedTick().catch(() => {
          error = 'Не удалось обработать очередь напоминаний.';
        });
    }, 250);
  }
  function stop() {
    const wasRunning = running;
    resetLeaseProof();
    generation++;
    running = false;
    leader = false;
    controller?.abort();
    clearInterval(timer);
    clearInterval(leaderTimer);
    staff.close();
    coordinator?.stop?.();
    if (wasRunning) store.releasePollLease(pollOwner);
  }
  return {
    status,
    initialize,
    schedule,
    scheduleBatched,
    tick,
    handleUpdate,
    start,
    stop,
  };
}
module.exports = { createTelegramRuntime };
