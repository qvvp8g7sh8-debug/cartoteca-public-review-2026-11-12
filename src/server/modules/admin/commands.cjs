function createAdminCommands({ db, fail, seal, open, limitKey, transaction, audit }, policy) {
  function revision(kind, resourceId) {
    return (
      db
        .prepare('SELECT revision FROM admin_resource_versions WHERE kind=? AND resource_id=?')
        .get(kind, resourceId)?.revision || 0
    );
  }
  function touch(kind, resourceId) {
    db.prepare(
      'INSERT INTO admin_resource_versions(kind,resource_id,revision) VALUES(?,?,1) ON CONFLICT(kind,resource_id) DO UPDATE SET revision=revision+1',
    ).run(kind, resourceId);
    return revision(kind, resourceId);
  }
  function record(actorId, kind, resourceId, event, detail = {}) {
    const auditId = audit(
      event,
      actorId,
      kind === 'organization' || kind === 'subscription'
        ? resourceId
        : detail.organizationId || null,
      {
        version: 1,
        targetType: kind,
        targetId: resourceId,
        fields: Object.keys(detail.after || {}),
      },
    );
    db.prepare('INSERT INTO admin_audit_details(audit_id,value) VALUES(?,?)').run(
      auditId,
      seal(detail),
    );
  }
  function execute(
    actorId,
    capability,
    kind,
    resourceId,
    input,
    action,
    { reasonRequired = false } = {},
  ) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof resourceId !== 'string' ||
      !resourceId ||
      resourceId.length > 128 ||
      (input.reason !== undefined && typeof input.reason !== 'string') ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        input.requestId || '',
      ) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw fail(400, 'Нужны ключ операции и актуальная версия карточки.');
    const fields = {
      'organizations.profile': ['changes'],
      'organizations.access': ['status'],
      'subscriptions.manage': ['plan', 'limits'],
      'accounts.access': ['status'],
      'accounts.sessions': [],
      'accounts.recover': ['email', 'identityConfirmed'],
      'support.manage': ['state', 'claim', 'kind', 'text', 'improvementState'],
    };
    const allowed = new Set([
      'requestId',
      'expectedRevision',
      'reason',
      'organizationId',
      'accountId',
      'caseId',
      ...(fields[capability] || []),
    ]);
    if (Object.keys(input).some((key) => !allowed.has(key)))
      throw fail(400, 'Команда содержит недопустимые поля.');
    const reason = String(input.reason || '').trim();
    if (reason.length > 500 || (reasonRequired && reason.length < 3))
      throw fail(400, 'Укажите причину действия (от 3 до 500 символов).');
    const fingerprint = limitKey(
      'admin-operation',
      JSON.stringify({ capability, kind, resourceId, input }),
    );
    return transaction(() => {
      policy.assert(actorId, capability);
      const previous = db
        .prepare('SELECT fingerprint,value FROM admin_operations WHERE actor_id=? AND request_id=?')
        .get(actorId, input.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw fail(409, 'Ключ операции уже использован для другого действия.');
        return open(previous.value);
      }
      if (revision(kind, resourceId) !== input.expectedRevision)
        throw fail(409, 'Карточка изменилась. Откройте её заново; ваши изменения не сохранены.');
      const outcome = action(reason);
      const nextRevision = touch(kind, resourceId);
      record(actorId, kind, resourceId, outcome.event, {
        ...outcome.detail,
        reason,
        operationId: input.requestId,
      });
      const result = { ok: true, revision: nextRevision, ...outcome.result };
      db.prepare('INSERT INTO admin_operations VALUES(?,?,?,?,?)').run(
        actorId,
        input.requestId,
        fingerprint,
        seal(result),
        Date.now(),
      );
      return result;
    });
  }
  return { revision, touch, record, execute };
}
module.exports = { createAdminCommands };
