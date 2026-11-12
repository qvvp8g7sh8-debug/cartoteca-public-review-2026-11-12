function createPaymentOrders(core, settings, ledger) {
  const {
    db,
    seal,
    transaction,
    now,
    id,
    fail,
    ready,
    owner,
    guard,
    fields,
    identifier,
    fingerprint,
    provider,
    packages,
    termsVersion,
  } = core;
  const DAY = 24 * 60 * 60 * 1000;
  function checkoutInput(input) {
    fields(input, [
      'packageId',
      'packageVersion',
      'requestId',
      'receiptEmail',
      'acceptedTermsVersion',
    ]);
    identifier(input.packageId);
    identifier(input.requestId);
    if (
      !Number.isSafeInteger(input.packageVersion) ||
      input.packageVersion < 1 ||
      input.acceptedTermsVersion !== termsVersion ||
      typeof input.receiptEmail !== 'string' ||
      input.receiptEmail.length > 254 ||
      /[\u0000-\u001f\u007f]/u.test(input.receiptEmail) ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.receiptEmail)
    )
      throw fail(400, 'Проверьте пакет, адрес для чека и согласие с условиями.');
  }
  function takeIntent(current, input, assertCurrent) {
    return transaction(() => {
      guard(current, assertCurrent);
      const digest = fingerprint(input);
      let row = db
        .prepare('SELECT * FROM billing_payment_orders WHERE organization_id=? AND request_id=?')
        .get(current.organizationId, input.requestId);
      if (row) {
        const data = ledger.value(row);
        if (data.fingerprint !== digest || row.account_id !== current.accountId)
          throw fail(409, 'Номер заказа уже использован с другими условиями.');
        if (data.restoredReview || ['paid', 'canceled', 'rejected'].includes(row.state))
          return { kind: 'view', row };
        if (row.provider_payment_id) return { kind: 'read', row };
        if (row.lease_until > now()) return { kind: 'view', row };
        if (now() - row.created_at >= DAY) {
          data.receiptEmail = null;
          ledger.save(row, data, { state: 'review', lease_until: 0, lease_id: null });
          return { kind: 'view', row: ledger.load(row.id) };
        }
        if (!settings.forOrder(row, data.seller)) return { kind: 'view', row };
      } else {
        const currentSeller = settings.internal();
        const seller = {
          revision: currentSeller.revision,
          shopId: currentSeller.shopId,
          returnOrigin: currentSeller.returnOrigin,
          testMode: currentSeller.testMode,
          receiptConfig: currentSeller.receiptConfig,
        };
        if (!settings.publicConfig().ready)
          throw fail(503, 'Приём оплаты пакетов ещё не подключён.');
        const published = packages.catalog().find((item) => item.id === input.packageId);
        const definition = published && packages.definition(published.id);
        if (!definition || !definition.enabled || definition.version !== input.packageVersion)
          throw fail(409, 'Условия пакета изменились. Обновите каталог перед оплатой.');
        const service = definition.serviceCode || 'voice-assistant';
        if (packages.status(current.organizationId, service).active)
          throw fail(
            409,
            'Пакет уже действует. Новый можно купить после окончания текущего месяца.',
          );
        if (
          db
            .prepare(
              'SELECT 1 FROM billing_payment_orders WHERE organization_id=? AND state IN ' +
                ledger.activeStates +
                (packages.multipleServices() ? ' AND service_code=? LIMIT 1' : ' LIMIT 1'),
            )
            .get(current.organizationId, ...(packages.multipleServices() ? [service] : []))
        )
          throw fail(
            409,
            'У кабинета уже есть незавершённая оплата. Сначала проверьте её результат.',
          );
        seller.receiptConfig = {
          ...seller.receiptConfig,
          description: definition.title,
          ...Object.fromEntries(
            Object.entries(definition.receipt || {}).filter(
              ([, value]) => value !== '' && value !== null && value !== undefined,
            ),
          ),
        };
        const order = {
          id: id(),
          organizationId: current.organizationId,
          packageId: definition.id,
          serviceCode: service,
          serviceTitle: definition.serviceTitle,
          periodMonths: definition.periodMonths || 1,
          quotaUnit: definition.quotaUnit || 'tasks',
          packageVersion: definition.version,
          title: definition.title,
          priceKopecks: definition.priceKopecks,
          taskLimit: definition.taskLimit,
          accountId: current.accountId,
          createdAt: now(),
        };
        db.prepare(
          `INSERT INTO billing_payment_orders(id,organization_id,account_id,request_id,package_id,price_kopecks,state,
          config_revision,shop_id,test_mode,created_at,changed_at,value${packages.multipleServices() ? ',service_code' : ''}) VALUES(?,?,?,?,?,?,'creating',?,?,?,?,?,?${packages.multipleServices() ? ',?' : ''})`,
        ).run(
          order.id,
          order.organizationId,
          order.accountId,
          input.requestId,
          order.packageId,
          order.priceKopecks,
          seller.revision,
          seller.shopId,
          Number(seller.testMode),
          order.createdAt,
          order.createdAt,
          seal({
            order,
            seller,
            receiptEmail: input.receiptEmail,
            fingerprint: digest,
            termsVersion,
            confirmationUrl: null,
            revision: 0,
          }),
          ...(packages.multipleServices() ? [service] : []),
        );
        row = ledger.load(order.id);
      }
      const leaseId = id();
      ledger.save(row, ledger.value(row), {
        state: 'creating',
        lease_until: now() + 30000,
        lease_id: leaseId,
      });
      return { kind: 'create', row: ledger.load(row.id), leaseId };
    });
  }
  async function beginCheckout(current, input, { assertCurrent } = {}) {
    ready();
    owner(current);
    checkoutInput(input);
    const intent = takeIntent(current, input, assertCurrent);
    if (intent.kind === 'view') return ledger.view(intent.row);
    if (intent.kind === 'read') return payment(current, intent.row.id, { assertCurrent });
    const data = ledger.value(intent.row),
      order = data.order;
    let dto;
    try {
      const liveConfig = settings.forOrder(intent.row, data.seller);
      if (!liveConfig) return ledger.view(intent.row);
      dto = await provider(liveConfig).createCheckout({
        organizationId: order.organizationId,
        amountKopecks: order.priceKopecks,
        idempotencyKey: order.id,
        returnUrl: new URL('/?payment=' + encodeURIComponent(order.id), data.seller.returnOrigin)
          .href,
        receiptEmail: data.receiptEmail,
        checkoutId: order.id,
      });
    } catch (error) {
      const safe = { outcomeUnknown: error.outcomeUnknown !== false };
      return ledger.failed(order.id, intent.leaseId, safe, current, assertCurrent);
    }
    guard(current, assertCurrent);
    return ledger.apply(order.id, dto, current, assertCurrent);
  }
  async function payment(current, checkoutId, { assertCurrent } = {}) {
    ready();
    guard(current, assertCurrent);
    identifier(checkoutId);
    const row = ledger.load(checkoutId);
    if (!row || row.organization_id !== current.organizationId)
      throw fail(404, 'Оплата не найдена.');
    const data = ledger.value(row);
    if (
      data.restoredReview ||
      !row.provider_payment_id ||
      ['rejected', 'canceled'].includes(row.state)
    )
      return ledger.view(row);
    const liveConfig = settings.forOrder(row, data.seller);
    if (!liveConfig)
      return {
        ...ledger.view(row),
        notice: 'Проверка оплаты приостановлена. Нужна сверка администратора.',
      };
    const dto = await provider(liveConfig).readPayment(row.provider_payment_id);
    guard(current, assertCurrent);
    return ledger.apply(row.id, dto, current, assertCurrent);
  }
  async function webhook(body, headers) {
    ready();
    let event;
    try {
      const raw = Buffer.isBuffer(body)
        ? body.toString('utf8')
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw Error();
      event = JSON.parse(raw);
    } catch {
      throw fail(400, 'Неверное уведомление оплаты.');
    }
    if (
      event?.type !== 'notification' ||
      !['payment.succeeded', 'payment.waiting_for_capture', 'payment.canceled'].includes(
        event.event,
      ) ||
      typeof event.object?.id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(event.object.id)
    )
      return { received: true, ignored: true };
    let row = db
      .prepare('SELECT * FROM billing_payment_orders WHERE provider_payment_id=?')
      .get(event.object.id);
    if (!row && typeof event.object.metadata?.checkoutId === 'string')
      row = ledger.load(event.object.metadata.checkoutId);
    if (!row) return { received: true, ignored: true };
    const data = ledger.value(row);
    if (data.restoredReview) return { received: true, ignored: true, reconciliationRequired: true };
    const liveConfig = settings.forOrder(row, data.seller);
    if (!liveConfig) return { received: true, ignored: true, reconciliationRequired: true };
    const dto = await provider(liveConfig).verifyWebhook(body, headers);
    if (!ledger.matched(row, dto)) return { received: true, ignored: true };
    const result = ledger.apply(row.id, dto);
    return { received: true, checkoutId: result.id, status: result.status };
  }
  function customerOrders(current) {
    owner(current);
    if (!core.available()) return [];
    return db
      .prepare(
        "SELECT * FROM billing_payment_orders WHERE organization_id=? ORDER BY CASE WHEN state IN ('creating','pending','uncertain','review') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 120",
      )
      .all(current.organizationId)
      .map(ledger.view);
  }
  return { beginCheckout, payment, webhook, customerOrders, adminSummary: ledger.adminSummary };
}
module.exports = { createPaymentOrders };
