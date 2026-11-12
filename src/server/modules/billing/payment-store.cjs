const crypto = require('node:crypto');
const { fail } = require('../../../shared/errors.cjs');
const { paymentTables } = require('./payment-schema.cjs');
const { createYooKassaProvider } = require('./yookassa-provider.cjs');
const { createPaymentSettings } = require('./payment-settings.cjs');
const { createPaymentOrderLedger } = require('./payment-order-ledger.cjs');
const { createPaymentOrders } = require('./payment-orders.cjs');
const { createPaymentReview } = require('./payment-review.cjs');
const TERMS_VERSION = 'packages-20261019-draft';
function createPaymentStore(context, packages) {
  const { db, seal, open, transaction, audit = () => {} } = context;
  const networkEnabled = context.paymentNetworkEnabled === true;
  function requireNetwork() {
    if (networkEnabled) return;
    const error = fail(
      503,
      'Приём платежей выключен на сервере. Пакеты и пробный доступ доступны без обращения к платёжной системе.',
    );
    error.code = 'PAYMENTS_NETWORK_DISABLED';
    error.outcomeUnknown = false;
    throw error;
  }
  function networkView(view) {
    return {
      ...view,
      networkEnabled,
      ready: networkEnabled && view.ready,
      ...(!networkEnabled
        ? {
            notice:
              'Приём платежей выключен на сервере. Настройки сохраняются только как черновик.',
          }
        : {}),
    };
  }
  const now = context.now || Date.now,
    id = context.id || crypto.randomUUID;
  function available() {
    return (
      packages.available() &&
      paymentTables.every((table) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      )
    );
  }
  function ready() {
    if (!available()) throw fail(503, 'Оплата пакетов ещё не подготовлена.');
  }
  function identifier(value) {
    if (
      typeof value !== 'string' ||
      value.length > 120 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      throw fail(400, 'Некорректный идентификатор платёжной операции.');
    return value;
  }
  function fields(input, allowed) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key))
    )
      throw fail(400, 'Неверные поля платёжной операции.');
  }
  function admin(actorId) {
    identifier(actorId);
    if (
      !db
        .prepare("SELECT 1 FROM accounts WHERE id=? AND global_admin=1 AND status='active'")
        .get(actorId)
    )
      throw fail(403, 'Настройки оплаты доступны главному администратору.');
  }
  function ownerIdentity(organizationId, accountId) {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
      JOIN organizations o ON o.id=m.organization_id JOIN subscriptions s ON s.organization_id=o.id
      WHERE m.organization_id=? AND m.account_id=? AND m.role='owner' AND m.status='active'
      AND a.status='active' AND a.global_admin=0 AND o.status='active' AND s.status='active'`,
        )
        .get(organizationId, accountId),
    );
  }
  function owner(current) {
    if (!current || current.globalAdmin || current.role !== 'owner')
      throw fail(403, 'Оплата пакетов доступна владельцу кабинета.');
    identifier(current.organizationId);
    identifier(current.accountId);
    if (!ownerIdentity(current.organizationId, current.accountId))
      throw fail(403, 'Нет активного доступа владельца к кабинету.');
  }
  function guard(current, assertCurrent) {
    if (assertCurrent) {
      const value = assertCurrent();
      if (value && typeof value.then === 'function')
        throw Error('Payment identity guard must be synchronous.');
    }
    owner(current);
  }
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const fingerprint = (value) =>
    hash(
      JSON.stringify(value, (_, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        return Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        );
      }),
    );
  const core = {
    db,
    seal,
    open,
    transaction,
    audit,
    now,
    id,
    fail,
    packages,
    available,
    ready,
    identifier,
    fields,
    admin,
    owner,
    ownerIdentity,
    guard,
    hash,
    fingerprint,
    provider(config) {
      requireNetwork();
      const factory =
        context.paymentProviderFactory ||
        ((value) =>
          createYooKassaProvider({
            shopId: value.shopId,
            secretKey: value.secretKey,
            returnOrigin: value.returnOrigin,
            receiptConfig: value.receiptConfig,
            ...(context.paymentFetch ? { fetchImpl: context.paymentFetch } : {}),
          }));
      return factory(config);
    },
    termsVersion: TERMS_VERSION,
  };
  const storedSettings = createPaymentSettings(core);
  const customerOrder = (view) =>
    networkEnabled
      ? view
      : {
          ...view,
          confirmationUrl: null,
          ...(['pending', 'creating', 'uncertain'].includes(view.status)
            ? {
                notice:
                  'Приём платежей выключен на сервере. Прежний заказ сохранён; его результат требует сверки без нового платежа.',
              }
            : {}),
        };
  const settings = {
    ...storedSettings,
    config: (actorId) => networkView(storedSettings.config(actorId)),
    publicConfig: () => networkView(storedSettings.publicConfig()),
    adminSettings: (actorId, input) => networkView(storedSettings.adminSettings(actorId, input)),
    forOrder: (...args) => (networkEnabled ? storedSettings.forOrder(...args) : null),
  };
  const ledger = createPaymentOrderLedger(core, settings);
  const orders = createPaymentOrders(core, settings, ledger);
  const financial = require('./financial-actions.cjs').createFinancialActions(
    core,
    settings,
    ledger,
  );
  return {
    available,
    config: settings.config,
    publicConfig: settings.publicConfig,
    adminSettings: settings.adminSettings,
    ...orders,
    customerOrders: (current) => orders.customerOrders(current).map(customerOrder),
    serviceRevenues: ledger.serviceRevenues,
    adminRevenue: ledger.adminRevenue,
    adminOrders: ledger.adminOrders,
    organizationRevenues: ledger.organizationRevenues,
    async beginCheckout(current, input, options = {}) {
      ready();
      guard(current, options.assertCurrent);
      if (
        !networkEnabled &&
        typeof input?.requestId === 'string' &&
        /^[A-Za-z0-9_-]{1,120}$/.test(input.requestId)
      ) {
        const prior = db
          .prepare('SELECT * FROM billing_payment_orders WHERE organization_id=? AND request_id=?')
          .get(current.organizationId, input.requestId);
        if (prior) {
          if (
            prior.account_id !== current.accountId ||
            ledger.value(prior).fingerprint !== fingerprint(input)
          )
            throw fail(409, 'Номер заказа уже использован с другими условиями.');
          return customerOrder(ledger.view(prior));
        }
      }
      requireNetwork();
      return orders.beginCheckout(current, input, options);
    },
    async payment(current, checkoutId, options) {
      const result = await orders.payment(current, checkoutId, options);
      if (result.status === 'succeeded') {
        await financial.synchronize(checkoutId);
        guard(current, options?.assertCurrent);
        return customerOrder(ledger.view(ledger.load(checkoutId)));
      }
      return customerOrder(result);
    },
    ...createPaymentReview(core, settings, ledger),
    financialAction: financial.financialAction,
    refreshFinancialAction: financial.refreshFinancialAction,
    financialActions: financial.financialActions,
    async webhook(body, headers) {
      const result = await financial.refundWebhook(body);
      return result || orders.webhook(body, headers);
    },
    termsVersion: TERMS_VERSION,
  };
}
module.exports = { createPaymentStore, TERMS_VERSION };
