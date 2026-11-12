const {
  STAFF_EVENTS,
  storedEvents,
  validateUpdate,
  cancelEvents,
  eventVersions,
} = require('./staff-event-preferences.cjs');
const { createStaffNotificationInterest } = require('./staff-notification-interest.cjs');
const { clearStaffSelfTests } = require('./staff-queue-work.cjs');
function createStaffLinks(c) {
  const { db, seal, open, transaction, tokenHash, limitKey, crypto, fail } = c;
  const chatHash = (chat) => limitKey('staff-telegram-chat', String(chat));
  const interest = createStaffNotificationInterest(c, 'telegram');
  function member(org, account) {
    return db
      .prepare(
        "SELECT m.role FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=? AND m.status='active' AND a.status='active'",
      )
      .get(org, account);
  }
  function allowed(org) {
    try {
      const plan = c.subscription(org);
      return (
        c.organization(org).status === 'active' &&
        plan.status === 'active' &&
        plan.limits.automaticNotifications
      );
    } catch {
      return false;
    }
  }
  function link(org, account) {
    const row = db
      .prepare('SELECT value FROM staff_telegram_links WHERE organization_id=? AND account_id=?')
      .get(org, account);
    return row ? open(row.value) : null;
  }
  function status(token) {
    const actor = c.onlineBooking.actor(token),
      current = link(actor.organizationId, actor.accountId);
    return {
      linked: Boolean(current),
      enabled: current?.enabled === true,
      events: storedEvents(current),
      bindingId: current?.bindingId || '',
      linkedAt: current?.linkedAt || null,
      available: Boolean(allowed(actor.organizationId)),
    };
  }
  function issue(token, now = Date.now()) {
    return transaction(() => {
      const actor = c.onlineBooking.actor(token),
        org = actor.organizationId;
      if (!allowed(org)) throw fail(403, 'Уведомления недоступны в организации.');
      if (link(org, actor.accountId)) throw fail(409, 'Личный Telegram уже подключён.');
      const secret = crypto.randomBytes(32).toString('base64url'),
        expiresAt = now + 15 * 60000;
      db.prepare(
        'DELETE FROM staff_telegram_tokens WHERE (organization_id=? AND account_id=?) OR expires_at<=?',
      ).run(org, actor.accountId, now);
      db.prepare('INSERT INTO staff_telegram_tokens VALUES(?,?,?,?,?,NULL)').run(
        tokenHash(secret),
        org,
        actor.accountId,
        crypto.randomUUID(),
        expiresAt,
      );
      return { token: secret, expiresAt };
    });
  }
  function consume(secret, chatId, now = Date.now()) {
    if (
      typeof secret !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
      !/^[1-9]\d{0,19}$/.test(String(chatId))
    )
      throw fail(400, 'Ссылка недействительна. Создайте новую в своём аккаунте.');
    return transaction(() => {
      const row = db
        .prepare('SELECT * FROM staff_telegram_tokens WHERE token_hash=?')
        .get(tokenHash(secret));
      if (
        !row ||
        row.expires_at <= now ||
        !member(row.organization_id, row.account_id) ||
        !allowed(row.organization_id)
      )
        throw fail(400, 'Ссылка истекла или доступ отозван. Создайте новую в своём аккаунте.');
      const prior = link(row.organization_id, row.account_id);
      if (row.used_at) {
        if (prior?.bindingId === row.binding_id && prior.chatId === String(chatId)) return row;
        throw fail(409, 'Ссылка уже использована.');
      }
      if (
        prior ||
        db
          .prepare('SELECT 1 FROM staff_telegram_links WHERE organization_id=? AND chat_hash=?')
          .get(row.organization_id, chatHash(chatId))
      )
        throw fail(409, 'Telegram уже связан с сотрудником этой организации.');
      db.prepare('INSERT INTO staff_telegram_links VALUES(?,?,?,?)').run(
        row.organization_id,
        row.account_id,
        chatHash(chatId),
        seal({
          chatId: String(chatId),
          bindingId: row.binding_id,
          linkedAt: now,
          enabled: true,
          events: storedEvents(null),
        }),
      );
      db.prepare('UPDATE staff_telegram_tokens SET used_at=? WHERE token_hash=?').run(
        now,
        row.token_hash,
      );
      interest.update(
        row.organization_id,
        row.account_id,
        link(row.organization_id, row.account_id),
      );
      c.audit('staff_telegram_connected', row.account_id, row.organization_id);
      return row;
    });
  }
  function cancel(org, account) {
    db.prepare(
      "UPDATE staff_notification_jobs SET status='cancelled',lease_id=NULL,lease_until=0 WHERE organization_id=? AND account_id=? AND status IN ('pending','sending')",
    ).run(org, account);
    clearStaffSelfTests(c, 'telegram', org, account);
  }
  function update(token, values, disconnect = false) {
    validateUpdate(values, disconnect);
    return transaction(() => {
      const actor = c.onlineBooking.actor(token),
        org = actor.organizationId,
        current = link(org, actor.accountId);
      if (!current || current.bindingId !== values.bindingId)
        throw fail(409, 'Привязка уже изменилась. Обновите её состояние.');
      const previous = storedEvents(current);
      const next = {
        ...current,
        enabled: values.enabled ?? current.enabled,
        events: values.events ? [...values.events] : previous,
      };
      next.eventVersions = eventVersions(current, next, () => crypto.randomUUID());
      if (!disconnect && next.enabled && !allowed(org)) throw fail(403, 'Уведомления недоступны.');
      if (disconnect) {
        db.prepare('DELETE FROM staff_telegram_links WHERE organization_id=? AND account_id=?').run(
          org,
          actor.accountId,
        );
        db.prepare(
          'DELETE FROM staff_telegram_tokens WHERE organization_id=? AND account_id=?',
        ).run(org, actor.accountId);
      } else
        db.prepare(
          'UPDATE staff_telegram_links SET value=? WHERE organization_id=? AND account_id=?',
        ).run(seal(next), org, actor.accountId);
      if (disconnect) cancel(org, actor.accountId);
      else if (!next.enabled)
        cancelEvents(c, 'staff_notification_jobs', org, actor.accountId, STAFF_EVENTS);
      else
        cancelEvents(
          c,
          'staff_notification_jobs',
          org,
          actor.accountId,
          previous.filter((event) => !next.events.includes(event)),
        );
      interest.update(org, actor.accountId, disconnect ? null : next);
      c.audit(
        disconnect ? 'staff_telegram_disconnected' : 'staff_telegram_settings',
        actor.accountId,
        org,
        disconnect ? {} : { enabled: next.enabled, events: next.events },
      );
      return status(token);
    });
  }
  function stopChat(chat) {
    transaction(() => {
      const rows = db
        .prepare('SELECT organization_id,account_id FROM staff_telegram_links WHERE chat_hash=?')
        .all(chatHash(chat));
      for (const r of rows) {
        cancel(r.organization_id, r.account_id);
        db.prepare(
          'DELETE FROM staff_telegram_tokens WHERE organization_id=? AND account_id=?',
        ).run(r.organization_id, r.account_id);
        db.prepare('DELETE FROM staff_telegram_links WHERE organization_id=? AND account_id=?').run(
          r.organization_id,
          r.account_id,
        );
        interest.update(r.organization_id, r.account_id, null);
      }
    });
  }
  return { member, allowed, link, status, issue, consume, update, stopChat, interest };
}
module.exports = { createStaffLinks };
