const { fail } = require('../../../shared/errors.cjs');
function createFinancialActions(core, settings, ledger) {
  const { db, open, seal, transaction, now, id, admin, packages, provider, audit } = core;
  const DAY = 86400000;
  const available = () => packages.multipleServices();
  const check = (actor, options = {}) => {
    const value = options.assertCurrent?.();
    if (value && typeof value.then === 'function')
      throw Error('Payment guard must be synchronous.');
    admin(actor);
  };
  const load = (key) => db.prepare('SELECT * FROM billing_financial_actions WHERE id=?').get(key);
  const view = (row) => ({
    id: row.id,
    checkoutId: row.order_id,
    kind: row.kind,
    status: row.state,
    amountKopecks: row.amount_kopecks,
    providerId: row.provider_id,
    createdAt: row.created_at,
    changedAt: row.changed_at,
  });
  function list(actor, orderId) {
    admin(actor);
    if (!available()) return [];
    return db
      .prepare(
        'SELECT * FROM billing_financial_actions WHERE order_id=? ORDER BY created_at DESC,id DESC LIMIT 50',
      )
      .all(orderId)
      .map(view);
  }
  function ready(actor, options) {
    check(actor, options);
    core.ready();
    if (!available()) throw fail(503, 'Финансовые действия требуют подготовленной схемы20.');
    if (!settings.publicConfig().ready)
      throw fail(503, 'Платёжная сеть выключена или магазин не настроен.');
  }
  function save(row, state, data, providerId = row.provider_id) {
    db.prepare(
      'UPDATE billing_financial_actions SET state=?,provider_id=?,lease_until=0,changed_at=?,value=? WHERE id=?',
    ).run(state, providerId, now(), seal(data), row.id);
    return load(row.id);
  }
  function record(row, dto, actor = null, options = {}) {
    return transaction(() => {
      if (actor) check(actor, options);
      row = load(row.id);
      const payload = open(row.value),
        order = ledger.load(row.order_id),
        data = ledger.value(order);
      if (
        dto.paymentId !== order.provider_payment_id ||
        !['pending', 'succeeded', 'canceled'].includes(dto.status) ||
        (row.provider_id && row.provider_id !== dto.id) ||
        (row.kind === 'refund' &&
          (dto.currency !== 'RUB' || dto.amountKopecks !== row.amount_kopecks)) ||
        (row.kind === 'receipt' &&
          (dto.type !== 'payment' ||
            dto.classification !== 'prepayment_offset_observed' ||
            dto.settledKopecks !== row.amount_kopecks))
      )
        throw fail(409, 'Объект провайдера не соответствует операции.');
      const field = row.kind === 'refund' ? 'refunds' : 'receipts';
      const old = data[field] || [],
        index = old.findIndex((item) => item.id === dto.id);
      if (index >= 0 && old[index].status === 'succeeded' && dto.status !== 'succeeded')
        throw fail(409, 'Подтверждённый результат не может стать неподтверждённым.');
      const item = {
        id: dto.id,
        status: dto.status,
        checkedAt: now(),
        ...(row.kind === 'refund'
          ? {
              amountKopecks: dto.amountKopecks,
              receiptRegistration: dto.receiptRegistration ?? null,
            }
          : { classification: dto.classification }),
      };
      const next = index < 0 ? [...old, item] : old.map((value, i) => (i === index ? item : value));
      if (
        next.length > 100 ||
        (row.kind === 'refund' &&
          next
            .filter((value) => ['pending', 'succeeded'].includes(value.status))
            .reduce((sum, value) => sum + BigInt(value.amountKopecks), 0n) >
            BigInt(order.price_kopecks))
      )
        throw fail(409, 'Сумма возвратов превышает стоимость заказа.');
      data[field] = next;
      if (row.kind === 'refund' && dto.status === 'succeeded' && payload.revokeAccess)
        packages.revokeOrder(order.id, dto.id);
      payload.receiptEmail = null;
      ledger.save(order, data);
      row = save(row, dto.status, payload, dto.id);
      audit('billing_financial_action', row.actor_id, order.organization_id, {
        targetId: row.id,
        operationId: row.request_id,
        reason: payload.reason,
        after: {
          kind: row.kind,
          status: row.state,
          amountKopecks: row.amount_kopecks,
          serviceCode: order.service_code || 'voice-assistant',
        },
      });
      return view(row);
    });
  }
  async function execute(row, actor, options = {}) {
    const initial = row;
    const intent = transaction(() => {
      check(actor, options);
      row = load(initial.id);
      if (['succeeded', 'canceled', 'rejected'].includes(row.state)) return { view: view(row) };
      if (row.lease_until > now()) return { view: view(row) };
      const data = open(row.value),
        order = ledger.load(row.order_id),
        orderData = ledger.value(order);
      if (orderData.restoredReview) throw fail(409, 'Сначала сверяйте восстановленный заказ.');
      const config = settings.forOrder(order, orderData.seller);
      if (!config) throw fail(503, 'Нужен действующий ключ того же магазина.');
      if (!row.provider_id && (!data.receiptEmail || now() - row.created_at >= DAY)) {
        data.receiptEmail = null;
        return { view: view(save(row, 'review', data)) };
      }
      db.prepare('UPDATE billing_financial_actions SET lease_until=? WHERE id=?').run(
        now() + 30000,
        row.id,
      );
      return { row, order, config, data };
    });
    if (intent.view) return intent.view;
    try {
      check(actor, options);
      const api = provider(intent.config);
      let dto;
      if (intent.row.provider_id)
        dto = await (intent.row.kind === 'refund'
          ? api.readRefund(intent.row.provider_id)
          : api.readReceipt(intent.row.provider_id));
      else {
        const payment = await api.readPayment(intent.order.provider_payment_id);
        if (!ledger.matched(intent.order, payment) || !payment.succeeded)
          throw Object.assign(fail(409, 'Исходная оплата не подтверждена.'), {
            outcomeUnknown: false,
          });
        check(actor, options);
        const input = {
          paymentId: payment.paymentId,
          amountKopecks: intent.row.amount_kopecks,
          ...(intent.row.kind === 'refund'
            ? { originalAmountKopecks: intent.order.price_kopecks }
            : {}),
          idempotencyKey: intent.row.id,
          receiptEmail: intent.data.receiptEmail,
        };
        dto = await (intent.row.kind === 'refund'
          ? api.createRefund(input)
          : api.createClosingReceipt(input));
      }
      const result = record(intent.row, dto, actor, options);
      check(actor, options);
      return result;
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      transaction(() => {
        const current = load(intent.row.id);
        const payload = open(current.value);
        if (error.outcomeUnknown === false) payload.receiptEmail = null;
        if (!['succeeded', 'canceled', 'rejected'].includes(current.state))
          save(
            current,
            current.provider_id
              ? 'pending'
              : error.outcomeUnknown === false
                ? 'rejected'
                : 'uncertain',
            payload,
          );
      });
      return view(load(intent.row.id));
    }
  }
  async function submit(actor, input, options = {}) {
    ready(actor, options);
    core.fields(input, [
      'requestId',
      'checkoutId',
      'kind',
      'expectedRevision',
      'amountKopecks',
      'receiptEmail',
      'accessPolicy',
      'serviceProvided',
      'reason',
    ]);
    core.identifier(input.requestId);
    core.identifier(input.checkoutId);
    if (
      !['refund', 'receipt'].includes(input.kind) ||
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 3 ||
      input.reason.length > 500 ||
      typeof input.receiptEmail !== 'string' ||
      input.receiptEmail.length > 254 ||
      /[\u0000-\u001f\u007f]/u.test(input.receiptEmail) ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.receiptEmail)
    )
      throw fail(400, 'Укажите действие, причину и почту для чека.');
    const fingerprint = core.fingerprint(input);
    const row = transaction(() => {
      check(actor, options);
      const prior = db
        .prepare('SELECT * FROM billing_financial_actions WHERE actor_id=? AND request_id=?')
        .get(actor, input.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw fail(409, 'Номер финансовой операции уже использован.');
        return prior;
      }
      const order = ledger.load(input.checkoutId);
      if (
        !order ||
        order.paid_confirmed_at === null ||
        order.fulfilled_at === null ||
        order.state !== 'paid'
      )
        throw fail(409, 'Нужен подтверждённый и выданный заказ.');
      const data = ledger.value(order);
      if (
        data.restoredReview ||
        data.reconciliationRequired ||
        data.reviewLock?.leaseUntil > now() ||
        order.lease_until > now() ||
        ledger.revision(order) !== input.expectedRevision
      )
        throw fail(409, 'Сначала сверяйте актуальную версию заказа.');
      if (
        db
          .prepare(
            "SELECT 1 FROM billing_financial_actions WHERE order_id=? AND state IN ('creating','pending','uncertain','review')",
          )
          .get(order.id)
      )
        throw fail(409, 'Дождитесь результата прежней финансовой операции.');
      const refunded = (data.refunds || [])
        .filter((item) => ['pending', 'succeeded'].includes(item.status))
        .reduce((sum, item) => sum + BigInt(item.amountKopecks), 0n);
      let amount = input.amountKopecks,
        revokeAccess = false;
      if (input.kind === 'refund') {
        if (
          !Number.isSafeInteger(amount) ||
          amount < 1 ||
          BigInt(amount) > BigInt(order.price_kopecks) - refunded ||
          !['keep', 'revoke'].includes(input.accessPolicy)
        )
          throw fail(400, 'Укажите допустимую сумму возврата и судьбу доступа.');
        const remaining = BigInt(order.price_kopecks) - refunded - BigInt(amount);
        if (remaining > 0n && (amount < 100 || remaining < 100n))
          throw fail(400, 'Частичный возврат и остаток должны быть не меньше1рубля.');
        revokeAccess = remaining === 0n || input.accessPolicy === 'revoke';
      } else {
        if (
          data.seller.receiptConfig.paymentMode !== 'full_prepayment' ||
          input.serviceProvided !== true ||
          refunded > 0n
        )
          throw fail(
            409,
            'Чек зачёта требует предоплату, подтверждённое оказание и отдельную сверку возвратов.',
          );
        amount = order.price_kopecks;
        if (
          db
            .prepare(
              "SELECT 1 FROM billing_financial_actions WHERE order_id=? AND kind='receipt' AND state NOT IN ('rejected','canceled')",
            )
            .get(order.id)
        )
          throw fail(409, 'Чек зачёта уже создан или ожидает результата.');
      }
      const key = id();
      db.prepare(
        "INSERT INTO billing_financial_actions VALUES(?,?,?,?,?,'creating',?,NULL,?,0,?,?,?)",
      ).run(
        key,
        actor,
        input.requestId,
        order.id,
        input.kind,
        amount,
        fingerprint,
        now(),
        now(),
        seal({ receiptEmail: input.receiptEmail, reason: input.reason.trim(), revokeAccess }),
      );
      return load(key);
    });
    return execute(row, actor, options);
  }
  async function refresh(actor, input, options = {}) {
    ready(actor, options);
    core.fields(input, ['id', 'referenceId', 'reason']);
    core.identifier(input.id);
    let row = load(input.id);
    if (!row) throw fail(404, 'Операция не найдена.');
    if (input.referenceId) {
      if (typeof input.reason !== 'string' || input.reason.trim().length < 3)
        throw fail(400, 'Укажите причину привязки объекта.');
      if (row.provider_id && row.provider_id !== input.referenceId)
        throw fail(409, 'Операция уже связана с другим объектом.');
      const order = ledger.load(row.order_id),
        config = settings.forOrder(order, ledger.value(order).seller);
      if (!config || ledger.value(order).restoredReview)
        throw fail(409, 'Сначала сверяйте магазин и восстановленный заказ.');
      const api = provider(config);
      const dto = await (row.kind === 'refund'
        ? api.readRefund(input.referenceId)
        : api.readReceipt(input.referenceId));
      check(actor, options);
      return record(row, dto, actor, options);
    }
    return execute(row, actor, options);
  }
  async function synchronize(orderId, providerId = null) {
    if (!available() || !settings.publicConfig().ready) return { received: true, ignored: true };
    const row = db
      .prepare(
        "SELECT * FROM billing_financial_actions WHERE order_id=? AND state IN ('pending','uncertain','creating') AND provider_id IS NOT NULL",
      )
      .get(orderId);
    if (!row || (providerId && (row.kind !== 'refund' || row.provider_id !== providerId)))
      return { received: true, ignored: true };
    const order = ledger.load(orderId),
      data = ledger.value(order),
      config = settings.forOrder(order, data.seller);
    if (!config || data.restoredReview)
      return { received: true, ignored: true, reconciliationRequired: true };
    const api = provider(config);
    const dto = await (row.kind === 'refund'
      ? api.readRefund(row.provider_id)
      : api.readReceipt(row.provider_id));
    const result = record(row, dto);
    return { received: true, checkoutId: orderId, status: result.status };
  }
  async function refundWebhook(body) {
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
      throw fail(400, 'Неверное уведомление возврата.');
    }
    if (event?.type !== 'notification' || event.event !== 'refund.succeeded') return null;
    if (
      !available() ||
      typeof event.object?.id !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(event.object.id)
    )
      return { received: true, ignored: true };
    const row = db
      .prepare(
        "SELECT order_id FROM billing_financial_actions WHERE kind='refund' AND provider_id=?",
      )
      .get(event.object.id);
    return row ? synchronize(row.order_id, event.object.id) : { received: true, ignored: true };
  }
  return {
    financialAction: submit,
    refreshFinancialAction: refresh,
    financialActions: list,
    synchronize,
    refundWebhook,
  };
}
module.exports = { createFinancialActions };
