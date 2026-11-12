const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const SERVICE = 'voice-assistant';
const { serviceCode } = require('./service-catalog.cjs');
function createBillingEntitlements(context, wallet, packages, payments) {
  const { db, open, seal, transaction, audit } = context;
  function available() {
    return wallet.available() && packages.available();
  }
  function requireCustomer(current) {
    if (!current?.organizationId || !current.accountId || current.globalAdmin)
      throw fail(403, 'Выберите свой кабинет.');
    const row = db
      .prepare(
        `SELECT m.role,m.status,a.status account_status,o.status organization_status,s.status subscription_status
       FROM memberships m JOIN accounts a ON a.id=m.account_id JOIN organizations o ON o.id=m.organization_id
       JOIN subscriptions s ON s.organization_id=m.organization_id
       WHERE m.organization_id=? AND m.account_id=? AND a.global_admin=0`,
      )
      .get(current.organizationId, current.accountId);
    if (
      !row ||
      row.role !== 'owner' ||
      current.role !== 'owner' ||
      row.status !== 'active' ||
      row.account_status !== 'active' ||
      row.organization_status !== 'active' ||
      row.subscription_status !== 'active'
    )
      throw fail(403, 'Пакеты, оплата и подключение доступны только владельцу организации.');
    return current.organizationId;
  }
  function connection(organizationId, service = SERVICE) {
    serviceCode(service);
    if (!available()) return { revision: 0, enabled: false, connectionId: null };
    const row = db
      .prepare(
        'SELECT revision,enabled,key_id,credential_hash,value FROM billing_service_connections WHERE organization_id=? AND service=?',
      )
      .get(organizationId, service);
    if (!row) return { revision: 0, enabled: false, connectionId: null };
    const value = open(row.value);
    const valid =
      typeof value.credential === 'string' &&
      typeof row.credential_hash === 'string' &&
      crypto.createHash('sha256').update(value.credential).digest('hex') === row.credential_hash;
    return {
      revision: row.revision,
      enabled: Boolean(row.enabled && valid),
      connectionId: row.key_id || null,
      grantId: value.packageGrantId || null,
    };
  }
  function hasServiceConnection(organizationId, service = SERVICE) {
    serviceCode(service);
    return (
      available() &&
      Boolean(
        db
          .prepare(
            'SELECT 1 FROM billing_service_connections WHERE organization_id=? AND service=?',
          )
          .get(organizationId, service),
      )
    );
  }
  function isServiceEnabled(organizationId, service = SERVICE) {
    serviceCode(service);
    if (!organizationId || !available()) return false;
    const subscription = packages.status(organizationId, service),
      info = connection(organizationId, service);
    return Boolean(subscription.active && info.enabled && info.grantId === subscription.grantId);
  }
  function publicSubscription(org, service = SERVICE) {
    const { grantId, packageVersion, ...subscription } = packages.status(org, service);
    return {
      ...subscription,
      enabled: isServiceEnabled(org, service),
      connectionRevision: connection(org, service).revision,
    };
  }
  function view(current) {
    const org = requireCustomer(current);
    const payment = payments.publicConfig();
    return {
      available: available(),
      packages: packages.catalog(),
      subscription: publicSubscription(org),
      services: packages
        .services()
        .map((service) => ({ ...service, subscription: publicSubscription(org, service.code) })),
      orders: payments.customerOrders(current),
      multipleServices: packages.multipleServices(),
      paymentReady: Boolean(available() && payment.ready),
      receiptEmailRequired: true,
      termsVersion: 'packages-20261019-draft',
      paymentNotice: available()
        ? payment.notice
        : 'Пакеты ещё не подготовлены. Приём оплат отключён.',
    };
  }
  function setConnection(current, input) {
    const org = requireCustomer(current);
    if (!available()) throw fail(503, 'Пакеты ещё не подготовлены.');
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !['enabled', 'expectedRevision', 'requestId', 'serviceCode'].includes(k),
      ) ||
      typeof input.enabled !== 'boolean' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      typeof input.requestId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(input.requestId)
    )
      throw fail(400, 'Укажите состояние подключения, версию и номер операции.');
    const service = serviceCode(input.serviceCode);
    if (!packages.services().some((item) => item.code === service))
      throw fail(404, 'Услуга не найдена.');
    const hash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    transaction(() => {
      requireCustomer(current);
      const prior = db
        .prepare(
          'SELECT fingerprint FROM billing_customer_operations WHERE organization_id=? AND account_id=? AND request_id=?',
        )
        .get(org, current.accountId, input.requestId);
      if (prior) {
        if (prior.fingerprint !== hash)
          throw fail(409, 'Номер операции уже использован для другого действия.');
        return;
      }
      const previous = connection(org, service),
        subscription = packages.status(org, service);
      if (previous.revision !== input.expectedRevision)
        throw fail(409, 'Подключение изменилось. Обновите раздел.');
      if (input.enabled && !subscription.active)
        throw fail(402, 'Для подключения нужен действующий пакет.');
      const credential = input.enabled ? crypto.randomBytes(32).toString('base64url') : null;
      const keyId = input.enabled ? crypto.randomUUID() : null;
      db.prepare(
        `INSERT INTO billing_service_connections VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,service)
         DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,key_id=excluded.key_id,
         credential_hash=excluded.credential_hash,value=excluded.value,changed_at=excluded.changed_at`,
      ).run(
        org,
        service,
        previous.revision + 1,
        Number(input.enabled),
        keyId,
        credential ? crypto.createHash('sha256').update(credential).digest('hex') : null,
        seal({
          credential,
          actorId: current.accountId,
          packageGrantId: subscription.grantId,
          source: 'package',
        }),
        Date.now(),
      );
      db.prepare('INSERT INTO billing_customer_operations VALUES(?,?,?,?,?,?)').run(
        org,
        current.accountId,
        input.requestId,
        hash,
        seal({ revision: previous.revision + 1 }),
        Date.now(),
      );
      audit(
        input.enabled ? 'billing_service_connected' : 'billing_service_disconnected',
        current.accountId,
        org,
        {
          targetId: org + ':' + service,
          operationId: input.requestId,
          before: { service, enabled: previous.enabled, revision: previous.revision },
          after: { service, enabled: input.enabled, revision: previous.revision + 1 },
        },
      );
    });
    return view(current);
  }
  return {
    available,
    requireCustomer,
    connection,
    hasServiceConnection,
    isServiceEnabled,
    view,
    setConnection,
  };
}
module.exports = { createBillingEntitlements };
