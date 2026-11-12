const { maxId } = require('./max-adapter.cjs');
const { staffRecipientPolicy } = require('./staff-recipient-policy.cjs');
const {
  STAFF_EVENTS,
  storedEvents,
  validateUpdate,
  cancelEvents,
  eventVersions,
} = require('./staff-event-preferences.cjs');
const { createStaffNotificationInterest } = require('./staff-notification-interest.cjs');
const { clearStaffSelfTests } = require('./staff-queue-work.cjs');
function createStaffMaxLinks(c) {
  const { db, seal, open, transaction, tokenHash, limitKey, crypto, fail } = c;
  const policy = staffRecipientPolicy(c);
  const recipient = (bot, user) => maxId(bot) + ':' + maxId(user);
  const chatHash = (chat) => limitKey('staff-max-chat', chat);
  const interest = createStaffNotificationInterest(c, 'max');
  function link(org, account) {
    const row = db
      .prepare('SELECT value FROM staff_max_links WHERE organization_id=? AND account_id=?')
      .get(org, account);
    return row ? open(row.value) : null;
  }
  function status(token, botId = '') {
    const actor = c.onlineBooking.actor(token),
      current = link(actor.organizationId, actor.accountId);
    const compatible = Boolean(current && botId && current.botId === maxId(botId));
    return {
      linked: Boolean(current),
      compatible,
      enabled: compatible && current.enabled === true,
      events: storedEvents(current),
      bindingId: current?.bindingId || '',
      linkedAt: current?.linkedAt || null,
      available: Boolean(policy.allowed(actor.organizationId)),
    };
  }
  function issue(token, botId, now = Date.now()) {
    botId = maxId(botId);
    return transaction(() => {
      const actor = c.onlineBooking.actor(token),
        org = actor.organizationId;
      if (!policy.allowed(org)) throw fail(403, 'Уведомления недоступны в организации.');
      if (link(org, actor.accountId)) throw fail(409, 'Личный MAX уже подключён.');
      const secret = crypto.randomBytes(32).toString('base64url'),
        expiresAt = now + 15 * 60000;
      db.prepare(
        'DELETE FROM staff_max_tokens WHERE (organization_id=? AND account_id=?) OR expires_at<=?',
      ).run(org, actor.accountId, now);
      db.prepare('INSERT INTO staff_max_tokens VALUES(?,?,?,?,?,?,NULL,?)').run(
        tokenHash(secret),
        org,
        actor.accountId,
        crypto.randomUUID(),
        now,
        expiresAt,
        seal({ botId }),
      );
      return { token: secret, expiresAt };
    });
  }
  function consume(secret, botId, userId, eventAt, now = Date.now()) {
    if (
      typeof secret !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
      !Number.isSafeInteger(eventAt) ||
      eventAt <= 0 ||
      eventAt > now + 300000
    )
      throw fail(400, 'Ссылка недействительна. Создайте новую в своём аккаунте.');
    botId = maxId(botId);
    userId = maxId(userId);
    const chatId = recipient(botId, userId);
    return transaction(() => {
      const row = db
        .prepare('SELECT * FROM staff_max_tokens WHERE token_hash=?')
        .get(tokenHash(secret));
      const stop = db
        .prepare('SELECT value FROM staff_max_stops WHERE chat_hash=? AND expires_at>?')
        .get(chatHash(chatId), now);
      if (
        !row ||
        row.expires_at <= now ||
        row.issued_at > eventAt ||
        open(row.value).botId !== botId ||
        (stop && open(stop.value).stoppedAt >= eventAt) ||
        !policy.member(row.organization_id, row.account_id) ||
        !policy.allowed(row.organization_id)
      )
        throw fail(400, 'Ссылка истекла или доступ отозван. Создайте новую в своём аккаунте.');
      const prior = link(row.organization_id, row.account_id);
      if (row.used_at) {
        if (prior?.bindingId === row.binding_id && prior.chatId === chatId)
          return { linked: true, repeated: true };
        throw fail(409, 'Ссылка уже использована.');
      }
      if (
        prior ||
        db
          .prepare('SELECT 1 FROM staff_max_links WHERE organization_id=? AND chat_hash=?')
          .get(row.organization_id, chatHash(chatId))
      )
        throw fail(409, 'MAX уже связан с сотрудником этой организации.');
      db.prepare('INSERT INTO staff_max_links VALUES(?,?,?,?)').run(
        row.organization_id,
        row.account_id,
        chatHash(chatId),
        seal({
          botId,
          userId,
          chatId,
          bindingId: row.binding_id,
          linkedAt: now,
          eventAt,
          enabled: true,
          events: storedEvents(null),
        }),
      );
      db.prepare('UPDATE staff_max_tokens SET used_at=? WHERE token_hash=?').run(
        now,
        row.token_hash,
      );
      interest.update(
        row.organization_id,
        row.account_id,
        link(row.organization_id, row.account_id),
      );
      c.audit('staff_max_connected', row.account_id, row.organization_id);
      return { linked: true, repeated: false };
    });
  }
  function cancel(org, account) {
    db.prepare(
      "UPDATE staff_max_jobs SET status='cancelled',lease_id=NULL,lease_until=0 WHERE organization_id=? AND account_id=? AND status IN ('pending','sending')",
    ).run(org, account);
    clearStaffSelfTests(c, 'max', org, account);
  }
  function update(token, values, disconnect = false, botId = '') {
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
      if (
        !disconnect &&
        next.enabled &&
        (!policy.allowed(org) || !botId || current.botId !== maxId(botId))
      )
        throw fail(403, 'Уведомления MAX недоступны. Переподключите свой аккаунт.');
      if (disconnect) {
        db.prepare('DELETE FROM staff_max_links WHERE organization_id=? AND account_id=?').run(
          org,
          actor.accountId,
        );
        db.prepare('DELETE FROM staff_max_tokens WHERE organization_id=? AND account_id=?').run(
          org,
          actor.accountId,
        );
      } else
        db.prepare(
          'UPDATE staff_max_links SET value=? WHERE organization_id=? AND account_id=?',
        ).run(seal(next), org, actor.accountId);
      if (disconnect) cancel(org, actor.accountId);
      else if (!next.enabled) cancelEvents(c, 'staff_max_jobs', org, actor.accountId, STAFF_EVENTS);
      else
        cancelEvents(
          c,
          'staff_max_jobs',
          org,
          actor.accountId,
          previous.filter((event) => !next.events.includes(event)),
        );
      interest.update(org, actor.accountId, disconnect ? null : next);
      c.audit(
        disconnect ? 'staff_max_disconnected' : 'staff_max_settings',
        actor.accountId,
        org,
        disconnect ? {} : { enabled: next.enabled, events: next.events },
      );
      return status(token, botId);
    });
  }
  function stopped(botId, userId, eventAt, now = Date.now()) {
    const chatId = recipient(botId, userId),
      hash = chatHash(chatId);
    if (!Number.isSafeInteger(eventAt) || eventAt <= 0 || eventAt > now + 300000)
      throw fail(400, 'Некорректное время остановки MAX.');
    return transaction(() => {
      db.prepare('DELETE FROM staff_max_stops WHERE expires_at<=?').run(now);
      const prior = db.prepare('SELECT value FROM staff_max_stops WHERE chat_hash=?').get(hash);
      if (!prior && db.prepare('SELECT count(*) n FROM staff_max_stops').get().n >= 20000)
        throw fail(429, 'Приём событий MAX временно занят. Повторите позже.');
      const stoppedAt = Math.max(eventAt, prior ? open(prior.value).stoppedAt : 0);
      db.prepare('INSERT OR REPLACE INTO staff_max_stops VALUES(?,?,?)').run(
        hash,
        now + 3 * 86400000,
        seal({ stoppedAt }),
      );
      let count = 0;
      for (const row of db
        .prepare('SELECT organization_id,account_id,value FROM staff_max_links WHERE chat_hash=?')
        .all(hash)) {
        if (open(row.value).eventAt > stoppedAt) continue;
        cancel(row.organization_id, row.account_id);
        db.prepare('DELETE FROM staff_max_tokens WHERE organization_id=? AND account_id=?').run(
          row.organization_id,
          row.account_id,
        );
        db.prepare('DELETE FROM staff_max_links WHERE organization_id=? AND account_id=?').run(
          row.organization_id,
          row.account_id,
        );
        interest.update(row.organization_id, row.account_id, null);
        c.audit('staff_max_stopped', row.account_id, row.organization_id);
        count++;
      }
      return count;
    });
  }
  return { ...policy, link, status, issue, consume, update, stopped, interest };
}
module.exports = { createStaffMaxLinks };
