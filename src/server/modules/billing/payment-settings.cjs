const { createYooKassaProvider } = require('./yookassa-provider.cjs');
function createPaymentSettings(core) {
  const {
    db,
    seal,
    open,
    transaction,
    now,
    fail,
    available,
    ready,
    admin,
    fields,
    identifier,
    fingerprint,
    audit,
  } = core;
  const emptyReceipt = () => ({
    fiscalProvider: '',
    purchaseModel: 'package',
    paymentMode: '',
    vatCode: null,
    taxSystemCode: null,
    paymentSubject: '',
    description: '',
  });
  function internal() {
    const row = available()
      ? db.prepare('SELECT * FROM billing_payment_settings WHERE id=1').get()
      : null;
    return row
      ? { ...open(row.value), revision: row.revision, configured: Boolean(row.configured) }
      : {
          revision: 0,
          configured: false,
          shopId: '',
          secretKey: null,
          returnOrigin: '',
          testMode: true,
          receiptConfig: emptyReceipt(),
        };
  }
  function validateReceipt(receipt) {
    fields(receipt, Object.keys(emptyReceipt()));
    if (receipt.purchaseModel !== 'package')
      throw fail(400, 'Оплата доступна только для определённых пакетов.');
    for (const [key, allowed] of Object.entries({
      fiscalProvider: ['external', 'yookassa'],
      paymentMode: ['full_payment', 'full_prepayment'],
      paymentSubject: ['payment', 'service', 'property_right', 'intellectual_activity'],
    }))
      if (receipt[key] !== '' && !allowed.includes(receipt[key]))
        throw fail(400, 'Выберите поддерживаемые параметры чека.');
    for (const [key, max] of [
      ['vatCode', 12],
      ['taxSystemCode', 6],
    ])
      if (
        receipt[key] !== null &&
        (!Number.isInteger(receipt[key]) || receipt[key] < 1 || receipt[key] > max)
      )
        throw fail(
          400,
          'Укажите код НДС и систему налогообложения либо оставьте черновик незаполненным.',
        );
    if (
      typeof receipt.description !== 'string' ||
      receipt.description.length > 128 ||
      /[\u0000-\u001f]/u.test(receipt.description)
    )
      throw fail(400, 'Проверьте описание позиции чека.');
  }
  function validate(value) {
    if (
      typeof value.configured !== 'boolean' ||
      typeof value.testMode !== 'boolean' ||
      typeof value.shopId !== 'string' ||
      (value.shopId !== '' && !/^\d{1,32}$/.test(value.shopId)) ||
      /[\u0000-\u001f]/u.test(value.shopId) ||
      typeof value.returnOrigin !== 'string' ||
      value.returnOrigin.length > 2048
    )
      throw fail(400, 'Проверьте параметры подключения оплаты.');
    validateReceipt(value.receiptConfig);
    if (value.returnOrigin) {
      let url;
      try {
        url = new URL(value.returnOrigin);
      } catch {
        throw fail(400, 'Нужен HTTPS-адрес картотеки.');
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        /\s/u.test(value.returnOrigin)
      )
        throw fail(400, 'Укажите только HTTPS-адрес картотеки без пути и параметров.');
    }
    if (
      value.secretKey !== null &&
      (typeof value.secretKey !== 'string' ||
        !/^[!-~]{12,512}$/.test(value.secretKey) ||
        /[\u0000-\u001f]/u.test(value.secretKey))
    )
      throw fail(400, 'Проверьте секретный ключ магазина.');
    if (value.configured) createYooKassaProvider({ ...value, receiptConfig: value.receiptConfig });
  }
  function sanitized(value) {
    let usable = false;
    if (available() && value.configured) {
      try {
        validate(value);
        usable = true;
      } catch {}
    }
    return {
      configured: value.configured,
      revision: value.revision,
      shopId: value.shopId,
      secretConfigured: Boolean(value.secretKey),
      returnOrigin: value.returnOrigin,
      receiptConfig: { ...value.receiptConfig },
      testMode: value.testMode,
      ready: usable,
      securityNotice:
        'Удаление ключа здесь не отзывает его в ЮKassa. Для немедленного отзыва удалите ключ в личном кабинете провайдера.',
      notice: usable
        ? value.testMode
          ? 'Подключён тестовый магазин. Реальная оплата не принимается.'
          : 'Оплата пакетов подключена.'
        : 'Приём оплаты выключен. Заполните параметры магазина, кассы и чека.',
    };
  }
  function config(actorId) {
    admin(actorId);
    return sanitized(internal());
  }
  function publicConfig() {
    const view = sanitized(internal());
    return { ready: view.ready, notice: view.notice, testMode: view.testMode };
  }
  function adminSettings(actorId, input) {
    ready();
    admin(actorId);
    fields(input, [
      'configured',
      'shopId',
      'secretKey',
      'clearSecret',
      'returnOrigin',
      'receiptConfig',
      'testMode',
      'expectedRevision',
      'reason',
      'requestId',
    ]);
    identifier(input.requestId);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      typeof input.reason !== 'string' ||
      input.reason.trim().length < 3 ||
      input.reason.trim().length > 500 ||
      (input.clearSecret !== undefined && typeof input.clearSecret !== 'boolean') ||
      (input.clearSecret && input.secretKey !== undefined) ||
      (input.configured && typeof input.testMode !== 'boolean')
    )
      throw fail(400, 'Укажите версию настроек и причину изменения.');
    const digest = fingerprint(input);
    return transaction(() => {
      admin(actorId);
      const prior = db
        .prepare(
          'SELECT fingerprint FROM billing_payment_operations WHERE actor_id=? AND request_id=?',
        )
        .get(actorId, input.requestId);
      if (prior) {
        if (prior.fingerprint !== digest)
          throw fail(409, 'Номер операции уже использован с другими параметрами.');
        return config(actorId);
      }
      const before = internal();
      if (before.revision !== input.expectedRevision)
        throw fail(409, 'Настройки оплаты изменились. Обновите раздел.');
      const value = {
        configured: input.clearSecret ? false : input.configured,
        shopId: input.shopId,
        returnOrigin: input.returnOrigin,
        testMode: input.testMode ?? before.testMode,
        receiptConfig: { ...input.receiptConfig },
        secretKey: input.clearSecret
          ? null
          : input.secretKey === undefined
            ? before.secretKey
            : input.secretKey,
      };
      validate(value);
      const revision = before.revision + 1;
      db.prepare(
        `INSERT INTO billing_payment_settings VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        revision=excluded.revision,configured=excluded.configured,changed_at=excluded.changed_at,value=excluded.value`,
      ).run(revision, Number(value.configured), now(), seal({ ...value, configured: undefined }));
      db.prepare('INSERT INTO billing_payment_operations VALUES(?,?,?,?,?)').run(
        actorId,
        input.requestId,
        digest,
        seal({ revision }),
        now(),
      );
      audit('billing_payment_settings_changed', actorId, null, {
        targetId: 'payment-settings',
        reason: input.reason.trim(),
        operationId: input.requestId,
        before: {
          ...before.receiptConfig,
          configured: before.configured,
          testMode: before.testMode,
          revision: before.revision,
        },
        after: {
          ...value.receiptConfig,
          configured: value.configured,
          testMode: value.testMode,
          revision,
        },
      });
      return config(actorId);
    });
  }
  function forOrder(row, snapshot) {
    const current = internal();
    if (
      !publicConfig().ready ||
      current.shopId !== row.shop_id ||
      current.testMode !== Boolean(row.test_mode)
    )
      return null;
    // Orders freeze merchant/fiscal settings without copying a secret. Rotation
    // uses only the current central key for the same merchant and mode.
    return { ...snapshot, secretKey: current.secretKey };
  }
  return { internal, config, publicConfig, adminSettings, forOrder };
}
module.exports = { createPaymentSettings };
