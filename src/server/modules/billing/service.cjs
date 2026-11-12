const { fail } = require('../../../shared/errors.cjs');
function createBilling({ provider, ledger } = {}) {
  return {
    status: () => ({ connected: Boolean(provider && ledger), currency: 'RUB' }),
    async startCheckout({ organizationId, amountKopecks, idempotencyKey, returnUrl }) {
      if (
        !organizationId ||
        !Number.isSafeInteger(amountKopecks) ||
        amountKopecks <= 0 ||
        !idempotencyKey
      )
        throw fail(400, 'Некорректные данные платежа.');
      if (!provider || !ledger) throw fail(503, 'Оплата пока не подключена.');
      const existing = await ledger.findByIdempotencyKey(organizationId, idempotencyKey);
      if (existing) return existing;
      const checkout = await provider.createCheckout({
        organizationId,
        amountKopecks,
        currency: 'RUB',
        idempotencyKey,
        returnUrl,
      });
      return ledger.recordCheckout({
        organizationId,
        amountKopecks,
        currency: 'RUB',
        idempotencyKey,
        checkout,
      });
    },
    async acceptWebhook(rawBody, headers) {
      if (!provider || !ledger) throw fail(503, 'Оплата пока не подключена.');
      // Provider verification must precede any tariff change; ledger applies events once.
      const event = await provider.verifyWebhook(rawBody, headers);
      return ledger.applyVerifiedEvent(event);
    },
  };
}
module.exports = { createBilling };
