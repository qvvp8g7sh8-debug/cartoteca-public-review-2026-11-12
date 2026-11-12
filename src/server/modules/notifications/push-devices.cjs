const { createPushActivity } = require('./push-activity.cjs');
const rules = require('./push-validation.cjs');
const { staffRecipientPolicy } = require('./staff-recipient-policy.cjs');
function createPushDevices(c) {
  const { db, open, seal, transaction, limitKey, id, fail } = c;
  const policy = staffRecipientPolicy(c);
  const activity = createPushActivity(c);
  const actor = (token) => c.onlineBooking.actor(token);
  const hash = (endpoint) => limitKey('staff-push-endpoint', endpoint);
  const revisionKey = (endpointHash) => 'push-binding-v1:' + endpointHash;
  const readRevision = db.prepare('SELECT value FROM telegram_runtime WHERE key=?');
  const writeRevision = db.prepare(
    'INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)',
  );
  function rememberBinding(endpointHash, revision = id()) {
    if (!db.isTransaction) throw Error('Push binding revision requires a transaction.');
    writeRevision.run(revisionKey(endpointHash), seal({ revision }));
  }
  function expectation(user, endpointHash, row) {
    const marker = readRevision.get(revisionKey(endpointHash));
    const revision = marker ? open(marker.value).revision : 'initial';
    if (typeof revision !== 'string' || !revision) throw Error('Invalid Push binding revision.');
    return limitKey(
      'staff-push-binding-expectation-v1',
      JSON.stringify([
        user.accountId,
        user.organizationId,
        endpointHash,
        row ? ['bound', row.decoded.bindingId] : ['absent', revision],
      ]),
    );
  }
  const decode = (row) => {
    if (!row) return null;
    const decoded = open(row.value);
    return {
      ...row,
      decoded: { ...decoded, preferences: rules.storedPreferences(decoded.preferences) },
    };
  };
  const device = (deviceId) =>
    decode(db.prepare('SELECT * FROM staff_push_devices WHERE id=?').get(deviceId));
  function owned(user, deviceId) {
    const row = device(deviceId);
    if (!row || row.account_id !== user.accountId || row.organization_id !== user.organizationId)
      throw fail(404, 'Подключение устройства не найдено.');
    return row;
  }
  function status(token, endpoint = '') {
    const user = actor(token);
    const endpointHash = endpoint ? hash(endpoint) : '';
    const current = endpoint
      ? decode(
          db.prepare('SELECT * FROM staff_push_devices WHERE endpoint_hash=?').get(endpointHash),
        )
      : null;
    const row =
      current?.account_id === user.accountId && current.organization_id === user.organizationId
        ? current
        : null;
    const keys = open(
      db.prepare("SELECT value FROM staff_push_config WHERE id='vapid'").get().value,
    );
    return {
      prepared: true,
      available: activity.runtimeAvailable() && policy.allowed(user.organizationId),
      publicKey: keys.publicKey,
      device: row
        ? { id: row.id, enabled: row.decoded.enabled, preferences: row.decoded.preferences }
        : null,
      preferences: rules.defaults(),
      bindingExpectation: endpoint ? expectation(user, endpointHash, current) : null,
    };
  }
  function connect(token, value, bindingExpectation) {
    const sub = rules.subscription(value);
    if (
      typeof bindingExpectation !== 'string' ||
      !/^staff-push-binding-expectation-v1:[a-f0-9]{64}$/.test(bindingExpectation)
    )
      throw fail(400, 'Обновите статус устройства перед подключением уведомлений.');
    return transaction(() => {
      const user = actor(token);
      if (!activity.runtimeAvailable()) throw fail(503, 'Пуш-уведомления выключены на сервере.');
      if (!policy.allowed(user.organizationId))
        throw fail(403, 'Уведомления недоступны по тарифу.');
      const prior = decode(
        db
          .prepare('SELECT * FROM staff_push_devices WHERE endpoint_hash=?')
          .get(hash(sub.endpoint)),
      );
      if (bindingExpectation !== expectation(user, hash(sub.endpoint), prior))
        throw fail(409, 'Подключение уведомлений изменилось. Обновите статус и включите их снова.');
      const reassigned =
        prior &&
        (prior.account_id !== user.accountId || prior.organization_id !== user.organizationId);
      // A shared browser subscription may move only on an explicit authenticated
      // connect with its complete capability, never by knowing its endpoint alone.
      if (
        reassigned &&
        (prior.decoded.subscription.keys.p256dh !== sub.keys.p256dh ||
          prior.decoded.subscription.keys.auth !== sub.keys.auth)
      )
        throw fail(409, 'Переподключите браузер к текущему аккаунту.');
      if (
        (!prior || reassigned) &&
        db
          .prepare(
            'SELECT count(*) n FROM staff_push_devices WHERE organization_id=? AND account_id=?',
          )
          .get(user.organizationId, user.accountId).n >= 10
      )
        throw fail(409, 'Подключено десять устройств. Отключите одно из них.');
      if (reassigned) {
        cancel(prior.id);
        cancelWorkday(prior.organization_id, prior.id);
        db.prepare('DELETE FROM staff_push_devices WHERE id=?').run(prior.id);
        activity.updateDeviceInterest(prior.organization_id, prior.id, null);
      }
      const ownPrior = reassigned ? null : prior;
      const deviceId = ownPrior?.id || id();
      const bindingId = id();
      rememberBinding(hash(sub.endpoint), bindingId);
      db.prepare('INSERT OR REPLACE INTO staff_push_devices VALUES(?,?,?,?,?,?)').run(
        deviceId,
        user.organizationId,
        user.accountId,
        hash(sub.endpoint),
        seal({
          subscription: sub,
          bindingId,
          enabled: true,
          preferences: ownPrior?.decoded.preferences || rules.defaults(),
        }),
        ownPrior?.created_at || Date.now(),
      );
      activity.updateDeviceInterest(user.organizationId, deviceId, device(deviceId).decoded);
      cancel(deviceId);
      cancelWorkday(user.organizationId, deviceId);
      c.audit('staff_push_connected', user.accountId, user.organizationId);
      return status(token, sub.endpoint);
    });
  }
  function cancel(deviceId) {
    db.prepare(
      "UPDATE staff_push_jobs SET status='cancelled',lease_id=NULL,lease_until=0 WHERE device_id=? AND status IN ('pending','sending')",
    ).run(deviceId);
  }
  function cancelWorkday(org, deviceId) {
    if (c.notificationSchedule?.enabled)
      c.notificationSchedule.replaceTasks('workday', org, deviceId, []);
  }
  function cancelChanged(deviceId, before, next, org) {
    const disabled = new Set(before.events.filter((event) => !next.events.includes(event)));
    if (before.leadMinutes !== next.leadMinutes) disabled.add('reminder');
    if (!disabled.size) return;
    if (disabled.has('reminder')) cancelWorkday(org, deviceId);
    const jobs = db
      .prepare(
        "SELECT id,value FROM staff_push_jobs WHERE device_id=? AND status IN ('pending','sending')",
      )
      .all(deviceId);
    const cancelJob = db.prepare(
      "UPDATE staff_push_jobs SET status='cancelled',lease_id=NULL,lease_until=0 WHERE id=? AND device_id=? AND status IN ('pending','sending')",
    );
    for (const job of jobs) {
      const { event, reference } = open(job.value);
      if (disabled.has(rules.eventCategory(event, reference))) cancelJob.run(job.id, deviceId);
    }
  }
  function update(token, body, disconnect = false) {
    if (
      !body ||
      Object.keys(body).some((k) => !['deviceId', 'preferences'].includes(k)) ||
      typeof body.deviceId !== 'string'
    )
      throw fail(400, 'Укажите подключение устройства.');
    const prefs = disconnect ? null : rules.preferences(body.preferences);
    return transaction(() => {
      const user = actor(token),
        row = owned(user, body.deviceId);
      if (disconnect) {
        cancel(row.id);
        cancelWorkday(row.organization_id, row.id);
        rememberBinding(row.endpoint_hash);
        db.prepare('DELETE FROM staff_push_devices WHERE id=?').run(row.id);
        activity.updateDeviceInterest(row.organization_id, row.id, null);
      } else {
        cancelChanged(row.id, row.decoded.preferences, prefs, row.organization_id);
        db.prepare('UPDATE staff_push_devices SET value=? WHERE id=?').run(
          seal({ ...row.decoded, enabled: true, preferences: prefs }),
          row.id,
        );
        activity.updateDeviceInterest(row.organization_id, row.id, {
          ...row.decoded,
          enabled: true,
          preferences: prefs,
        });
      }
      c.audit(
        disconnect ? 'staff_push_disconnected' : 'staff_push_preferences',
        user.accountId,
        user.organizationId,
      );
      return status(token, row.decoded.subscription.endpoint);
    });
  }
  function recipients(org, staffId, event, reference = {}) {
    if (
      !activity.hasEnabledEvents(org, rules.eventCategory(event, reference)) ||
      !policy.allowed(org)
    )
      return [];
    return db
      .prepare('SELECT * FROM staff_push_devices WHERE organization_id=?')
      .all(org)
      .map(decode)
      .filter((row) => {
        const member = policy.member(org, row.account_id);
        return (
          member &&
          (event === 'reminder'
            ? !staffId || row.account_id === staffId
            : ['owner', 'salon_admin'].includes(member.role) || row.account_id === staffId) &&
          row.decoded.enabled &&
          row.decoded.preferences.events.includes(rules.eventCategory(event, reference))
        );
      });
  }
  function expire(deviceId, bindingId) {
    return transaction(() => {
      const row = device(deviceId);
      if (row?.decoded.bindingId !== bindingId) return;
      cancel(deviceId);
      cancelWorkday(row.organization_id, deviceId);
      rememberBinding(row.endpoint_hash);
      db.prepare('DELETE FROM staff_push_devices WHERE id=?').run(deviceId);
      activity.updateDeviceInterest(row.organization_id, deviceId, null);
    });
  }
  return {
    ...policy,
    ...activity,
    actor,
    status,
    connect,
    update,
    device,
    owned,
    recipients,
    expire,
    cancel,
  };
}
module.exports = { createPushDevices };
