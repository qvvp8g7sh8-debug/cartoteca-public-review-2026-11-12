function createSupportCases(context, policy, commands, emailQueue) {
  const { db, open, seal, id, fail, transaction } = context;
  const conversation = require('./conversation.cjs').createSupportConversation(
    context,
    policy,
    emailQueue,
  );
  const states = ['new', 'in_progress', 'waiting', 'resolved'];
  const improvementStates = require('../../../shared/improvement-status.cjs').improvementStatuses();
  function page(actorId, input = {}) {
    policy.assert(actorId, 'support.read');
    const clauses = ['1=1'],
      parameters = [];
    if (input.state === 'open') clauses.push("c.state!='resolved'");
    else if (input.state) {
      if (!states.includes(input.state)) throw fail(400, 'Неверный статус обращения.');
      clauses.push('c.state=?');
      parameters.push(input.state);
    }
    for (const [field, column] of [
      ['organizationId', 'r.organization_id'],
      ['accountId', 'r.account_id'],
    ])
      if (input[field]) {
        clauses.push(column + '=?');
        parameters.push(input[field]);
      }
    const total = db
      .prepare(
        'SELECT count(*) n FROM support_requests r JOIN support_cases c ON c.request_id=r.id WHERE ' +
          clauses.join(' AND '),
      )
      .get(...parameters).n;
    if (input.before) {
      const before = Number(input.before);
      if (!Number.isSafeInteger(before) || before < 1)
        throw fail(400, 'Неверная страница обращений.');
      clauses.push('(c.changed_at<? OR (c.changed_at=? AND r.id<?))');
      parameters.push(before, before, String(input.beforeId || ''));
    }
    const rows = db
      .prepare(
        'SELECT r.*,c.state,c.assigned_to,c.changed_at FROM support_requests r JOIN support_cases c ON c.request_id=r.id WHERE ' +
          clauses.join(' AND ') +
          ' ORDER BY c.changed_at DESC,r.id DESC LIMIT 21',
      )
      .all(...parameters);
    const items = rows.slice(0, 20).map((row) => {
      const value = open(row.value);
      return {
        id: row.id,
        accountId: row.account_id,
        organizationId: row.organization_id,
        createdAt: row.created_at,
        changedAt: row.changed_at,
        state: row.state,
        assignedTo: row.assigned_to,
        displayName: value.displayName,
        organizationName: value.organization,
        excerpt: value.description.slice(0, 160),
        ...(value.kind === 'improvement'
          ? { kind: value.kind, improvementState: value.improvementState || 'received' }
          : {}),
      };
    });
    return {
      items,
      total,
      next: rows.length > 20 ? { before: rows[19].changed_at, beforeId: rows[19].id } : null,
    };
  }
  function detail(actorId, requestId) {
    policy.assert(actorId, 'support.read');
    const row = db
      .prepare(
        'SELECT r.*,c.state,c.assigned_to,c.changed_at FROM support_requests r JOIN support_cases c ON c.request_id=r.id WHERE r.id=?',
      )
      .get(requestId);
    if (!row) throw fail(404, 'Обращение не найдено.');
    const value = open(row.value);
    const messages = conversation.page(actorId, requestId);
    return {
      id: row.id,
      accountId: row.account_id,
      organizationId: row.organization_id,
      createdAt: row.created_at,
      state: row.state,
      assignedTo: row.assigned_to,
      changedAt: row.changed_at,
      revision: commands.revision('support', requestId),
      ...value,
      deliveries: db
        .prepare('SELECT channel,status,attempts FROM support_deliveries WHERE request_id=?')
        .all(requestId),
      messages: messages.items,
      messagesNext: messages.next,
    };
  }
  function update(actorId, requestId, input) {
    return commands.execute(actorId, 'support.manage', 'support', requestId, input, () => {
      const row = db.prepare('SELECT * FROM support_cases WHERE request_id=?').get(requestId);
      if (!row) throw fail(404, 'Обращение не найдено.');
      if (
        !states.includes(input.state) ||
        (input.claim !== undefined && typeof input.claim !== 'boolean')
      )
        throw fail(400, 'Проверьте состояние обращения.');
      const assignedTo = input.claim === true ? actorId : row.assigned_to;
      const now = Date.now();
      const request = db.prepare('SELECT value FROM support_requests WHERE id=?').get(requestId);
      const value = open(request.value);
      if (input.improvementState !== undefined) {
        if (
          value.kind !== 'improvement' ||
          !Object.hasOwn(improvementStates, input.improvementState)
        )
          throw fail(400, 'Проверьте состояние предложения.');
        value.improvementState = input.improvementState;
        db.prepare('UPDATE support_requests SET value=? WHERE id=?').run(seal(value), requestId);
      }
      // Processing state and author-facing product decision are separate contracts.
      const caseState =
        input.improvementState === undefined
          ? input.state
          : ['done', 'declined'].includes(input.improvementState)
            ? 'resolved'
            : input.improvementState === 'received'
              ? 'new'
              : 'in_progress';
      db.prepare(
        'UPDATE support_cases SET state=?,assigned_to=?,changed_at=?,resolved_at=?,revision=revision+1 WHERE request_id=?',
      ).run(caseState, assignedTo, now, caseState === 'resolved' ? now : null, requestId);
      return {
        event: 'support_case_updated',
        detail: {
          before: { state: row.state },
          after: {
            state: caseState,
            assignedTo,
            ...(input.improvementState !== undefined
              ? { improvementState: input.improvementState }
              : {}),
          },
          organizationId: db
            .prepare('SELECT organization_id FROM support_requests WHERE id=?')
            .get(requestId).organization_id,
        },
      };
    });
  }
  function message(actorId, requestId, input) {
    if (
      !['internal', 'reply'].includes(input.kind) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.trim().length > 1500
    )
      throw fail(400, 'Напишите текст длиной до 1500 символов.');
    const text = input.text.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (!text.trim()) throw fail(400, 'Напишите текст сообщения.');
    return commands.execute(actorId, 'support.manage', 'support', requestId, input, () => {
      const row = db
        .prepare('SELECT account_id,organization_id FROM support_requests WHERE id=?')
        .get(requestId);
      if (!row) throw fail(404, 'Обращение не найдено.');
      const messageId = id(),
        now = Date.now();
      db.prepare('INSERT INTO support_messages VALUES(?,?,?,?,?,?)').run(
        messageId,
        requestId,
        actorId,
        input.kind,
        now,
        seal({ text }),
      );
      db.prepare(
        'UPDATE support_cases SET changed_at=?,revision=revision+1 WHERE request_id=?',
      ).run(now, requestId);
      if (input.kind === 'reply') {
        const account = db.prepare('SELECT value FROM accounts WHERE id=?').get(row.account_id);
        emailQueue.enqueue(messageId, 'support-reply', {
          actorId,
          accountId: row.account_id,
          email: open(account.value).email,
          requestId,
          message: text,
        });
      }
      return {
        event: input.kind === 'internal' ? 'support_internal_note_added' : 'support_reply_queued',
        detail: { after: { messageId, kind: input.kind }, organizationId: row.organization_id },
        result: { messageId, queued: input.kind === 'reply' },
      };
    });
  }
  function authorReply(accountId, requestId, body) {
    if (
      !body ||
      typeof body.text !== 'string' ||
      !body.text.trim() ||
      body.text.trim().length > 1500 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        body.requestId || '',
      ) ||
      Object.keys(body).some((key) => !['caseId', 'requestId', 'text'].includes(key))
    )
      throw fail(400, 'Неверный формат ответа.');
    const text = body.text.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (!text.trim()) throw fail(400, 'Напишите текст сообщения.');
    return transaction(() => {
      const row = db
        .prepare('SELECT id FROM support_requests WHERE id=? AND account_id=?')
        .get(requestId, accountId);
      if (!row) throw fail(404, 'Обращение не найдено.');
      const existing = db
        .prepare('SELECT request_id,actor_id,value FROM support_messages WHERE id=?')
        .get(body.requestId);
      if (existing) {
        if (
          existing.request_id !== requestId ||
          existing.actor_id !== accountId ||
          open(existing.value).text !== text
        )
          throw fail(409, 'Этот ответ уже принят с другим текстом.');
        return { ok: true };
      }
      if (
        db
          .prepare(
            "SELECT count(*) n FROM support_messages WHERE actor_id=? AND kind='author' AND created_at>?",
          )
          .get(accountId, Date.now() - 600000).n >= 10
      )
        throw fail(429, 'Слишком много ответов. Попробуйте позже.');
      const account = db
        .prepare("SELECT id FROM accounts WHERE id=? AND status='active'")
        .get(accountId);
      if (!account) throw fail(401, 'Войдите в картотеку.');
      db.prepare('INSERT INTO support_messages VALUES(?,?,?,?,?,?)').run(
        body.requestId,
        requestId,
        accountId,
        'author',
        Date.now(),
        seal({ text }),
      );
      db.prepare(
        "UPDATE support_cases SET state='new',resolved_at=NULL,changed_at=?,revision=revision+1 WHERE request_id=?",
      ).run(Date.now(), requestId);
      commands.touch('support', requestId);
      context.audit('support_author_replied', accountId, null, { requestId });
      return { ok: true };
    });
  }
  return { page, detail, update, message, authorReply, conversation: conversation.page };
}
module.exports = { createSupportCases };
