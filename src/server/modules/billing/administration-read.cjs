const { fail } = require('../../../shared/errors.cjs');
function createBillingReadModel(context, wallet, entitlements, packages, payments) {
  const { db, open } = context;
  const now = typeof context.now === 'function' ? context.now : Date.now;
  function assertAdmin(actorId) {
    if (
      typeof actorId !== 'string' ||
      !db
        .prepare("SELECT 1 FROM accounts WHERE id=? AND global_admin=1 AND status='active'")
        .get(actorId)
    )
      throw fail(403, 'Пакеты и расходы доступны только главному администратору.');
  }
  function available() {
    return entitlements.available() && payments.available();
  }
  function unavailable() {
    return {
      available: false,
      reason: 'Пакеты и платежи доступны после отдельной подготовки схемы19. Приём оплат отключён.',
    };
  }
  function organization(id) {
    if (typeof id !== 'string' || !id || id.length > 128) throw fail(400, 'Неверный кабинет.');
    const row = db.prepare('SELECT id,value FROM organizations WHERE id=?').get(id);
    if (!row) throw fail(404, 'Кабинет не найден.');
    return row;
  }
  function counts(organizationId = null) {
    const clock = now(),
      scope = organizationId === null ? '' : ' AND g.organization_id=?';
    return db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN source='trial' THEN 1 ELSE 0 END),0) trials,
      COALESCE(SUM(CASE WHEN starts_at<=? AND ends_at>? AND EXISTS(
        SELECT 1 FROM organizations o JOIN subscriptions s ON s.organization_id=o.id
        WHERE o.id=g.organization_id AND o.status='active' AND s.status='active'
      ) ${packages.multipleServices() ? 'AND NOT EXISTS(SELECT 1 FROM billing_grant_revocations r WHERE r.grant_id=g.id)' : ''} THEN 1 ELSE 0 END),0) active FROM billing_package_grants g WHERE 1=1` +
          scope,
      )
      .get(clock, clock, ...(organizationId === null ? [] : [organizationId]));
  }
  function summary(actorId, organizationId = null) {
    assertAdmin(actorId);
    if (!available()) return unavailable();
    const row = organizationId === null ? null : organization(organizationId),
      count = counts(organizationId),
      totals = wallet.totals(organizationId),
      revenue = payments.adminRevenue(actorId, organizationId),
      serviceTotals = payments.serviceRevenues(actorId, organizationId),
      refunded = serviceTotals.reduce((sum, item) => sum + BigInt(item.refundedKopecks), 0n);
    return {
      available: true,
      summary: {
        paidRevenueRub: revenue.paidRevenueRub,
        paidRevenueKopecks: revenue.paidRevenueKopecks,
        refundedKopecks: String(refunded),
        netPaidKopecks: String(BigInt(revenue.paidRevenueKopecks) - refunded),
        providerCostRub: totals.providerCostRub,
        providerCostMicrorub: String(totals.providerCostMicrorub),
        trialGrants: count.trials,
        activePackages: count.active,
        uncertainCalls: totals.uncertainCalls,
        pendingReservations: totals.pendingReservations,
        estimated: true,
      },
      serviceTotals,
      periodLabel: 'С начала учёта пакетов',
      scope: row
        ? { type: 'organization', organizationId: row.id, name: open(row.value).name }
        : { type: 'platform' },
    };
  }
  function organizationRow(row, revenue) {
    return {
      organizationId: row.id,
      organizationName: open(row.value).name,
      subscription: packages.status(row.id),
      subscriptions: packages.services().map((service) => ({
        ...packages.status(row.id, service.code),
        enabled: entitlements.isServiceEnabled(row.id, service.code),
      })),
      enabled: entitlements.isServiceEnabled(row.id),
      costRub: wallet.getWallet(row.id).providerCostRub,
      costMicrorub: String(wallet.getWallet(row.id).providerCostMicrorub),
      paidRub: revenue?.paidRevenueRub || 0,
      paidKopecks: revenue?.paidRevenueKopecks || '0',
      estimated: true,
    };
  }
  const orderView = (item) => ({
    ...item,
    title: item.package?.title,
    priceKopecks: item.package?.priceKopecks,
  });
  function organizations(actorId, input = {}) {
    assertAdmin(actorId);
    if (!available()) return { ...unavailable(), organizations: [], nextOffset: null, total: 0 };
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'offset')
    )
      throw fail(400, 'Неверные параметры списка кабинетов.');
    const offset = Number(input.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw fail(400, 'Неверная страница кабинетов.');
    const rows = db
        .prepare(
          'SELECT id,value FROM organizations ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ?',
        )
        .all(offset),
      selected = rows.slice(0, 20),
      revenue = payments.organizationRevenues(
        actorId,
        selected.map((row) => row.id),
      );
    return {
      available: true,
      organizations: selected.map((row) => organizationRow(row, revenue.get(row.id))),
      nextOffset: rows.length > 20 ? offset + 20 : null,
      total: db.prepare('SELECT count(*) n FROM organizations').get().n,
    };
  }
  function orders(actorId, input = {}) {
    assertAdmin(actorId);
    if (input?.organizationId) organization(input.organizationId);
    const page = payments.adminOrders(actorId, input);
    return { ...page, orders: page.orders.map(orderView) };
  }
  function view(actorId, params = {}) {
    assertAdmin(actorId);
    if (!available()) return unavailable();
    if (
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      Object.keys(params).some((key) => !['organizationId', 'offset'].includes(key))
    )
      throw fail(400, 'Неверные параметры финансового раздела.');
    const organizationId = params.organizationId || null,
      result = summary(actorId, organizationId),
      config = payments.config(actorId),
      catalog = packages.adminCatalog(actorId),
      page = orders(actorId, organizationId === null ? {} : { organizationId });
    const common = {
      ...result,
      catalogRevision: Math.max(0, ...catalog.map((item) => item.version)),
      configured: config.ready,
      packages: catalog,
      services: packages.services(),
      multipleServices: packages.multipleServices(),
      paymentConfiguration: config,
      orders: page.orders,
      ordersNextCursor: page.nextCursor,
    };
    if (organizationId !== null) {
      const row = organization(organizationId),
        revenue = payments.adminRevenue(actorId, organizationId);
      return {
        ...common,
        organizationId,
        subscriptions: packages.services().map((service) => ({
          ...packages.status(organizationId, service.code),
          enabled: entitlements.isServiceEnabled(organizationId, service.code),
        })),
        organization: { id: row.id, name: open(row.value).name },
        organizations: [organizationRow(row, revenue)],
        organizationTotal: 1,
        nextOffset: null,
      };
    }
    const organizationPage = organizations(
      actorId,
      params.offset === undefined ? {} : { offset: params.offset },
    );
    return {
      ...common,
      organizations: organizationPage.organizations,
      nextOffset: organizationPage.nextOffset,
      organizationTotal: organizationPage.total,
    };
  }
  return { assertAdmin, view, summary, organizations, orders };
}
module.exports = { createBillingReadModel };
