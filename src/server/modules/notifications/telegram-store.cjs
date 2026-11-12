const {
  settingsRule,
  serviceFingerprint,
  clientNotificationEvents,
} = require('./appointments.cjs');
const { cancelNotificationKinds } = require('./notification-store.cjs');
const { createBatchQuery, pairKey } = require('./appointment-state-batch.cjs');
const { createQueueCompatibilityMaintenance } = require('./queue-compatibility-maintenance.cjs');
function createTelegramStore(context) {
  const { db, seal, open, crypto, tokenHash, limitKey, transaction, audit, fail, id } = context;
  const queueTransaction = context.queueTransaction
    ? (work) => context.queueTransaction(work, 'telegram')
    : (work) => (db.isTransaction ? work() : transaction(work));
  const interest = require('./client-notification-interest.cjs').createClientNotificationInterest(
    context,
  );
  const confirmationSql =
    'SELECT c.confirmed_at,j.value FROM telegram_confirmations c JOIN telegram_links l ON l.organization_id=c.organization_id AND l.patient_id=c.patient_id AND l.chat_hash=c.chat_hash LEFT JOIN telegram_jobs j ON j.organization_id=c.organization_id AND j.patient_id=c.patient_id AND j.fingerprint=c.fingerprint WHERE c.organization_id=? AND c.patient_id=? AND c.fingerprint=?';
  const confirmationQuery = db.prepare(confirmationSql);
  const confirmationsQuery = createBatchQuery(
    db,
    `SELECT c.patient_id,
    json_extract(r.value,'$.appointment') appointment_id,
    json_extract(r.value,'$.services') services,c.confirmed_at,j.value
    FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN telegram_confirmations c
      ON c.patient_id=json_extract(r.value,'$.patient') AND c.fingerprint=json_extract(r.value,'$.fingerprint')
    JOIN telegram_links l ON l.organization_id=c.organization_id AND l.patient_id=c.patient_id AND l.chat_hash=c.chat_hash
    LEFT JOIN telegram_jobs j ON j.organization_id=c.organization_id AND j.patient_id=c.patient_id AND j.fingerprint=c.fingerprint
    WHERE c.organization_id=(SELECT org FROM request_scope)`,
  );
  const linksQuery = createBatchQuery(
    db,
    `SELECT l.patient_id,l.value FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN telegram_links l ON l.patient_id=r.value
    WHERE l.organization_id=(SELECT org FROM request_scope)`,
  );
  const settingsQuery = db.prepare('SELECT value FROM telegram_settings WHERE organization_id=?');
  const linkQuery = db.prepare(
    'SELECT value FROM telegram_links WHERE organization_id=? AND patient_id=?',
  );
  const defaults = {
    enabled: true,
    leadMinutes: 1440,
    showServices: true,
    events: ['reminder'],
  };
  // Legacy false without a choice timestamp was the old initial default, not an opt-out.
  const servicesVisible = (value) =>
    value.servicesConsent !== false || !Object.hasOwn(value, 'servicesConsentAt');
  const chatHash = (chatId) => limitKey('telegram-chat', String(chatId));
  const settings = (org) => {
    const row = settingsQuery.get(org);
    const saved = row ? open(row.value) : {};
    return {
      ...defaults,
      ...saved,
      // Sending is determined by ready client bindings, not the retired UI switch.
      // Disaster recovery remains a separate, explicit pause, not a UI preference.
      enabled: saved.restoredPaused !== true,
      events: clientNotificationEvents(saved.events),
      eventVersions: Object.fromEntries(
        ['reminder', 'created', 'moved', 'cancelled'].map((kind) => [
          kind,
          typeof saved.eventVersions?.[kind] === 'string' ? saved.eventVersions[kind] : '',
        ]),
      ),
      timeZone: context.organizationTimeZone(org),
    };
  };
  settings.readRequests = (org) =>
    db.canPrefetchReads && settingsQuery.readRequest
      ? [settingsQuery.readRequest('get', [org])]
      : [];
  function messageIdentity(org, staffId = '') {
    const organization = context.organization(org);
    const owner = !staffId
      ? db
          .prepare(
            "SELECT m.account_id FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.role='owner' AND m.status='active' AND a.status='active'",
          )
          .get(org)
      : null;
    const member = staffId
      ? db
          .prepare(
            "SELECT a.value FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND m.status='active' AND a.status='active'",
          )
          .get(org, staffId)
      : null;
    return {
      organization: {
        name: organization.name,
        ...(owner ? { specialty: context.staffSpecialty(org, owner.account_id) } : {}),
      },
      specialist: member ? open(member.value).displayName : '',
      specialty: member ? context.staffSpecialty(org, staffId) : '',
    };
  }
  function consentToken(org, patient) {
    const current = link(org, patient);
    if (!current) return '';
    if (!current.consentToken) {
      current.consentToken = crypto.randomBytes(20).toString('base64url');
      db.prepare('UPDATE telegram_links SET value=? WHERE organization_id=? AND patient_id=?').run(
        seal(current),
        org,
        patient,
      );
    }
    return current.consentToken;
  }
  function serviceConsent(token, chatId, allow, exists, now = Date.now()) {
    for (const row of db
      .prepare('SELECT organization_id,patient_id,value FROM telegram_links WHERE chat_hash=?')
      .all(chatHash(chatId))) {
      const value = open(row.value);
      if (value.consentToken !== token || !exists(row.organization_id, row.patient_id)) continue;
      const changed = servicesVisible(value) !== allow;
      db.prepare('UPDATE telegram_links SET value=? WHERE organization_id=? AND patient_id=?').run(
        seal({ ...value, servicesConsent: allow, servicesConsentAt: now }),
        row.organization_id,
        row.patient_id,
      );
      if (changed)
        audit('telegram_services_consent', null, row.organization_id, {
          patientId: row.patient_id,
          allowed: allow,
        });
      return { ...row, changed };
    }
    return null;
  }
  function saveSettings(org, actor, values) {
    return transaction(() => {
      const value = settingsRule({
        ...values,
        events: settings(org).events,
        enabled: settings(org).enabled,
        showServices:
          values?.showServices === undefined ? settings(org).showServices : values.showServices,
      });
      context.setOrganizationTimeZone(org, actor, value.timeZone, {
        expectedTimeZone: values.expectedTimeZone,
      });
      const { timeZone, ...notificationSettings } = value;
      notificationSettings.eventVersions = settings(org).eventVersions;
      if (settings(org).restoredPaused) notificationSettings.restoredPaused = true;
      db.prepare('INSERT OR REPLACE INTO telegram_settings VALUES(?,?)').run(
        org,
        seal(notificationSettings),
      );
      interest.update(org, notificationSettings);
      if (notificationSettings.restoredPaused === true)
        require('./pause-pending.cjs').pausePendingNotifications(context, org, true);
      audit('telegram_settings_updated', actor, org, { enabled: value.enabled });
      return value;
    });
  }
  function saveReminderPeriod(org, actor, values) {
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some(
        (key) =>
          ![
            'leadMinutes',
            'expectedLeadMinutes',
            'resumeRestored',
            'events',
            'expectedEvents',
          ].includes(key),
      ) ||
      (values.resumeRestored !== undefined && values.resumeRestored !== true) ||
      Object.hasOwn(values, 'events') !== Object.hasOwn(values, 'expectedEvents')
    )
      throw fail(400, 'Некорректные настройки напоминания.');
    return transaction(() => {
      const member = db
        .prepare(
          "SELECT m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND m.status='active' AND a.status='active'",
        )
        .get(org, actor);
      if (!member || !['owner', 'salon_admin'].includes(member.role))
        throw fail(403, 'Настройки уведомлений доступны владельцу и администратору.');
      const current = settings(org);
      const events =
        values.events === undefined
          ? current.events
          : clientNotificationEvents(values.events, true);
      if (
        values.expectedEvents !== undefined &&
        JSON.stringify(clientNotificationEvents(values.expectedEvents, true)) !==
          JSON.stringify(current.events)
      )
        throw fail(409, 'События уже изменены. Обновите настройки.');
      if (!Number.isSafeInteger(values.expectedLeadMinutes))
        throw fail(400, 'Укажите прежний период напоминания.');
      if (values.expectedLeadMinutes !== current.leadMinutes)
        throw fail(409, 'Период уже изменён. Обновите настройки.');
      const restoredPaused = current.restoredPaused === true && values.resumeRestored !== true;
      const value = settingsRule({
        ...current,
        enabled: !restoredPaused,
        leadMinutes: values.leadMinutes,
        events,
      });
      const { timeZone, ...saved } = value;
      saved.eventVersions = { ...current.eventVersions };
      const resumedAfterRestore = current.restoredPaused === true && !restoredPaused;
      for (const kind of ['reminder', 'created', 'moved', 'cancelled'])
        if (resumedAfterRestore || current.events.includes(kind) !== events.includes(kind))
          saved.eventVersions[kind] = crypto.randomUUID();
      const disabled = current.events.filter((kind) => !events.includes(kind));
      cancelNotificationKinds({ db, seal, open }, org, disabled);
      if (disabled.includes('reminder'))
        db.prepare(
          "UPDATE telegram_jobs SET status='cancelled',lease_until=0 WHERE organization_id=? AND status IN ('pending','sending')",
        ).run(org);
      if (restoredPaused) saved.restoredPaused = true;
      db.prepare('INSERT OR REPLACE INTO telegram_settings VALUES(?,?)').run(org, seal(saved));
      interest.update(org, saved);
      if (restoredPaused)
        require('./pause-pending.cjs').pausePendingNotifications(context, org, true);
      audit('client_reminder_period_updated', actor, org, {
        leadMinutes: value.leadMinutes,
        events,
      });
      if (current.restoredPaused && !restoredPaused)
        audit('client_reminders_resumed_after_restore', actor, org);
      return { ...value, restoredPaused, eventVersions: saved.eventVersions };
    });
  }
  // Legacy storage name retained; visibility is shared by every delivery channel.
  function saveServiceVisibility(org, actor, values) {
    if (
      typeof values.showServices !== 'boolean' ||
      typeof values.expectedShowServices !== 'boolean'
    )
      throw fail(400, 'Укажите показ названий услуг и ожидаемое значение.');
    return transaction(() => {
      const current = settings(org);
      if (current.showServices !== values.expectedShowServices)
        throw fail(409, 'Показ услуг уже изменён. Обновите настройки.');
      const { timeZone, ...saved } = current;
      db.prepare('INSERT OR REPLACE INTO telegram_settings VALUES(?,?)').run(
        org,
        seal({ ...saved, showServices: values.showServices }),
      );
      audit('notification_services_visibility_updated', actor, org, {
        showServices: values.showServices,
      });
      return { showServices: values.showServices };
    });
  }
  function link(org, patient) {
    const row = linkQuery.get(org, patient);
    if (!row) return null;
    const value = open(row.value);
    return { ...value, servicesConsent: servicesVisible(value) };
  }
  function linksMany(org, patients) {
    return new Map(
      linksQuery(org, [...new Set(patients)]).map((row) => {
        const value = open(row.value);
        return [row.patient_id, { ...value, servicesConsent: servicesVisible(value) }];
      }),
    );
  }
  linksMany.readRequests = (org, patients) => linksQuery.readRequests(org, [...new Set(patients)]);
  function issueLink(org, patient, actor, now = Date.now()) {
    if (link(org, patient))
      throw fail(409, 'Telegram уже подключён. Сначала отключите прежнюю привязку.');
    const token = crypto.randomBytes(32).toString('base64url');
    transaction(() => {
      db.prepare(
        'DELETE FROM telegram_link_tokens WHERE (organization_id=? AND patient_id=?) OR expires_at<=?',
      ).run(org, patient, now);
      db.prepare('INSERT INTO telegram_link_tokens VALUES(?,?,?,?,?,NULL)').run(
        tokenHash(token),
        org,
        patient,
        actor,
        now + 86400000,
      );
      audit('telegram_link_issued', actor, org, { patientId: patient });
    });
    return token;
  }
  function consumeLink(token, chatId, exists, now = Date.now()) {
    const row = db
      .prepare('SELECT * FROM telegram_link_tokens WHERE token_hash=?')
      .get(tokenHash(token));
    const actor = row
      ? db
          .prepare(
            "SELECT m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND m.status='active' AND a.status='active'",
          )
          .get(row.organization_id, row.issued_by)
      : null;
    if (
      !row ||
      !actor ||
      row.expires_at <= now ||
      !exists(row.organization_id, row.patient_id, row.issued_by, actor.role)
    )
      throw fail(400, 'Ссылка недействительна или истекла. Попросите новую ссылку у сотрудника.');
    const current = link(row.organization_id, row.patient_id);
    if (current && chatHash(current.chatId) === chatHash(chatId)) return row;
    if (row.used_at || current)
      throw fail(409, 'Ссылка уже использована. Обратитесь к специалисту.');
    const duplicate = db
      .prepare('SELECT 1 FROM telegram_links WHERE organization_id=? AND chat_hash=?')
      .get(row.organization_id, chatHash(chatId));
    if (duplicate)
      throw fail(409, 'Этот Telegram уже связан с другой карточкой в этой организации.');
    transaction(() => {
      db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?)').run(
        row.organization_id,
        row.patient_id,
        chatHash(chatId),
        seal({
          chatId: String(chatId),
          linkedAt: now,
          servicesConsent: true,
          consentToken: crypto.randomBytes(20).toString('base64url'),
        }),
      );
      db.prepare('UPDATE telegram_link_tokens SET used_at=? WHERE token_hash=?').run(
        now,
        row.token_hash,
      );
      interest.touch(row.organization_id);
      audit('telegram_linked', null, row.organization_id, { patientId: row.patient_id });
    });
    return row;
  }
  function unlink(org, patient, actor = null) {
    transaction(() => {
      db.prepare('DELETE FROM telegram_links WHERE organization_id=? AND patient_id=?').run(
        org,
        patient,
      );
      db.prepare('DELETE FROM telegram_link_tokens WHERE organization_id=? AND patient_id=?').run(
        org,
        patient,
      );
      db.prepare(
        "UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=? AND patient_id=? AND status IN ('pending','sending','sent')",
      ).run(org, patient);
      audit('telegram_unlinked', actor, org, { patientId: patient });
    });
  }
  function stopChat(chatId) {
    const rows = db
      .prepare('SELECT organization_id,patient_id FROM telegram_links WHERE chat_hash=?')
      .all(chatHash(chatId));
    for (const row of rows) unlink(row.organization_id, row.patient_id);
  }
  function chatLinks(chatId) {
    return db
      .prepare('SELECT organization_id,patient_id FROM telegram_links WHERE chat_hash=?')
      .all(chatHash(chatId));
  }
  function organizations() {
    return db
      .prepare(
        "SELECT DISTINCT l.organization_id FROM telegram_links l JOIN organizations o ON o.id=l.organization_id WHERE o.status='active'",
      )
      .all()
      .map((r) => r.organization_id);
  }
  let organizationPageQuery;
  function organizationBatch(cursor = '', limit = 25) {
    if (typeof cursor !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error('Invalid notification organization batch.');
    organizationPageQuery ||= db.prepare(
      "SELECT DISTINCT l.organization_id FROM telegram_links l JOIN organizations o ON o.id=l.organization_id WHERE o.status='active' AND l.organization_id>? ORDER BY l.organization_id LIMIT ?",
    );
    return organizationPageQuery.all(cursor, limit).map((row) => row.organization_id);
  }
  function enqueue(org, patient, appointment, stamp, recipient, expiresAt, now = Date.now()) {
    if (
      context.notificationChannels?.enabled?.('telegram') === false ||
      !clientNotificationEvents(settings(org).events).includes('reminder')
    )
      return;
    const prior = db
      .prepare(
        'SELECT id,status,value FROM telegram_jobs WHERE organization_id=? AND patient_id=? AND fingerprint=?',
      )
      .get(org, patient, stamp);
    const services = serviceFingerprint(appointment),
      oldServices = prior ? open(prior.value).serviceFingerprint : null;
    const changed = Boolean(oldServices && oldServices !== services);
    if (prior && prior.status !== 'cancelled' && !changed) return;
    const callback = crypto.randomBytes(20).toString('base64url');
    const value = {
      appointmentId: appointment.id,
      channelVersion: context.notificationChannels?.version?.('telegram') || '',
      date: appointment.date,
      time: appointment.time,
      chatId: recipient.chatId,
      callback,
      serviceFingerprint: services,
    };
    if (prior) {
      // A cancelled job can restart only with a fresh recipient and callback token.
      const restart = () => {
        if (changed)
          db.prepare(
            'DELETE FROM telegram_confirmations WHERE organization_id=? AND patient_id=? AND fingerprint=?',
          ).run(org, patient, stamp);
        db.prepare(
          "UPDATE telegram_jobs SET callback_hash=?,value=?,status='pending',attempts=0,next_at=?,lease_until=0,expires_at=? WHERE id=? AND organization_id=?",
        ).run(tokenHash(callback), seal(value), now, expiresAt, prior.id, org);
      };
      if (db.isTransaction) restart();
      else transaction(restart);
      return;
    }
    db.prepare(
      "INSERT OR IGNORE INTO telegram_jobs(id,organization_id,patient_id,fingerprint,callback_hash,value,status,next_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
    ).run(id(), org, patient, stamp, tokenHash(callback), seal(value), now, expiresAt);
  }
  function claim(now = Date.now()) {
    let row;
    queueTransaction(() => {
      db.prepare(
        "UPDATE telegram_jobs SET status='cancelled' WHERE expires_at<=? AND status IN ('pending','sending')",
      ).run(now);
      row = db
        .prepare(
          "SELECT * FROM telegram_jobs WHERE next_at<=? AND (status='pending' OR (status='sending' AND lease_until<=?)) ORDER BY next_at LIMIT 1",
        )
        .get(now, now);
      if (row)
        db.prepare(
          "UPDATE telegram_jobs SET status='sending',attempts=attempts+1,lease_until=? WHERE id=?",
        ).run(now + 120000, row.id);
    });
    return row
      ? { ...row, lease_until: now + 120000, attempts: row.attempts + 1, decoded: open(row.value) }
      : null;
  }
  let compatibility;
  function claimManaged(now = Date.now()) {
    const ready = db.prepare(
      "SELECT * FROM telegram_jobs WHERE next_at<=? AND expires_at>? AND (status='pending' OR (status='sending' AND lease_until<=?)) ORDER BY next_at LIMIT 1",
    );
    const hint = db
      .prepare(
        "SELECT 1 FROM telegram_jobs WHERE next_at<=? AND (status='pending' OR (status='sending' AND lease_until<=?)) LIMIT 1",
      )
      .get(now, now);
    if (!hint) return null;
    compatibility ||= createQueueCompatibilityMaintenance(context, 'telegram_jobs');
    return queueTransaction(() => {
      compatibility.sweep(now);
      const row = ready.get(now, now, now);
      if (!row) return null;
      const until = now + 120000;
      const changed = db
        .prepare(
          "UPDATE telegram_jobs SET status='sending',attempts=attempts+1,lease_until=? WHERE id=? AND status=? AND attempts=? AND lease_until=? AND callback_hash=? AND expires_at>?",
        )
        .run(
          until,
          row.id,
          row.status,
          row.attempts,
          row.lease_until,
          row.callback_hash,
          now,
        ).changes;
      return changed
        ? { ...row, lease_until: until, attempts: row.attempts + 1, decoded: open(row.value) }
        : null;
    });
  }
  function finish(job, status, nextAt = 0) {
    return queueTransaction(() => {
      return Boolean(
        db
          .prepare(
            "UPDATE telegram_jobs SET status=?,next_at=?,lease_until=0 WHERE id=? AND status='sending' AND attempts=? AND callback_hash=? AND lease_until=?",
          )
          .run(
            status,
            nextAt,
            job.id,
            job.attempts,
            tokenHash(job.decoded.callback),
            job.lease_until,
          ).changes,
      );
    });
  }
  function defer(job, nextAt) {
    return queueTransaction(() => {
      return Boolean(
        db
          .prepare(
            "UPDATE telegram_jobs SET status='pending',next_at=?,lease_until=0,attempts=attempts-1 WHERE id=? AND status='sending' AND attempts=? AND callback_hash=? AND lease_until=?",
          )
          .run(nextAt, job.id, job.attempts, tokenHash(job.decoded.callback), job.lease_until)
          .changes,
      );
    });
  }
  function callback(token) {
    const row = db
      .prepare("SELECT * FROM telegram_jobs WHERE callback_hash=? AND status IN ('sent','sending')")
      .get(tokenHash(token));
    return row ? { ...row, decoded: open(row.value) } : null;
  }
  function confirmed(org, patient, stamp, services) {
    const row = confirmationQuery.get(org, patient, stamp);
    const saved = row?.value ? open(row.value).serviceFingerprint : null;
    if (services && saved && saved !== services) return null;
    return row?.confirmed_at || null;
  }
  function confirmedMany(org, entries) {
    const result = new Map();
    for (const row of confirmationsQuery(org, entries)) {
      const saved = row.value ? open(row.value).serviceFingerprint : null;
      if (row.services && saved && saved !== row.services) continue;
      result.set(pairKey(row.patient_id, row.appointment_id), row.confirmed_at || null);
    }
    return result;
  }
  confirmedMany.readRequests = (org, entries) => confirmationsQuery.readRequests(org, entries);
  function confirm(job, chatId, now = Date.now()) {
    const result = db
      .prepare(
        'INSERT INTO telegram_confirmations VALUES(?,?,?,?,?) ON CONFLICT(organization_id,patient_id,fingerprint) DO UPDATE SET chat_hash=excluded.chat_hash,confirmed_at=excluded.confirmed_at WHERE telegram_confirmations.chat_hash!=excluded.chat_hash',
      )
      .run(job.organization_id, job.patient_id, job.fingerprint, chatHash(chatId), now);
    if (result.changes)
      audit('telegram_appointment_confirmed', null, job.organization_id, {
        patientId: job.patient_id,
        appointmentId: job.decoded.appointmentId,
      });
    return Boolean(result.changes);
  }
  function offset(next) {
    if (next !== undefined)
      db.prepare("INSERT OR REPLACE INTO telegram_runtime VALUES('offset',?)").run(seal(next));
    const row = db.prepare("SELECT value FROM telegram_runtime WHERE key='offset'").get();
    return row ? open(row.value) : 0;
  }
  function counts(org) {
    return Object.fromEntries(
      db
        .prepare(
          'SELECT status,count(*) n FROM telegram_jobs WHERE organization_id=? GROUP BY status',
        )
        .all(org)
        .map((r) => [r.status, r.n]),
    );
  }
  function delivery(org, patient, stamp) {
    return (
      db
        .prepare(
          'SELECT status FROM telegram_jobs WHERE organization_id=? AND patient_id=? AND fingerprint=?',
        )
        .get(org, patient, stamp)?.status || null
    );
  }
  function cancelPending(org, patient, stamp) {
    db.prepare(
      "UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=? AND patient_id=? AND fingerprint=? AND status IN ('pending','sending')",
    ).run(org, patient, stamp);
  }
  const coordination = require('./telegram-coordination.cjs').createTelegramCoordination({
    db,
    seal,
    open,
    transaction,
  });
  return {
    ...coordination,
    prefetchReads: (requests) =>
      db.canPrefetchReads && requests.length > 0 && requests.length <= 32
        ? db.prefetchReads(requests)
        : false,
    settings,
    saveSettings,
    saveServiceVisibility,
    saveReminderPeriod,
    messageIdentity,
    consentToken,
    serviceConsent,
    link,
    linksMany,
    confirmedMany,
    issueLink,
    consumeLink,
    unlink,
    stopChat,
    chatLinks,
    organizations,
    organizationBatch,
    hasReminderRecipients: (org = '') => interest.has(org, ['telegram'], 'reminder'),
    reminderOrganizations: () => interest.organizations(['telegram'], 'reminder'),
    reminderOrganizationBatch: (cursor = '', limit = 25) =>
      interest.batch(cursor, limit, ['telegram'], 'reminder'),
    enqueue,
    claim,
    claimManaged,
    finish,
    defer,
    callback,
    confirmed,
    confirm,
    offset,
    counts,
    delivery,
    cancelPending,
    ...(typeof context.organizationQueueTransaction === 'function'
      ? require('./telegram-org-queue134.cjs').createTelegramOrganizationQueue(context)
      : {}),
  };
}
module.exports = { createTelegramStore };
