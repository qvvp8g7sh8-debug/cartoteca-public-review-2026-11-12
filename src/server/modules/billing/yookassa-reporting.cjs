// Read existing provider objects only. This module cannot create refunds or receipts.
// Official contracts: yookassa.ru/developers/payment-acceptance/after-the-payment/refunds
// and /receipts/54fz/yoomoney/payments. No fiscal scenario is inferred here.
function createYooKassaReporting({
  request,
  matches,
  object,
  amountKopecks,
  invalid,
  unavailable,
  PAYMENT_ID,
  RECEIPT_STATES,
}) {
  const RECEIPT_ID = /^(?:rt[-_])?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  async function readRefund(id) {
    if (!matches(id, PAYMENT_ID)) throw invalid();
    const value = await request('GET', id, undefined, undefined, 'refunds');
    try {
      if (
        !object(value) ||
        value.id !== id ||
        !matches(value.payment_id, PAYMENT_ID) ||
        !RECEIPT_STATES.has(value.status) ||
        value.amount?.currency !== 'RUB' ||
        (value.receipt_registration != null && !RECEIPT_STATES.has(value.receipt_registration))
      )
        throw invalid();
      return {
        id: value.id,
        paymentId: value.payment_id,
        status: value.status,
        amountKopecks: amountKopecks(value.amount.value),
        currency: 'RUB',
        receiptRegistration: value.receipt_registration ?? null,
      };
    } catch {
      throw unavailable();
    }
  }
  async function readReceipt(id) {
    if (!matches(id, RECEIPT_ID)) throw invalid();
    const value = await request('GET', id, undefined, undefined, 'receipts');
    try {
      if (
        !object(value) ||
        value.id !== id ||
        !['payment', 'refund'].includes(value.type) ||
        !RECEIPT_STATES.has(value.status) ||
        (value.payment_id != null && !matches(value.payment_id, PAYMENT_ID)) ||
        (value.refund_id != null && !matches(value.refund_id, PAYMENT_ID)) ||
        (!value.payment_id && !value.refund_id)
      )
        throw invalid();
      const offset =
        Array.isArray(value.items) &&
        value.items.length > 0 &&
        value.items.every((item) => item.payment_mode === 'full_payment') &&
        Array.isArray(value.settlements) &&
        value.settlements.some((item) => item.type === 'prepayment');
      let settledKopecks = null;
      if (
        offset &&
        value.settlements.length <= 20 &&
        value.settlements.every(
          (item) => item.type === 'prepayment' && item.amount?.currency === 'RUB',
        )
      ) {
        const sum = value.settlements.reduce(
          (total, item) => total + BigInt(amountKopecks(item.amount.value)),
          0n,
        );
        if (sum > 0n && sum <= BigInt(Number.MAX_SAFE_INTEGER)) settledKopecks = Number(sum);
      }
      return {
        settledKopecks,
        id: value.id,
        type: value.type,
        paymentId: value.payment_id ?? null,
        refundId: value.refund_id ?? null,
        status: value.status,
        classification: offset ? 'prepayment_offset_observed' : 'unclassified',
      };
    } catch {
      throw unavailable();
    }
  }
  return { readRefund, readReceipt };
}
module.exports = { createYooKassaReporting };
