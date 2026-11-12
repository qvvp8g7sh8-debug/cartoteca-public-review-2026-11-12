const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { packageTables } = require('./package-schema.cjs');
function createPackageContext(context) {
  const { db, seal, open, transaction, audit = () => {} } = context;
  const now = typeof context.now === 'function' ? context.now : Date.now;
  const id = context.id || crypto.randomUUID;
  let prepared;
  function available() {
    if (prepared === undefined) {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'billing_%'")
        .all();
      prepared = [...packageTables, 'billing_service_connections'].every((name) =>
        tables.some((row) => row.name === name),
      );
    }
    return prepared;
  }
  function ready() {
    if (!available()) throw fail(503, 'Пакеты голосового помощника ещё не подготовлены.');
  }
  function identifier(value, label = 'идентификатор') {
    if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u001f]/.test(value))
      throw fail(400, 'Некорректный ' + label + '.');
    return value;
  }
  function admin(actorId) {
    identifier(actorId);
    if (
      !db
        .prepare("SELECT 1 FROM accounts WHERE id=? AND global_admin=1 AND status='active'")
        .get(actorId)
    )
      throw fail(403, 'Пакеты доступны только главному администратору.');
  }
  function organizationActive(orgId) {
    identifier(orgId, 'кабинет');
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM organizations o JOIN subscriptions s ON s.organization_id=o.id WHERE o.id=? AND o.status='active' AND s.status='active'`,
        )
        .get(orgId),
    );
  }
  function requireOrganization(orgId) {
    if (!organizationActive(orgId)) throw fail(403, 'Нет активного доступа к кабинету.');
  }
  function member(current) {
    if (!current || current.globalAdmin) throw fail(403, 'Выберите свой кабинет.');
    identifier(current.organizationId, 'кабинет');
    identifier(current.accountId, 'сотрудник');
    identifier(current.sessionId, 'сеанс');
    const row = db
      .prepare(
        `SELECT m.role,m.status,a.status account_status,a.global_admin FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=? AND m.account_id=?`,
      )
      .get(current.organizationId, current.accountId);
    if (
      !row ||
      row.role !== current.role ||
      row.status !== 'active' ||
      row.account_status !== 'active' ||
      row.global_admin ||
      !['owner', 'salon_admin', 'cosmetologist'].includes(row.role)
    )
      throw fail(403, 'Нет активного доступа к помощнику.');
    requireOrganization(current.organizationId);
  }
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  function operation(actorId, input, body, action) {
    ready();
    identifier(input.requestId, 'номер операции');
    admin(actorId);
    if (
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 3 ||
      input.reason.trim().length > 500
    )
      throw fail(400, 'Укажите причину изменения (от 3 до 500 символов).');
    const fingerprint = hash(JSON.stringify(body));
    return transaction(() => {
      admin(actorId);
      const prior = db
        .prepare(
          'SELECT fingerprint,value FROM billing_package_operations WHERE actor_id=? AND request_id=?',
        )
        .get(actorId, input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw fail(409, 'Номер операции уже использован для другого действия.');
        return { ...open(prior.value), replayed: true };
      }
      const result = action();
      db.prepare('INSERT INTO billing_package_operations VALUES(?,?,?,?,?)').run(
        actorId,
        input.requestId,
        fingerprint,
        seal(result),
        now(),
      );
      return result;
    });
  }
  function calendarMonthEnd(startsAt, months = 1) {
    const start = new Date(startsAt),
      end = new Date(startsAt),
      day = start.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + months);
    const next = new Date(end);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(0);
    end.setUTCDate(Math.min(day, next.getUTCDate()));
    return end.getTime();
  }
  function bindCredential(orgId, grantId, actorId = null, service = 'voice-assistant') {
    const credential = crypto.randomBytes(32).toString('base64url'),
      keyId = id();
    db.prepare(
      `INSERT INTO billing_service_connections(organization_id,service,revision,enabled,key_id,credential_hash,value,changed_at) VALUES(?,?,1,1,?,?,?,?) ON CONFLICT(organization_id,service) DO UPDATE SET revision=revision+1,enabled=1,key_id=excluded.key_id,credential_hash=excluded.credential_hash,value=excluded.value,changed_at=excluded.changed_at`,
    ).run(
      orgId,
      service,
      keyId,
      hash(credential),
      seal({ credential, packageGrantId: grantId, actorId, source: 'package' }),
      now(),
    );
  }
  return {
    db,
    seal,
    open,
    transaction,
    audit,
    now,
    id,
    available,
    ready,
    identifier,
    admin,
    organizationActive,
    requireOrganization,
    member,
    hash,
    operation,
    calendarMonthEnd,
    bindCredential,
    fail,
  };
}
module.exports = { createPackageContext };
