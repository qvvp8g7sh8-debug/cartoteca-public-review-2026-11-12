const { fail } = require('../../../shared/errors.cjs');
const { maxId } = require('./max-adapter.cjs');
const { createBatchQuery } = require('./appointment-state-batch.cjs');

function createMaxLinks(c) {
  const { db, seal, open, crypto, tokenHash, limitKey, transaction, audit } = c;
  const linksQuery = createBatchQuery(
    db,
    `SELECT l.patient_id,l.value FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN max_client_links l ON l.patient_id=r.value
    WHERE l.organization_id=(SELECT org FROM request_scope)`,
  );
  const membersQuery = createBatchQuery(
    db,
    `SELECT m.account_id,m.role FROM json_each((SELECT entries FROM request_scope)) r
    CROSS JOIN memberships m ON m.account_id=r.value
    JOIN accounts a ON a.id=m.account_id JOIN organizations o ON o.id=m.organization_id
    WHERE m.organization_id=(SELECT org FROM request_scope)
      AND m.status='active' AND a.status='active' AND o.status='active'`,
  );
  const linkQuery = db.prepare(
    'SELECT value FROM max_client_links WHERE organization_id=? AND patient_id=?',
  );
  const memberQuery = db.prepare(
    "SELECT m.role FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN organizations o ON o.id=m.organization_id WHERE m.organization_id=? AND m.account_id=? AND m.status='active' AND a.status='active' AND o.status='active'",
  );
  const recipientHash = (bot, user) =>
    limitKey('max-client-recipient', JSON.stringify([maxId(bot), maxId(user)]));
  function member(org, actor) {
    return memberQuery.get(org, actor) || null;
  }
  function link(org, patient) {
    const row = linkQuery.get(org, patient);
    return row ? open(row.value) : null;
  }
  function linksMany(org, patients) {
    return new Map(
      linksQuery(org, [...new Set(patients)]).map((row) => [row.patient_id, open(row.value)]),
    );
  }
  function membersMany(org, accounts) {
    return new Map(
      membersQuery(org, [...new Set(accounts)]).map((row) => [row.account_id, { role: row.role }]),
    );
  }
  linksMany.readRequests = (org, patients) => linksQuery.readRequests(org, [...new Set(patients)]);
  membersMany.readRequests = (org, accounts) =>
    membersQuery.readRequests(org, [...new Set(accounts)]);
  function issue(org, patient, actor, botId, authorize, now = Date.now()) {
    const bot = maxId(botId);
    return transaction(() => {
      authorize();
      if (link(org, patient))
        throw fail(409, 'MAX уже подключён. Сначала отключите прежнюю привязку.');
      const token = crypto.randomBytes(32).toString('base64url'),
        expiresAt = now + 86400000;
      db.prepare(
        'DELETE FROM max_client_tokens WHERE (organization_id=? AND patient_id=?) OR expires_at<=?',
      ).run(org, patient, now);
      db.prepare('INSERT INTO max_client_tokens VALUES(?,?,?,?,?,NULL,?)').run(
        tokenHash(token),
        org,
        patient,
        actor,
        expiresAt,
        seal({ botId: bot, bindingId: crypto.randomUUID() }),
      );
      audit('max_client_link_issued', actor, org, { patientId: patient });
      return { token, expiresAt };
    });
  }
  function assertInvitation(org, patient, token, botId, now = Date.now()) {
    const row = db
      .prepare(
        'SELECT * FROM max_client_tokens WHERE token_hash=? AND organization_id=? AND patient_id=?',
      )
      .get(tokenHash(token), org, patient);
    if (
      !row ||
      row.used_at !== null ||
      row.expires_at <= now ||
      open(row.value).botId !== maxId(botId)
    )
      throw fail(409, 'Приглашение MAX изменилось или уже принято. Обновите карточку.');
  }
  function consume(token, botId, userId, authorize, now = Date.now(), eventAt = now) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw fail(400, 'Ссылка MAX недействительна. Попросите новое приглашение.');
    const bot = maxId(botId),
      user = maxId(userId);
    return transaction(() => {
      const row = db
        .prepare('SELECT * FROM max_client_tokens WHERE token_hash=?')
        .get(tokenHash(token));
      if (!row || row.expires_at <= now) throw fail(400, 'Ссылка MAX истекла или отозвана.');
      const issued = open(row.value);
      if (issued.botId !== bot) throw fail(409, 'Ссылка предназначена для другого MAX-бота.');
      const stopped = db
        .prepare('SELECT value FROM max_client_stops WHERE recipient_hash=? AND expires_at>?')
        .get(recipientHash(bot, user), now);
      if (stopped && open(stopped.value).stoppedAt >= eventAt)
        throw fail(409, 'Клиент остановил MAX-бота после этого запуска. Нужен новый запуск.');
      authorize(row.organization_id, row.patient_id, row.issued_by);
      const current = link(row.organization_id, row.patient_id);
      if (row.used_at !== null) {
        if (
          current?.bindingId === issued.bindingId &&
          current.botId === bot &&
          current.userId === user
        )
          return { organizationId: row.organization_id, patientId: row.patient_id, repeated: true };
        throw fail(409, 'Ссылка MAX уже использована.');
      }
      if (
        current ||
        db
          .prepare('SELECT 1 FROM max_client_links WHERE organization_id=? AND recipient_hash=?')
          .get(row.organization_id, recipientHash(bot, user))
      )
        throw fail(409, 'Этот MAX уже связан с карточкой в данной организации.');
      db.prepare('INSERT INTO max_client_links VALUES(?,?,?,?)').run(
        row.organization_id,
        row.patient_id,
        recipientHash(bot, user),
        seal({ botId: bot, userId: user, bindingId: issued.bindingId, linkedAt: now, eventAt }),
      );
      db.prepare(
        'UPDATE max_client_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL',
      ).run(now, row.token_hash);
      require('./client-notification-interest.cjs')
        .createClientNotificationInterest(c)
        .touch(row.organization_id);
      audit('max_client_linked', null, row.organization_id, { patientId: row.patient_id });
      return { organizationId: row.organization_id, patientId: row.patient_id, repeated: false };
    });
  }
  function unlink(org, patient, bindingId, actor, authorize) {
    return transaction(() => {
      authorize();
      const current = link(org, patient);
      if (!current || current.bindingId !== bindingId)
        throw fail(409, 'Привязка MAX изменилась. Обновите карточку.');
      db.prepare('DELETE FROM max_client_links WHERE organization_id=? AND patient_id=?').run(
        org,
        patient,
      );
      db.prepare('DELETE FROM max_client_tokens WHERE organization_id=? AND patient_id=?').run(
        org,
        patient,
      );
      audit('max_client_unlinked', actor, org, { patientId: patient });
    });
  }
  function stop(botId, userId, eventAt = Date.now(), now = Date.now()) {
    return transaction(() => {
      const hash = recipientHash(botId, userId);
      db.prepare('DELETE FROM max_client_stops WHERE expires_at<=?').run(now);
      const prior = db
        .prepare('SELECT value FROM max_client_stops WHERE recipient_hash=?')
        .get(hash);
      const stoppedAt = Math.max(eventAt, prior ? open(prior.value).stoppedAt : 0);
      db.prepare(
        'INSERT INTO max_client_stops VALUES(?,?,?) ON CONFLICT(recipient_hash) DO UPDATE SET expires_at=excluded.expires_at,value=excluded.value',
      ).run(hash, now + 48 * 3600000, seal({ stoppedAt }));
      const rows = db
        .prepare(
          'SELECT organization_id,patient_id,value FROM max_client_links WHERE recipient_hash=?',
        )
        .all(hash);
      let stopped = 0;
      for (const row of rows) {
        const value = open(row.value);
        if (stoppedAt < (value.eventAt || value.linkedAt)) continue;
        db.prepare('DELETE FROM max_client_links WHERE organization_id=? AND patient_id=?').run(
          row.organization_id,
          row.patient_id,
        );
        db.prepare('DELETE FROM max_client_tokens WHERE organization_id=? AND patient_id=?').run(
          row.organization_id,
          row.patient_id,
        );
        audit('max_client_stopped', null, row.organization_id, { patientId: row.patient_id });
        stopped++;
      }
      return stopped;
    });
  }
  return { member, link, linksMany, membersMany, issue, assertInvitation, consume, unlink, stop };
}
module.exports = { createMaxLinks };
