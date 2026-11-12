function createSupportConversation({ db, open, fail }, policy, emailQueue) {
  function page(actorId, requestId, input = {}, author = false) {
    if (!author) policy.assert(actorId, 'support.read');
    const exists = author
      ? db
          .prepare('SELECT id FROM support_requests WHERE id=? AND account_id=?')
          .get(requestId, actorId)
      : db.prepare('SELECT id FROM support_requests WHERE id=?').get(requestId);
    if (!exists) throw fail(404, 'Обращение не найдено.');
    const clauses = ['request_id=?'],
      parameters = [requestId];
    if (author) clauses.push("kind!='internal'");
    if (input.before) {
      const time = Number(input.before);
      if (!Number.isSafeInteger(time) || time < 1 || typeof input.beforeId !== 'string')
        throw fail(400, 'Неверная страница переписки.');
      clauses.push('(created_at<? OR (created_at=? AND id<?))');
      parameters.push(time, time, input.beforeId);
    }
    const rows = db
      .prepare(
        'SELECT * FROM support_messages WHERE ' +
          clauses.join(' AND ') +
          ' ORDER BY created_at DESC,id DESC LIMIT 51',
      )
      .all(...parameters);
    const items = rows
      .slice(0, 50)
      .reverse()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        text: open(row.value).text,
        ...(!author ? { actorId: row.actor_id, deliveries: emailQueue.statuses(row.id) } : {}),
      }));
    return {
      items,
      next: rows.length > 50 ? { before: rows[49].created_at, beforeId: rows[49].id } : null,
    };
  }
  return { page };
}
module.exports = { createSupportConversation };
