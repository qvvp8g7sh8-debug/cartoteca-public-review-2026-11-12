const { paymentOrderRevision, paymentOrderView } = require('./payment-order-view.cjs');
function createPaymentOrderLedger(core, settings) {
  const {
    db,
    open,
    seal,
    transaction,
    now,
    fail,
    guard,
    ownerIdentity,
    packages,
    admin,
    available,
    identifier,
  } = core;
  const activeStates = "('creating','pending','uncertain','review')";
  const load = (id) => db.prepare('SELECT * FROM billing_payment_orders WHERE id=?').get(id);
  const value = (row) => open(row.value),
    revision = (row) => paymentOrderRevision(value(row));
  const view = (row) => paymentOrderView(row, value(row));
  const adminView = (row) => ({
    ...view(row),
    providerPaymentId: row.provider_payment_id,
    canRetryCreate: false,
    canManageFinance: packages.multipleServices() && settings.publicConfig().ready,
    financialActions: packages.multipleServices()
      ? db
          .prepare(
            'SELECT id,kind,state AS status,amount_kopecks AS amountKopecks,provider_id AS providerId FROM billing_financial_actions WHERE order_id=? ORDER BY created_at DESC,id DESC LIMIT 50',
          )
          .all(row.id)
          .map((value) => ({ ...value }))
      : [],
  });
  function save(row, data, changes = {}) {
    const allowed = [
      'provider_payment_id',
      'provider_status',
      'receipt_status',
      'state',
      'paid_confirmed_at',
      'fulfilled_at',
      'lease_until',
      'lease_id',
    ];
    if (Object.keys(changes).some((key) => !allowed.includes(key)))
      throw Error('Frozen payment fields cannot change.');
    data.revision = revision(row) + 1;
    const names = Object.keys(changes);
    db.prepare(
      'UPDATE billing_payment_orders SET ' +
        names
          .map((name) => name + '=?')
          .concat(['changed_at=?', 'value=?'])
          .join(',') +
        ' WHERE id=?',
    ).run(...names.map((name) => changes[name]), now(), seal(data), row.id);
    return load(row.id);
  }
  function matched(row, dto) {
    return (
      dto &&
      typeof dto.paymentId === 'string' &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(dto.paymentId) &&
      ['pending', 'waiting_for_capture', 'succeeded', 'canceled'].includes(dto.status) &&
      dto.succeeded === (dto.status === 'succeeded') &&
      (!row.provider_payment_id || row.provider_payment_id === dto.paymentId) &&
      dto.currency === 'RUB' &&
      dto.amountKopecks === row.price_kopecks &&
      dto.test === Boolean(row.test_mode) &&
      dto.metadata?.checkoutId === row.id &&
      dto.metadata?.organizationId === row.organization_id
    );
  }
  function applyInTransaction(id, dto, { allowRestored = false } = {}) {
    if (!db.isTransaction) throw Error('Payment application requires a transaction.');
    const row = load(id);
    if (!row || !matched(row, dto))
      throw fail(409, 'Результат платежа не соответствует сохранённому заказу.');
    const data = value(row),
      order = data.order;
    if (data.restoredReview && !allowRestored)
      throw fail(409, 'Восстановленный заказ требует сверки администратором.');
    if (allowRestored) {
      data.restoredReview = false;
      data.reconciliationRequired = false;
    }
    let state = row.state,
      paidAt = row.paid_confirmed_at,
      fulfilledAt = row.fulfilled_at;
    if (dto.succeeded) {
      paidAt = paidAt ?? now();
      if (!fulfilledAt) {
        const prior = db
          .prepare('SELECT 1 FROM billing_package_grants WHERE source_order_id=?')
          .get(id);
        if (
          !settings.forOrder(row, data.seller) ||
          !ownerIdentity(order.organizationId, order.accountId) ||
          (!prior &&
            packages.status(order.organizationId, order.serviceCode || 'voice-assistant').active)
        )
          state = 'review';
        else {
          packages.fulfillPaidOrderInTransaction({ ...order, testMode: Boolean(row.test_mode) });
          fulfilledAt = now();
          state = 'paid';
        }
      } else state = 'paid';
    } else if (paidAt !== null) {
      data.reconciliationRequired = true;
    } else state = dto.status === 'canceled' ? 'canceled' : 'pending';
    data.receiptEmail = null;
    data.confirmationUrl = state === 'pending' ? dto.confirmationUrl : null;
    return view(
      save(row, data, {
        provider_payment_id: dto.paymentId,
        provider_status: dto.status,
        receipt_status: dto.receiptRegistration ?? row.receipt_status,
        state,
        paid_confirmed_at: paidAt,
        fulfilled_at: fulfilledAt,
        lease_until: 0,
        lease_id: null,
      }),
    );
  }
  function apply(id, dto, current, assertCurrent) {
    return transaction(() => {
      if (current) guard(current, assertCurrent);
      return applyInTransaction(id, dto);
    });
  }
  function failed(id, leaseId, error, current, assertCurrent) {
    return transaction(() => {
      guard(current, assertCurrent);
      const row = load(id);
      if (!row || row.provider_payment_id || row.lease_id !== leaseId)
        return row ? view(row) : null;
      const data = value(row);
      if (data.restoredReview) return view(row);
      const state = error.outcomeUnknown ? 'uncertain' : 'rejected';
      if (state === 'rejected') data.receiptEmail = null;
      return view(save(row, data, { state, lease_until: 0, lease_id: null }));
    });
  }
  const reporting = require('./payment-reporting.cjs').createPaymentReporting(core, { adminView });

  return {
    load,
    value,
    view,
    adminView,
    revision,
    save,
    matched,
    apply,
    applyInTransaction,
    failed,
    ...reporting,
    activeStates,
  };
}
module.exports = { createPaymentOrderLedger };
