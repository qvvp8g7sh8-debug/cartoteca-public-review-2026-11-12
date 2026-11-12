const crypto = require('node:crypto');
const { fixture } = require('./billing-payment-fixture.cjs');
const { multiServiceSchema } = require('../../src/server/modules/billing/multi-service-schema.cjs');
const { createPackageStore } = require('../../src/server/modules/billing/package-store.cjs');
const { createPaymentStore } = require('../../src/server/modules/billing/payment-store.cjs');
const { createBillingEntitlements } = require('../../src/server/modules/billing/entitlements.cjs');
function multi(t, { network = true } = {}) {
  const f = fixture(t, { paymentNetworkEnabled: network });
  f.db.exec(multiServiceSchema + 'PRAGMA user_version=20;');
  f.remote = new Map();
  f.created = [];
  f.financialRemote = new Map();
  f.financialCreated = [];
  f.idempotent = new Map();
  f.context.paymentProviderFactory = (config) => ({
    async createCheckout(input) {
      f.created.push({ input, config });
      const id = crypto.randomUUID();
      const dto = {
        paymentId: id,
        status: 'pending',
        succeeded: false,
        amountKopecks: input.amountKopecks,
        currency: 'RUB',
        test: config.testMode,
        metadata: { checkoutId: input.checkoutId, organizationId: input.organizationId },
        receiptRegistration: 'pending',
        confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=' + id,
      };
      f.remote.set(id, dto);
      return structuredClone(dto);
    },
    async createRefund(input) {
      return f.financialCreate('refund', input);
    },
    async createClosingReceipt(input) {
      return f.financialCreate('receipt', input);
    },
    async readRefund(id) {
      return structuredClone(f.financialRemote.get(id));
    },
    async readReceipt(id) {
      return structuredClone(f.financialRemote.get(id));
    },
    async readPayment(id) {
      return structuredClone(f.remote.get(id));
    },
    async verifyWebhook(event) {
      return structuredClone(f.remote.get(event.object.id));
    },
  });
  f.financialCreate = async (kind, input) => {
    f.financialCreated.push({ kind, input });
    if (f.idempotent.has(input.idempotencyKey))
      return structuredClone(f.idempotent.get(input.idempotencyKey));
    const value = {
      id: (kind === 'receipt' ? 'rt-' : '') + crypto.randomUUID(),
      paymentId: input.paymentId,
      status: f.financialStatus || 'succeeded',
      ...(kind === 'refund'
        ? { currency: 'RUB', amountKopecks: input.amountKopecks, receiptRegistration: 'pending' }
        : { type: 'payment', classification: 'prepayment_offset_observed', settledKopecks:input.amountKopecks }),
    };
    f.financialRemote.set(value.id, value);
    f.idempotent.set(input.idempotencyKey, value);
    if (f.failFinancialOnce) {
      f.failFinancialOnce = false;
      throw Object.assign(Error('Synthetic unknown'), { outcomeUnknown: true });
    }
    return structuredClone(value);
  };
  f.packages = createPackageStore(f.context);
  f.payments = createPaymentStore(f.context, f.packages);
  f.entitlements = createBillingEntitlements(
    f.context,
    { available: () => true },
    f.packages,
    f.payments,
  );
  f.offer = (extra = {}) =>
    f.packages.savePackage(
      'admin',
      f.command({
        id: 'reports-year',
        title: 'Годовой доступ к отчётам',
        serviceCode: 'reports',
        serviceTitle: 'Отчёты',
        periodMonths: 12,
        quotaUnit: 'access',
        priceKopecks: 250000,
        taskLimit: 1,
        enabled: true,
        expectedRevision: 0,
        ...extra,
      }),
    );
  f.approve = async (checkout) => {
    const row = f.db.prepare('SELECT * FROM billing_payment_orders WHERE id=?').get(checkout.id),
      dto = f.remote.get(row.provider_payment_id);
    Object.assign(dto, { status: 'succeeded', succeeded: true, confirmationUrl: null });
    return f.payments.payment(f.current, checkout.id);
  };
  f.configure();
  return f;
}

module.exports = { multi };
