const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function createPaymentReporting(core, { adminView }) {
  const { db, admin, available, identifier, fail, now } = core;
  function revenue(organizationId = null) {
    const scope = organizationId === null ? '' : ' AND organization_id=?';
    let total = 0n;
    for (const row of db
      .prepare(
        'SELECT price_kopecks FROM billing_payment_orders WHERE paid_confirmed_at IS NOT NULL AND test_mode=0' +
          scope,
      )
      .iterate(...(organizationId === null ? [] : [organizationId])))
      total += BigInt(row.price_kopecks);
    return { paidRevenueRub: Number(total) / 100, paidRevenueKopecks: total.toString() };
  }
  function adminRevenue(actorId, organizationId = null) {
    admin(actorId);
    if (!available()) return { available: false, paidRevenueRub: null, paidRevenueKopecks: null };
    if (organizationId !== null) identifier(organizationId);
    return { available: true, ...revenue(organizationId) };
  }
  function organizationRevenues(actorId, ids) {
    admin(actorId);
    if (!Array.isArray(ids) || ids.length > 20) throw fail(400, 'Неверная порция кабинетов.');
    const totals = new Map(ids.map((id) => [identifier(id), 0n]));
    if (!available() || !ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    for (const row of db
      .prepare(
        'SELECT organization_id,price_kopecks FROM billing_payment_orders WHERE test_mode=0 AND paid_confirmed_at IS NOT NULL AND organization_id IN (' +
          placeholders +
          ')',
      )
      .iterate(...ids))
      totals.set(row.organization_id, totals.get(row.organization_id) + BigInt(row.price_kopecks));
    return new Map(
      [...totals].map(([id, total]) => [
        id,
        { paidRevenueRub: Number(total) / 100, paidRevenueKopecks: total.toString() },
      ]),
    );
  }
  function serviceRevenues(actorId, organizationId = null) {
    admin(actorId);
    if (!available()) return [];
    if (organizationId !== null) identifier(organizationId);
    const totals = new Map(
      core.packages
        .services()
        .map((service) => [
          service.code,
          { ...service, paid: 0n, refunded: 0n, cost: 0n, costCount: 0 },
        ]),
    );
    const scope = organizationId === null ? '' : ' AND organization_id=?';
    for (const row of db
      .prepare(
        'SELECT * FROM billing_payment_orders WHERE test_mode=0 AND paid_confirmed_at IS NOT NULL' +
          scope,
      )
      .iterate(...(organizationId === null ? [] : [organizationId]))) {
      const item = totals.get(row.service_code || 'voice-assistant');
      if (!item) continue;
      item.paid += BigInt(row.price_kopecks);
      for (const refund of core.open(row.value).refunds || [])
        if (refund.status === 'succeeded') item.refunded += BigInt(refund.amountKopecks);
    }
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_entries'").get()
    )
      for (const row of db
        .prepare(
          "SELECT service,amount_microrub FROM billing_entries WHERE kind='expense' AND wallet_id='platform'" +
            scope,
        )
        .iterate(...(organizationId === null ? [] : [organizationId]))) {
        const item = totals.get(row.service);
        if (item) {
          item.cost -= BigInt(row.amount_microrub);
          item.costCount++;
        }
      }
    return [...totals.values()].map((item) => ({
      code: item.code,
      title: item.title,
      paidRevenueKopecks: String(item.paid),
      refundedKopecks: String(item.refunded),
      netPaidKopecks: String(item.paid - item.refunded),
      providerCostMicrorub:
        item.costCount || item.code === 'voice-assistant' ? String(item.cost) : null,
    }));
  }
  function requiresAttention(row) {
    if (
      ['uncertain', 'review'].includes(row.state) ||
      (row.state === 'creating' && row.lease_until <= now())
    )
      return true;
    const data = core.open(row.value);
    return Boolean(
      data.restoredReview ||
      data.reconciliationRequired ||
      data.refundReview ||
      data.receiptReview ||
      ['blocked', 'required', 'manual_review'].includes(data.reconciliation?.status),
    );
  }
  function adminOrders(actorId, input = {}) {
    admin(actorId);
    if (!available()) return { available: false, orders: [], nextCursor: null };
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !['organizationId', 'before', 'status', 'q', 'serviceCode'].includes(key),
      )
    )
      throw fail(400, 'Неверные параметры истории оплат.');
    const clauses = ['1=1'],
      args = [];
    if (input.organizationId) {
      clauses.push('organization_id=?');
      args.push(identifier(input.organizationId));
    }
    if (input.serviceCode) {
      const service = require('./service-catalog.cjs').serviceCode(input.serviceCode);
      if (core.packages.multipleServices()) {
        clauses.push('service_code=?');
        args.push(service);
      } else if (service !== 'voice-assistant')
        return { available: true, orders: [], nextCursor: null };
    }
    const status = input.status || 'all';
    if (!['all', 'attention', 'pending', 'paid', 'canceled', 'rejected'].includes(status))
      throw fail(400, 'Выберите состояние оплаты.');
    if (status === 'pending') clauses.push("state IN ('creating','pending')");
    else if (status === 'paid') clauses.push('paid_confirmed_at IS NOT NULL');
    else if (status !== 'all' && status !== 'attention') {
      clauses.push('state=?');
      args.push(status);
    }
    const q = input.q == null ? '' : input.q;
    if (typeof q !== 'string' || (q.trim() && !UUID.test(q.trim())))
      throw fail(400, 'Введите полный номер заказа или платежа.');
    if (q.trim()) {
      clauses.push('(id=? OR provider_payment_id=?)');
      args.push(q.trim().toLowerCase(), q.trim().toLowerCase());
    }
    if (input.before) {
      if (typeof input.before !== 'string') throw fail(400, 'Неверная страница оплат.');
      const match = /^(\d{1,16}):([A-Za-z0-9_-]{1,120})$/.exec(input.before);
      if (!match || !Number.isSafeInteger(Number(match[1])))
        throw fail(400, 'Неверная страница оплат.');
      clauses.push('(created_at<? OR (created_at=? AND id<?))');
      args.push(Number(match[1]), Number(match[1]), match[2]);
    }
    const scanLimit = status === 'attention' ? 200 : 50;
    const rows = db
      .prepare(
        'SELECT * FROM billing_payment_orders WHERE ' +
          clauses.join(' AND ') +
          ' ORDER BY created_at DESC,id DESC LIMIT ?',
      )
      .all(...args, scanLimit + 1);
    const selected = [];
    let scanned = 0,
      last = null;
    for (const row of rows.slice(0, scanLimit)) {
      scanned++;
      last = row;
      if (status !== 'attention' || requiresAttention(row)) selected.push(row);
      if (selected.length === 50) break;
    }
    const hasMore = rows.length > scanned;
    return {
      available: true,
      orders: selected.map((row) => ({ ...adminView(row), organizationId: row.organization_id })),
      nextCursor: hasMore && last ? last.created_at + ':' + last.id : null,
    };
  }
  function adminSummary(actorId, organizationId = null) {
    const result = adminRevenue(actorId, organizationId);
    return {
      ...result,
      ...adminOrders(actorId, organizationId === null ? {} : { organizationId }),
    };
  }
  return { adminSummary, adminRevenue, adminOrders, organizationRevenues, serviceRevenues };
}
module.exports = { createPaymentReporting };
