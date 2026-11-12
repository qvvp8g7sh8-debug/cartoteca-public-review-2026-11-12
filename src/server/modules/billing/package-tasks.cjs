function createPackageTasks(core, grants, services) {
  const { db, ready, transaction, identifier, member, hash, now, id, fail } = core;
  const tagged = (code, message) => Object.assign(fail(409, message), { code });
  function ticketView(row, current) {
    return {
      id: row.id,
      organizationId: row.organization_id,
      accountId: row.account_id,
      sessionId: current.sessionId,
      requestId: row.request_id,
      grantId: row.grant_id,
      state: row.state,
      attempt: row.attempt,
    };
  }
  function reserveTask(input) {
    ready();
    if (!input || typeof input !== 'object') throw fail(400, 'Нужна новая задача помощника.');
    identifier(input.requestId, 'номер задачи');
    const service = require('./service-catalog.cjs').serviceCode(input.serviceCode);
    if (typeof input.payloadHash !== 'string' || !/^[a-f0-9]{64}$/i.test(input.payloadHash))
      throw fail(400, 'Нужен отпечаток новой задачи.');
    if (input.dialogueId !== undefined) identifier(input.dialogueId, 'диалог');
    return transaction(() => {
      member(input.current);
      const current = input.current,
        sessionHash = hash(current.sessionId);
      const prior = db
        .prepare(
          'SELECT * FROM billing_package_tasks WHERE organization_id=? AND account_id=? AND session_hash=? AND request_id=?',
        )
        .get(current.organizationId, current.accountId, sessionHash, input.requestId);
      if (prior) {
        const priorGrant = db
          .prepare('SELECT * FROM billing_package_grants WHERE id=?')
          .get(prior.grant_id);
        if ((priorGrant?.service_code || 'voice-assistant') !== service)
          throw tagged('TASK_KEY_CONFLICT', 'Номер операции уже использован для другой услуги.');
        if (prior.payload_hash !== input.payloadHash)
          throw tagged('TASK_KEY_CONFLICT', 'Номер задачи уже использован для другой команды.');
        if (prior.state === 'accepted' || prior.state === 'uncertain')
          throw tagged('TASK_ALREADY_COUNTED', 'Эта задача уже учтена. Продолжите текущий диалог.');
        if (prior.state === 'reserved')
          throw tagged('TASK_IN_PROGRESS', 'Эта задача ещё обрабатывается. Дождитесь ответа.');
      }
      const active = grants.activeRow(current.organizationId, service),
        status = grants.view(active);
      if (!status.active)
        throw Object.assign(fail(402, 'Подключите пакет голосового помощника.'), {
          code: 'ASSISTANT_PACKAGE_REQUIRED',
        });
      const connection = db
        .prepare(
          'SELECT enabled,value,credential_hash FROM billing_service_connections WHERE organization_id=? AND service=?',
        )
        .get(current.organizationId, service);
      const secret = connection && core.open(connection.value);
      if (
        !connection?.enabled ||
        secret.packageGrantId !== active.id ||
        typeof secret.credential !== 'string' ||
        hash(secret.credential) !== connection.credential_hash
      )
        throw fail(402, 'Услуга приостановлена.');
      if (status.quotaUnit === 'access')
        throw fail(400, 'Пакет доступа не расходуется по задачам.');
      if (status.remainingTasks < 1)
        throw Object.assign(
          fail(
            402,
            'Задачи пакета закончились. Новый пакет доступен после окончания текущего месяца.',
          ),
          { code: 'ASSISTANT_PACKAGE_EXHAUSTED' },
        );
      const taskId = prior?.id || id(),
        dialogueHash = input.dialogueId === undefined ? null : hash(input.dialogueId);
      if (prior)
        db.prepare(
          "UPDATE billing_package_tasks SET grant_id=?,state='reserved',attempt=attempt+1,created_at=?,accepted_at=NULL,dialogue_hash=? WHERE id=? AND state='released'",
        ).run(active.id, now(), dialogueHash, taskId);
      else
        db.prepare(
          "INSERT INTO billing_package_tasks VALUES(?,?,?,?,?,?,?,?,'reserved',1,?,NULL)",
        ).run(
          taskId,
          active.id,
          current.organizationId,
          current.accountId,
          sessionHash,
          input.requestId,
          input.payloadHash,
          dialogueHash,
          now(),
        );
      return ticketView(
        db.prepare('SELECT * FROM billing_package_tasks WHERE id=?').get(taskId),
        current,
      );
    });
  }
  function take(ticket) {
    if (!ticket || typeof ticket !== 'object') throw fail(400, 'Нужна серверная квитанция задачи.');
    identifier(ticket.id, 'задача');
    identifier(ticket.sessionId, 'сеанс');
    const row = db.prepare('SELECT * FROM billing_package_tasks WHERE id=?').get(ticket.id);
    if (
      !row ||
      row.organization_id !== ticket.organizationId ||
      row.account_id !== ticket.accountId ||
      row.session_hash !== hash(ticket.sessionId) ||
      row.request_id !== ticket.requestId ||
      row.attempt !== ticket.attempt
    )
      throw fail(403, 'Задача принадлежит другому контексту.');
    return row;
  }
  function settle(ticket, meta = {}, reject = false) {
    ready();
    if (
      !meta ||
      typeof meta !== 'object' ||
      Array.isArray(meta) ||
      Object.keys(meta).some((key) => !['uncertain', 'outbound', 'dialogueId'].includes(key)) ||
      (meta.uncertain !== undefined && typeof meta.uncertain !== 'boolean') ||
      (meta.outbound !== undefined && typeof meta.outbound !== 'boolean')
    )
      throw fail(400, 'Некорректный результат задачи.');
    if (meta.dialogueId !== undefined) identifier(meta.dialogueId, 'диалог');
    return transaction(() => {
      const row = take(ticket);
      const dialogueHash =
        meta.dialogueId === undefined ? row.dialogue_hash : hash(meta.dialogueId);
      if (row.state === 'released' && !reject)
        throw tagged('TASK_NOT_RESERVED', 'Задача уже отменена. Повторите команду заново.');
      if (row.state !== 'reserved') {
        if (['accepted', 'uncertain'].includes(row.state) && meta.dialogueId !== undefined)
          db.prepare(
            'UPDATE billing_package_tasks SET dialogue_hash=? WHERE id=? AND attempt=?',
          ).run(dialogueHash, row.id, row.attempt);
        if (row.state === 'accepted' && meta.uncertain === true)
          db.prepare(
            "UPDATE billing_package_tasks SET state='uncertain' WHERE id=? AND attempt=?",
          ).run(row.id, row.attempt);
        return {
          ...ticketView(
            db.prepare('SELECT * FROM billing_package_tasks WHERE id=?').get(row.id),
            ticket,
          ),
          replayed: true,
        };
      }
      const release = reject && meta.outbound !== true && meta.uncertain !== true;
      const state = release ? 'released' : meta.uncertain === true ? 'uncertain' : 'accepted';
      db.prepare(
        'UPDATE billing_package_tasks SET state=?,accepted_at=?,dialogue_hash=? WHERE id=? AND attempt=? AND state=?',
      ).run(state, release ? null : now(), dialogueHash, row.id, row.attempt, 'reserved');
      return ticketView(
        db.prepare('SELECT * FROM billing_package_tasks WHERE id=?').get(row.id),
        ticket,
      );
    });
  }
  function requireAcceptedTask({
    current,
    requestId,
    dialogueId,
    serviceCode = 'voice-assistant',
  }) {
    ready();
    member(current);
    const byDialogue = dialogueId !== undefined;
    identifier(byDialogue ? dialogueId : requestId, byDialogue ? 'диалог' : 'номер задачи');
    const row = db
      .prepare(
        `SELECT t.*,g.starts_at,g.ends_at FROM billing_package_tasks t JOIN billing_package_grants g ON g.id=t.grant_id WHERE t.organization_id=? AND t.account_id=? AND t.session_hash=? AND t.${byDialogue ? 'dialogue_hash' : 'request_id'}=?`,
      )
      .get(
        current.organizationId,
        current.accountId,
        hash(current.sessionId),
        byDialogue ? hash(dialogueId) : requestId,
      );
    const grant =
      row && db.prepare('SELECT * FROM billing_package_grants WHERE id=?').get(row.grant_id);
    if (
      !row ||
      (grant?.service_code || 'voice-assistant') !== serviceCode ||
      !grants.view(grant).active ||
      !['accepted', 'uncertain'].includes(row.state) ||
      row.starts_at > now() ||
      row.ends_at <= now()
    )
      throw Object.assign(fail(402, 'Сначала выполните задачу в действующем пакете помощника.'), {
        code: 'ASSISTANT_TASK_REQUIRED',
      });
    return ticketView(row, current);
  }
  return {
    requireAcceptedTask,
    reserveTask,
    acceptTask: (ticket, meta) => settle(ticket, meta, false),
    rejectTask: (ticket, meta) => settle(ticket, meta, true),
  };
}
module.exports = { createPackageTasks };
