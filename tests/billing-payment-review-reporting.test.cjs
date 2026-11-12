const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, PAYMENT } = require('./helpers/billing-payment-fixture.cjs');
const REFUND = '28646d50-000f-5000-a000-1fe4f81e5e90',
  OTHER = '28646d50-000f-5000-a000-1fe4f81e5e91';
const RECEIPT = 'rt_28646d50-000f-5000-a000-1fe4f81e5e92';
async function paid(t) {
  const f = fixture(t);
  f.configure();
  await f.begin();
  f.onRead = () => f.success();
  await f.review();
  return f;
}
const refund = (extra = {}) => ({
  id: REFUND,
  paymentId: PAYMENT,
  status: 'succeeded',
  amountKopecks: 10000,
  currency: 'RUB',
  receiptRegistration: 'pending',
  ...extra,
});
test('refund and closing-receipt requests are local, explicit and never revoke an active package', async (t) => {
  const f = await paid(t),
    calls = f.calls.length;
  let result = await f.review({ action: 'request_refund_review' });
  assert.equal(result.refund.status, 'review_required');
  assert.equal(result.refund.automatic, false);
  result = await f.review({ action: 'request_receipt_review' });
  assert.equal(result.closingReceipt.status, 'review_required');
  assert.equal(result.closingReceipt.policyReady, false);
  assert.equal(f.calls.length, calls);
  assert.equal(f.packages.status('org-a').active, true);
});
test('unconfirmed money cannot be represented as a refund request', async (t) => {
  const f = fixture(t);
  f.configure();
  await f.begin();
  const result = await f.review({ action: 'request_refund_review' });
  assert.equal(result.operation.code, 'payment_not_confirmed');
  assert.equal(result.refund.status, 'not_requested');
});
test('existing refund status is verified, bounded and separated from gross captured revenue', async (t) => {
  const f = await paid(t);
  f.onRefund = () => refund({ status: 'pending' });
  let result = await f.review({ action: 'check_refund', referenceId: REFUND });
  assert.equal(result.refund.status, 'pending');
  assert.equal(result.refund.knownRefundedKopecks, 0);
  f.onRefund = () => refund();
  result = await f.review({ action: 'check_refund', referenceId: REFUND });
  assert.equal(result.refund.knownRefundedKopecks, 10000);
  assert.equal(result.refund.records[0].receiptRegistration, 'pending');
  assert.equal(f.packages.status('org-a').active, true);
  assert.equal(f.calls.at(-1).type, 'refund');
  f.onRefund = () => refund({ status: 'canceled' });
  result = await f.review({ action: 'check_refund', referenceId: REFUND });
  assert.equal(result.operation.code, 'reference_mismatch');
  assert.equal(result.refund.knownRefundedKopecks, 10000);
});
test('another payment refund is not accepted', async (t) => {
  const f = await paid(t);
  f.onRefund = () => refund({ paymentId: OTHER });
  const result = await f.review({ action: 'check_refund', referenceId: REFUND });
  assert.equal(result.operation.code, 'reference_mismatch');
  assert.deepEqual(result.refund.records, []);
});
test('observed refunds cannot exceed the original amount', async (t) => {
  const f = await paid(t);
  f.onRefund = () => refund({ amountKopecks: 60000 });
  await f.review({ action: 'check_refund', referenceId: REFUND });
  f.onRefund = () => refund({ id: OTHER, amountKopecks: 60000 });
  const result = await f.review({ action: 'check_refund', referenceId: OTHER });
  assert.equal(result.operation.code, 'reference_mismatch');
  assert.equal(result.refund.knownRefundedKopecks, 60000);
});
test('existing receipt technical success never declares fiscal policy configured', async (t) => {
  const f = await paid(t);
  f.onReceipt = () => ({
    id: RECEIPT,
    type: 'payment',
    paymentId: PAYMENT,
    status: 'succeeded',
    classification: 'prepayment_offset_observed',
  });
  const result = await f.review({ action: 'check_receipt', referenceId: RECEIPT });
  assert.equal(result.closingReceipt.status, 'succeeded');
  assert.equal(result.closingReceipt.automatic, false);
  assert.equal(result.closingReceipt.policyReady, false);
  assert.equal(result.closingReceipt.records[0].classification, 'prepayment_offset_observed');
});
test('receipt for another payment cannot be attached', async (t) => {
  const f = await paid(t);
  f.onReceipt = () => ({
    id: RECEIPT,
    type: 'payment',
    paymentId: OTHER,
    status: 'succeeded',
    classification: 'unclassified',
  });
  const result = await f.review({ action: 'check_receipt', referenceId: RECEIPT });
  assert.equal(result.operation.code, 'reference_mismatch');
  assert.equal(result.closingReceipt.status, 'not_checked');
});
test('report checks after restore require payment reconciliation first', async (t) => {
  const f = await paid(t);
  f.mutateOrder((data) => {
    data.restoredReview = true;
  });
  const calls = f.calls.length;
  const result = await f.review({ action: 'check_refund', referenceId: REFUND });
  assert.equal(result.operation.code, 'restored_requires_reconcile');
  assert.equal(f.calls.length, calls);
});
