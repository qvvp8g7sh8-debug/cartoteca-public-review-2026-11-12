function createPackageCatalog(core, services) {
  const { db, ready, available, admin, fail, identifier, operation, audit, now } = core;
  const view = (row, privateView = false) => ({
    id: row.id,
    title: row.title,
    priceKopecks: row.price_kopecks,
    taskLimit: row.task_limit,
    enabled: Boolean(row.enabled),
    version: row.revision,
    serviceCode: row.service_code || 'voice-assistant',
    serviceTitle: services.title(row.service_code || 'voice-assistant'),
    periodMonths: row.period_months || 1,
    quotaUnit: row.quota_unit || 'tasks',
    ...(privateView ? { receipt: JSON.parse(row.receipt_json || '{}') } : {}),
  });
  function catalog() {
    if (!available()) return [];
    return db
      .prepare(
        'SELECT * FROM billing_package_definitions WHERE enabled=1 ORDER BY price_kopecks,id LIMIT 100',
      )
      .all()
      .map((row) => view(row));
  }
  function adminCatalog(actorId) {
    ready();
    admin(actorId);
    return db
      .prepare('SELECT * FROM billing_package_definitions ORDER BY id LIMIT 100')
      .all()
      .map((row) => view(row, true));
  }
  function definition(packageId) {
    identifier(packageId, 'пакет');
    const row = db.prepare('SELECT * FROM billing_package_definitions WHERE id=?').get(packageId);
    if (!row) throw fail(404, 'Пакет не найден.');
    return view(row, true);
  }
  function savePackage(actorId, input) {
    ready();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'id',
            'title',
            'priceKopecks',
            'taskLimit',
            'serviceCode',
            'serviceTitle',
            'periodMonths',
            'quotaUnit',
            'receipt',
            'enabled',
            'expectedRevision',
            'requestId',
            'reason',
          ].includes(key),
      )
    )
      throw fail(400, 'Неверные поля пакета.');
    identifier(input.id, 'пакет');
    const priorDefinition = db
      .prepare('SELECT * FROM billing_package_definitions WHERE id=?')
      .get(input.id);
    const service = require('./service-catalog.cjs').serviceCode(
      input.serviceCode ?? priorDefinition?.service_code,
    );
    const period = input.periodMonths ?? priorDefinition?.period_months ?? 1;
    const unit = input.quotaUnit ?? priorDefinition?.quota_unit ?? 'tasks';
    const receipt = input.receipt ?? JSON.parse(priorDefinition?.receipt_json || '{}');
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      Object.keys(receipt).some(
        (key) => !['paymentMode', 'paymentSubject', 'vatCode', 'description'].includes(key),
      ) ||
      (receipt.paymentMode != null &&
        !['', 'full_payment', 'full_prepayment'].includes(receipt.paymentMode)) ||
      (receipt.paymentSubject != null &&
        !['', 'payment', 'service', 'property_right', 'intellectual_activity'].includes(
          receipt.paymentSubject,
        )) ||
      (receipt.vatCode != null &&
        (!Number.isInteger(receipt.vatCode) || receipt.vatCode < 1 || receipt.vatCode > 12)) ||
      (receipt.description != null &&
        (typeof receipt.description !== 'string' ||
          receipt.description.length > 128 ||
          /[\u0000-\u001f]/u.test(receipt.description)))
    )
      throw fail(400, 'Проверьте данные чека для пакета.');
    if (!services.multiple() && Object.keys(receipt).length)
      throw fail(503, 'Индивидуальные параметры чека требуют схемы20.');
    if (unit === 'access' && input.taskLimit !== 1)
      throw fail(400, 'Пакет доступа не использует счётчик: значение лимита должно быть1.');
    if (
      !Number.isInteger(period) ||
      period < 1 ||
      period > 36 ||
      !['tasks', 'units', 'access'].includes(unit) ||
      (service === 'voice-assistant' && (unit !== 'tasks' || period !== 1))
    )
      throw fail(400, 'Укажите срок и единицы пакета; помощник использует месячный пакет задач.');
    if (priorDefinition && service !== (priorDefinition.service_code || 'voice-assistant'))
      throw fail(409, 'Услугу существующего пакета менять нельзя. Создайте другой пакет.');
    if (!services.multiple() && (period !== 1 || unit !== 'tasks'))
      throw fail(503, 'Новые виды пакетов требуют отдельной подготовки схемы20.');
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id) ||
      typeof input.title !== 'string' ||
      input.title.trim().length < 1 ||
      input.title.trim().length > 120 ||
      !Number.isSafeInteger(input.priceKopecks) ||
      input.priceKopecks < 0 ||
      !Number.isSafeInteger(input.taskLimit) ||
      input.taskLimit < 0 ||
      input.taskLimit > 1000000 ||
      typeof input.enabled !== 'boolean' ||
      (input.enabled && (input.priceKopecks === 0 || input.taskLimit === 0)) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw fail(400, 'Укажите название, фиксированную цену и количество задач пакета.');
    return operation(actorId, input, { kind: 'package-definition', ...input }, () => {
      const prior = db
        .prepare('SELECT revision FROM billing_package_definitions WHERE id=?')
        .get(input.id);
      if (!prior && db.prepare('SELECT count(*) n FROM billing_package_definitions').get().n >= 100)
        throw fail(400, 'Достигнуто ограничение количества пакетов.');
      if ((prior?.revision || 0) !== input.expectedRevision)
        throw fail(409, 'Пакет изменился. Обновите раздел.');
      const before = prior ? definition(input.id) : {};
      services.ensure(service, input.serviceTitle);
      db.prepare(
        `INSERT INTO billing_package_definitions(id,title,price_kopecks,task_limit,enabled,revision,changed_at${services.multiple() ? ',service_code' : ''}) VALUES(?,?,?,?,?,?,?${services.multiple() ? ',?' : ''}) ON CONFLICT(id) DO UPDATE SET title=excluded.title,price_kopecks=excluded.price_kopecks,task_limit=excluded.task_limit,enabled=excluded.enabled,revision=excluded.revision,changed_at=excluded.changed_at`,
      ).run(
        input.id,
        input.title.trim(),
        input.priceKopecks,
        input.taskLimit,
        Number(input.enabled),
        (prior?.revision || 0) + 1,
        now(),
        ...(services.multiple() ? [service] : []),
      );
      if (services.multiple())
        db.prepare(
          'UPDATE billing_package_definitions SET service_code=?,period_months=?,quota_unit=?,receipt_json=? WHERE id=?',
        ).run(service, period, unit, JSON.stringify(receipt), input.id);
      audit('billing_package_saved', actorId, null, {
        targetId: input.id,
        reason: input.reason,
        operationId: input.requestId,
        before: { ...before, receiptPolicy: JSON.stringify(before.receipt || {}) },
        after: { ...definition(input.id), receiptPolicy: JSON.stringify(receipt) },
      });
      return definition(input.id);
    });
  }
  return { catalog, adminCatalog, savePackage, definition };
}
module.exports = { createPackageCatalog };
