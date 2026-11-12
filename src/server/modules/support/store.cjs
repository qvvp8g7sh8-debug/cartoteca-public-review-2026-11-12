function createSupportStore(context) {
  const { db, seal, open, id, transaction, audit, fail } = context;
  const listing = require('./improvements.cjs').createImprovementListing(context);
  function validate(body) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (k) => !['requestId', 'description', 'diagnostics', 'kind'].includes(k),
      ) ||
      (body.kind !== undefined && !['support', 'improvement'].includes(body.kind))
    )
      throw fail(400, 'Неверный формат обращения.');
    if (
      typeof body.requestId !== 'string' ||
      !/^[-a-f0-9]{36}$/i.test(body.requestId) ||
      typeof body.description !== 'string' ||
      !body.description.trim() ||
      body.description.trim().length > 1500
    )
      throw fail(400, 'Напишите сообщение длиной до 1500 символов.');
    const description = body.description
      .trim()
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    let diagnostics = null;
    if (body.diagnostics !== undefined && body.diagnostics !== null) {
      const d = body.diagnostics;
      if (
        typeof d !== 'object' ||
        Array.isArray(d) ||
        Object.keys(d).some((k) => !['version', 'view', 'width', 'height', 'online'].includes(k)) ||
        !/^([a-f0-9]{16})?$/.test(d.version) ||
        !['clients', 'card', 'calendar', 'services', 'settings'].includes(d.view) ||
        !Number.isInteger(d.width) ||
        d.width < 1 ||
        d.width > 20000 ||
        !Number.isInteger(d.height) ||
        d.height < 1 ||
        d.height > 20000 ||
        typeof d.online !== 'boolean'
      )
        throw fail(400, 'Неверный формат технических сведений.');
      diagnostics = {
        version: d.version,
        view: d.view,
        width: d.width,
        height: d.height,
        online: d.online,
      };
    }
    if (!description.trim()) throw fail(400, 'Напишите сообщение длиной до 1500 символов.');
    return { description, diagnostics, kind: body.kind || 'support' };
  }
  function receipt(accountId, requestId) {
    const row = db
      .prepare('SELECT id,created_at,value FROM support_requests WHERE id=? AND account_id=?')
      .get(requestId, accountId);
    if (!row) throw fail(404, 'Обращение не найдено.');
    const value = open(row.value);
    return {
      id: row.id,
      createdAt: row.created_at,
      replyEmail: value.email,
      ...(value.kind === 'improvement'
        ? {
            kind: 'improvement',
            description: value.description,
            improvementState: value.improvementState || 'received',
          }
        : {}),
      state:
        db.prepare('SELECT state FROM support_cases WHERE request_id=?').get(row.id)?.state ||
        'new',
      messages: db
        .prepare(
          "SELECT kind,created_at,value FROM support_messages WHERE request_id=? AND kind!='internal' ORDER BY created_at DESC,id DESC LIMIT 20",
        )
        .all(row.id)
        .reverse()
        .map((message) => ({
          kind: message.kind,
          createdAt: message.created_at,
          text: open(message.value).text,
        })),
      deliveries: Object.fromEntries(
        db
          .prepare('SELECT channel,status FROM support_deliveries WHERE request_id=?')
          .all(row.id)
          .map((r) => [r.channel, r.status]),
      ),
    };
  }
  function create(
    current,
    body,
    now = Date.now(),
    { emailEnabled = false, deliveryEnabled = true } = {},
  ) {
    const content = validate(body);
    return transaction(() => {
      const account = db
        .prepare("SELECT value FROM accounts WHERE id=? AND status='active'")
        .get(current.accountId);
      if (!account) throw fail(401, 'Войдите в картотеку.');
      const previous = db
        .prepare(
          'SELECT id,value,organization_id FROM support_requests WHERE account_id=? AND request_key=?',
        )
        .get(current.accountId, body.requestId);
      if (previous) {
        const saved = open(previous.value);
        if (
          saved.description !== content.description ||
          JSON.stringify(saved.diagnostics) !== JSON.stringify(content.diagnostics) ||
          (saved.kind || 'support') !== content.kind ||
          (content.kind === 'improvement' &&
            previous.organization_id !== (current.organizationId || null))
        )
          throw fail(409, 'Это обращение уже принято с другим текстом.');
        return receipt(current.accountId, previous.id);
      }
      db.prepare(
        "DELETE FROM support_requests WHERE id IN (SELECT request_id FROM support_cases WHERE state='resolved' AND resolved_at<? ORDER BY resolved_at LIMIT 200)",
      ).run(now - 90 * 86400000);
      const recent = db
        .prepare('SELECT count(*) n FROM support_requests WHERE account_id=? AND created_at>?')
        .get(current.accountId, now - 10 * 60000).n;
      const daily = db
        .prepare('SELECT count(*) n FROM support_requests WHERE account_id=? AND created_at>?')
        .get(current.accountId, now - 86400000).n;
      const total = db
        .prepare('SELECT count(*) n FROM support_requests WHERE created_at>?')
        .get(now - 3600000).n;
      if (recent >= 3 || daily >= 20 || total >= 500)
        throw fail(429, 'Слишком много обращений. Попробуйте позже.');
      const value = open(account.value),
        org = current.organizationId
          ? db.prepare('SELECT value FROM organizations WHERE id=?').get(current.organizationId)
          : null;
      const requestId = id(),
        payload = {
          ...content,
          ...(content.kind === 'improvement' ? { improvementState: 'received' } : {}),
          email: value.email,
          displayName: value.displayName,
          organization: org ? open(org.value).name || '' : '',
        };
      db.prepare('INSERT INTO support_requests VALUES(?,?,?,?,?,?)').run(
        requestId,
        current.accountId,
        current.organizationId || null,
        body.requestId,
        now,
        seal(payload),
      );
      db.prepare('INSERT INTO support_cases(request_id,changed_at) VALUES(?,?)').run(
        requestId,
        now,
      );
      for (const channel of deliveryEnabled ? ['telegram', ...(emailEnabled ? ['email'] : [])] : [])
        db.prepare(
          'INSERT INTO support_deliveries(request_id,channel,status,next_at) VALUES(?,?,?,?)',
        ).run(requestId, channel, 'pending', now);
      audit('support_request_created', current.accountId, current.organizationId, { requestId });
      return receipt(current.accountId, requestId);
    });
  }
  function claim(channel, now = Date.now()) {
    return transaction(() => {
      const row = db
        .prepare(
          "SELECT * FROM support_deliveries WHERE channel=? AND ((status IN ('pending','waiting') AND next_at<=?) OR (status='sending' AND lease_until<=?)) ORDER BY next_at LIMIT 1",
        )
        .get(channel, now, now);
      if (!row) return null;
      if (row.attempts >= 5) {
        db.prepare(
          "UPDATE support_deliveries SET status='failed',lease_id=NULL,lease_until=0 WHERE request_id=? AND channel=?",
        ).run(row.request_id, channel);
        return null;
      }
      const lease = id();
      db.prepare(
        "UPDATE support_deliveries SET status='sending',attempts=attempts+1,lease_until=?,lease_id=? WHERE request_id=? AND channel=?",
      ).run(now + 120000, lease, row.request_id, channel);
      const ticket = db
        .prepare('SELECT created_at,value FROM support_requests WHERE id=?')
        .get(row.request_id);
      return {
        ...row,
        attempts: row.attempts + 1,
        lease,
        payload: open(ticket.value),
        createdAt: ticket.created_at,
      };
    });
  }
  function finish(job, status, nextAt = Date.now()) {
    return (
      db
        .prepare(
          "UPDATE support_deliveries SET status=?,next_at=?,lease_until=0,lease_id=NULL WHERE request_id=? AND channel=? AND lease_id=? AND status='sending'",
        )
        .run(status, nextAt, job.request_id, job.channel, job.lease).changes === 1
    );
  }
  return { create, receipt, claim, finish, ...listing };
}
module.exports = { createSupportStore };
