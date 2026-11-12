function createWalletEvidence(ledger) {
  const { db, ready, identifier, transaction, open, seal, assertAdmin, fail } = ledger;
  function taskEvidence(input) {
    if (input === undefined) return {};
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !['id', 'requestId', 'grantId', 'attempt', 'sessionHash'].includes(key),
      )
    )
      throw fail(400, 'Некорректная связь расхода с задачей.');
    const task = {};
    for (const key of ['id', 'requestId', 'grantId', 'sessionHash']) {
      if (input[key] === undefined) continue;
      identifier(input[key], 'связь задачи');
      task[key] = input[key];
    }
    if (!task.requestId || !/^[a-f0-9]{64}$/u.test(task.sessionHash || ''))
      throw fail(400, 'Нужен отпечаток контекста задачи.');
    if (input.attempt !== undefined) {
      if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
        throw fail(400, 'Некорректная попытка задачи.');
      task.attempt = input.attempt;
    }
    return { task };
  }
  function markOutbound(reservationId) {
    ready();
    identifier(reservationId, 'денежный резерв');
    return transaction(() => {
      const row = db
        .prepare('SELECT state,value FROM billing_reservations WHERE id=?')
        .get(reservationId);
      if (!row) throw fail(404, 'Денежный резерв не найден.');
      const detail = open(row.value);
      if (detail.outboundAt) return { outboundAt: detail.outboundAt, replayed: true };
      if (row.state !== 'pending')
        throw fail(409, 'Расход уже завершён. Повторная отправка запрещена.');
      const outboundAt = Date.now();
      db.prepare("UPDATE billing_reservations SET value=? WHERE id=? AND state='pending'").run(
        seal({ ...detail, outboundAt }),
        reservationId,
      );
      return { outboundAt };
    });
  }
  function reservationReview(actorId, { organizationId, offset = 0, limit = 50 } = {}) {
    ready();
    assertAdmin(actorId);
    if (organizationId !== undefined) identifier(organizationId, 'кабинет');
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw fail(400, 'Некорректная страница сверки расходов.');
    const filter = organizationId === undefined ? '' : ' AND organization_id=?';
    const rows = db
      .prepare(
        `SELECT * FROM billing_reservations
      WHERE (state='pending' OR uncertain=1)${filter} ORDER BY created_at,id LIMIT ? OFFSET ?`,
      )
      .all(...(organizationId === undefined ? [] : [organizationId]), limit, offset);
    return rows.map((row) => {
      const detail = open(row.value);
      return {
        id: row.id,
        organizationId: row.organization_id,
        accountId: row.account_id,
        service: row.service,
        kind: row.kind,
        provider: row.provider,
        state: row.state,
        quoteMicrorub: row.provider_quote_microrub,
        actualMicrorub: row.provider_actual_microrub,
        createdAt: row.created_at,
        settledAt: row.settled_at,
        uncertain: Boolean(row.uncertain),
        estimated: Boolean(row.estimated),
        outboundAt: detail.outboundAt || null,
        task: detail.task || null,
        requiresReview: true,
      };
    });
  }
  return { taskEvidence, markOutbound, reservationReview };
}
module.exports = { createWalletEvidence };
