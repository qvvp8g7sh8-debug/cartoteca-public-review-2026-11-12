function createPackageGrants(core, catalog, services) {
  const {
    db,
    ready,
    available,
    requireOrganization,
    organizationActive,
    fail,
    identifier,
    operation,
    audit,
    now,
    id,
    calendarMonthEnd,
    bindCredential,
  } = core;
  function view(row) {
    if (!row)
      return {
        active: false,
        packageId: null,
        title: null,
        source: null,
        startsAt: null,
        endsAt: null,
        taskLimit: 0,
        usedTasks: 0,
        reservedTasks: 0,
        remainingTasks: 0,
      };
    const counts = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN state IN ('accepted','uncertain') THEN 1 ELSE 0 END),0) used,COALESCE(SUM(CASE WHEN state='reserved' THEN 1 ELSE 0 END),0) reserved FROM billing_package_tasks WHERE grant_id=?`,
      )
      .get(row.id);
    const active =
      row.starts_at <= now() &&
      row.ends_at > now() &&
      organizationActive(row.organization_id) &&
      (!services.multiple() ||
        !db.prepare('SELECT 1 FROM billing_grant_revocations WHERE grant_id=?').get(row.id));
    return {
      active,
      serviceCode: row.service_code || 'voice-assistant',
      serviceTitle: services.title(row.service_code || 'voice-assistant'),
      periodMonths: row.period_months || 1,
      quotaUnit: row.quota_unit || 'tasks',
      grantId: row.id,
      packageId: row.package_id,
      packageVersion: row.package_version,
      title: row.title,
      source: row.source,
      testMode: Boolean(row.test_mode),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      taskLimit: row.task_limit,
      usedTasks: counts.used,
      reservedTasks: counts.reserved,
      remainingTasks: active ? Math.max(0, row.task_limit - counts.used - counts.reserved) : 0,
    };
  }
  function activeRow(orgId, service = 'voice-assistant') {
    require('./service-catalog.cjs').serviceCode(service);
    if (!services.multiple() && service !== 'voice-assistant') return null;
    return db
      .prepare(
        `SELECT * FROM billing_package_grants WHERE organization_id=? AND starts_at<=? AND ends_at>?${services.multiple() ? ' AND service_code=? AND NOT EXISTS(SELECT 1 FROM billing_grant_revocations r WHERE r.grant_id=billing_package_grants.id)' : ''} ORDER BY starts_at DESC,id DESC LIMIT 1`,
      )
      .get(orgId, now(), now(), ...(services.multiple() ? [service] : []));
  }
  function status(orgId, service = 'voice-assistant') {
    require('./service-catalog.cjs').serviceCode(service);
    if (!services.multiple() && service !== 'voice-assistant')
      return { ...view(null), serviceCode: service, available: false };
    identifier(orgId, 'кабинет');
    if (!available()) return { ...view(null), available: false };
    const row =
      activeRow(orgId, service) ||
      db
        .prepare(
          `SELECT * FROM billing_package_grants WHERE organization_id=?${services.multiple() ? ' AND service_code=?' : ''} ORDER BY starts_at DESC,id DESC LIMIT 1`,
        )
        .get(orgId, ...(services.multiple() ? [service] : []));
    return {
      ...view(row),
      serviceCode: service,
      serviceTitle: services.title(service),
      available: true,
    };
  }
  function insertGrant({
    organizationId,
    definition,
    source,
    sourceOrderId = null,
    actorId = null,
    testMode = false,
    reason = '',
    operationId = null,
  }) {
    requireOrganization(organizationId);
    const service = definition.serviceCode || 'voice-assistant',
      months = definition.periodMonths || 1,
      unit = definition.quotaUnit || 'tasks';
    if (
      source === 'trial' &&
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='billing_payment_orders'`)
        .get() &&
      db
        .prepare(
          `SELECT 1 FROM billing_payment_orders WHERE organization_id=?${services.multiple() ? ' AND service_code=?' : ''} AND state IN ('creating','pending','uncertain','review') LIMIT 1`,
        )
        .get(organizationId, ...(services.multiple() ? [service] : []))
    )
      throw fail(409, 'У кабинета есть незавершённая оплата. Сначала проверьте её результат.');
    if (activeRow(organizationId, service))
      throw fail(
        409,
        'Пакет уже действует. Новый пакет можно купить после окончания текущего месяца.',
      );
    const starts = now(),
      grantId = id();
    db.prepare(
      `INSERT INTO billing_package_grants(id,organization_id,package_id,package_version,title,source,source_order_id,price_kopecks,task_limit,starts_at,ends_at,actor_id,created_at,test_mode${services.multiple() ? ',service_code,period_months,quota_unit' : ''}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?${services.multiple() ? ',?,?,?' : ''})`,
    ).run(
      grantId,
      organizationId,
      definition.id,
      definition.version,
      definition.title,
      source,
      sourceOrderId,
      source === 'trial' ? 0 : definition.priceKopecks,
      definition.taskLimit,
      starts,
      calendarMonthEnd(starts, months),
      actorId,
      starts,
      Number(testMode),
      ...(services.multiple() ? [service, months, unit] : []),
    );
    bindCredential(organizationId, grantId, actorId, service);
    audit(
      source === 'trial' ? 'billing_package_trial_granted' : 'billing_package_paid_granted',
      actorId,
      organizationId,
      {
        targetId: grantId,
        reason,
        operationId,
        before: {},
        after: {
          grantId,
          serviceCode: service,
          periodMonths: months,
          quotaUnit: unit,
          packageId: definition.id,
          packageVersion: definition.version,
          title: definition.title,
          sourceOrderId,
          source,
          priceKopecks: source === 'trial' ? 0 : definition.priceKopecks,
          taskLimit: definition.taskLimit,
          startsAt: starts,
          endsAt: calendarMonthEnd(starts, months),
          testMode,
        },
      },
    );
    return view(db.prepare('SELECT * FROM billing_package_grants WHERE id=?').get(grantId));
  }
  function grantTrial(actorId, input) {
    ready();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['orgId', 'packageId', 'requestId', 'reason'].includes(key))
    )
      throw fail(400, 'Неверные поля пробного пакета.');
    return operation(actorId, input, { kind: 'package-trial', ...input }, () => {
      const definition = catalog.definition(input.packageId);
      if (definition.taskLimit < 1)
        throw fail(400, 'Укажите количество задач перед выдачей пробного пакета.');
      return insertGrant({
        organizationId: input.orgId,
        definition,
        source: 'trial',
        actorId,
        reason: input.reason,
        operationId: input.requestId,
      });
    });
  }
  function fulfillPaidOrderInTransaction(order) {
    ready();
    if (!db.isTransaction)
      throw Error('A verified package order requires an existing SQL transaction.');
    if (!order || typeof order !== 'object' || Array.isArray(order))
      throw fail(400, 'Нужен проверенный заказ пакета.');
    identifier(order.id, 'заказ');
    identifier(order.organizationId, 'кабинет');
    identifier(order.packageId, 'пакет');
    const prior = db
      .prepare('SELECT * FROM billing_package_grants WHERE source_order_id=?')
      .get(order.id);
    if (prior) {
      if (
        (prior.service_code || 'voice-assistant') !== (order.serviceCode || 'voice-assistant') ||
        (prior.period_months || 1) !== (order.periodMonths || 1) ||
        (prior.quota_unit || 'tasks') !== (order.quotaUnit || 'tasks') ||
        prior.organization_id !== order.organizationId ||
        prior.package_id !== order.packageId ||
        prior.package_version !== order.packageVersion ||
        prior.price_kopecks !== order.priceKopecks ||
        prior.task_limit !== order.taskLimit ||
        prior.title !== order.title ||
        Boolean(prior.test_mode) !== Boolean(order.testMode)
      )
        throw fail(409, 'Подтверждённый заказ не соответствует уже выданному пакету.');
      return { ...view(prior), replayed: true };
    }
    catalog.definition(order.packageId);
    if (
      !Number.isSafeInteger(order.packageVersion) ||
      order.packageVersion < 1 ||
      typeof order.title !== 'string' ||
      order.title.length < 1 ||
      order.title.length > 120 ||
      !Number.isSafeInteger(order.priceKopecks) ||
      order.priceKopecks <= 0 ||
      !Number.isSafeInteger(order.taskLimit) ||
      order.taskLimit < 1 ||
      order.taskLimit > 1000000
    )
      throw fail(400, 'Неверные подтверждённые условия заказа.');
    return insertGrant({
      organizationId: order.organizationId,
      definition: {
        id: order.packageId,
        serviceCode: order.serviceCode || 'voice-assistant',
        periodMonths: order.periodMonths || 1,
        quotaUnit: order.quotaUnit || 'tasks',
        version: order.packageVersion,
        title: order.title,
        priceKopecks: order.priceKopecks,
        taskLimit: order.taskLimit,
      },
      source: 'paid',
      sourceOrderId: order.id,
      testMode: order.testMode === true,
    });
  }
  function fulfillPaidOrder(order) {
    return core.transaction(() => fulfillPaidOrderInTransaction(order));
  }
  function revokeOrder(orderId, referenceId) {
    if (!db.isTransaction || !services.multiple())
      throw Error('Verified reversal requires a schema20 transaction.');
    const grant = db
      .prepare('SELECT id FROM billing_package_grants WHERE source_order_id=?')
      .get(orderId);
    if (grant)
      db.prepare('INSERT OR IGNORE INTO billing_grant_revocations VALUES(?,?,?)').run(
        grant.id,
        referenceId,
        now(),
      );
  }
  return {
    status,
    activeRow,
    view,
    grantTrial,
    fulfillPaidOrder,
    fulfillPaidOrderInTransaction,
    revokeOrder,
  };
}
module.exports = { createPackageGrants };
