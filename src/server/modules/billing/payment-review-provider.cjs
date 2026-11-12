const PAYMENT_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function createPaymentReviewProvider(core, settings, ledger) {
  const { provider } = core;
  const blocked = (code) => ({ kind: 'blocked', code });
  async function perform(row, input) {
    const data = ledger.value(row);
    if (input.action === 'retry_create') return blocked('safe_retry_disabled');
    if (input.action === 'request_refund_review' || input.action === 'request_receipt_review')
      return { kind: 'local' };
    if (data.restoredReview && input.action !== 'reconcile')
      return blocked('restored_requires_reconcile');
    const config = settings.forOrder(row, data.seller);
    if (!config) return blocked('merchant_unavailable');
    const paymentId = row.provider_payment_id || input.paymentId;
    if (!paymentId) return blocked('payment_id_required');
    if (!PAYMENT_ID.test(paymentId) || (input.paymentId && input.paymentId !== paymentId))
      return blocked('payment_id_mismatch');
    try {
      const api = provider(config),
        dto = await api.readPayment(paymentId);
      if (!ledger.matched(row, dto)) return blocked('payment_mismatch');
      if (input.action === 'reconcile') return { kind: 'payment', dto };
      if (!dto.succeeded || row.paid_confirmed_at === null) return blocked('payment_not_confirmed');
      if (input.action === 'check_refund') {
        if (typeof api.readRefund !== 'function') return blocked('reporting_unavailable');
        const refund = await api.readRefund(input.referenceId);
        if (
          refund.id !== input.referenceId ||
          refund.paymentId !== paymentId ||
          refund.currency !== 'RUB' ||
          !Number.isSafeInteger(refund.amountKopecks) ||
          refund.amountKopecks < 1 ||
          refund.amountKopecks > row.price_kopecks ||
          !['pending', 'succeeded', 'canceled'].includes(refund.status)
        )
          return blocked('reference_mismatch');
        return { kind: 'refund', dto: refund };
      }
      if (typeof api.readReceipt !== 'function') return blocked('reporting_unavailable');
      const receipt = await api.readReceipt(input.referenceId);
      if (
        receipt.id !== input.referenceId ||
        receipt.type !== 'payment' ||
        receipt.paymentId !== paymentId ||
        !['pending', 'succeeded', 'canceled'].includes(receipt.status)
      )
        return blocked('reference_mismatch');
      return { kind: 'receipt', dto: receipt };
    } catch {
      return blocked('provider_unavailable');
    }
  }
  return { perform };
}
module.exports = { createPaymentReviewProvider };
