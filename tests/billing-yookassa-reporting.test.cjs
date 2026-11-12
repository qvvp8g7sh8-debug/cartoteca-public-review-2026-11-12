const test = require('node:test'),
  assert = require('node:assert/strict');
const { createYooKassaProvider } = require('../src/server/modules/billing/yookassa-provider.cjs');
const PAYMENT = '28646d50-000f-5000-a000-1fe4f81e5e88',
  REFUND = '28646d50-000f-5000-a000-1fe4f81e5e90',
  RECEIPT = 'rt_28646d50-000f-5000-a000-1fe4f81e5e92';
function setup(body) {
  const calls = [];
  const provider = createYooKassaProvider({
    shopId: '12345',
    secretKey: 'synthetic-secret-only',
    returnOrigin: 'https://cabinet.example.test',
    receiptConfig: {
      fiscalProvider: 'yookassa',
      purchaseModel: 'package',
      paymentMode: 'full_payment',
      vatCode: 1,
      taxSystemCode: 2,
      paymentSubject: 'service',
      description: 'Synthetic package',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(body));
    },
  });
  return { provider, calls };
}
test('refund reporting is a bounded fixed GET with a minimal response DTO', async () => {
  const { provider, calls } = setup({
    id: REFUND,
    payment_id: PAYMENT,
    status: 'succeeded',
    amount: { value: '100.00', currency: 'RUB' },
    receipt_registration: 'pending',
    payment_method: { card: { last4: '4242' } },
    customer: { email: 'private@example.test' },
  });
  const result = await provider.readRefund(REFUND);
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/refunds/' + REFUND);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(result.amountKopecks, 10000);
  assert.equal(result.receiptRegistration, 'pending');
  assert.equal(JSON.stringify(result).includes('4242'), false);
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
});
test('receipt reporting preserves technical status without fiscal or customer payload', async () => {
  const { provider, calls } = setup({
    id: RECEIPT,
    type: 'payment',
    payment_id: PAYMENT,
    status: 'succeeded',
    customer: { email: 'private@example.test' },
    items: [{ payment_mode: 'full_payment' }],
    settlements: [{ type: 'prepayment' }],
  });
  const result = await provider.readReceipt(RECEIPT);
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/receipts/' + RECEIPT);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(result.classification, 'prepayment_offset_observed');
  assert.equal(result.customer, undefined);
  assert.equal(result.items, undefined);
});
test('invalid report identifiers never make a request', async () => {
  const { provider, calls } = setup({});
  await assert.rejects(provider.readRefund('../payments'));
  await assert.rejects(provider.readReceipt('https://evil.test/'));
  assert.equal(calls.length, 0);
});
test('unrelated or malformed reports are rejected', async () => {
  const { provider } = setup({
    id: REFUND,
    payment_id: PAYMENT,
    status: 'succeeded',
    amount: { value: '1e3', currency: 'RUB' },
  });
  await assert.rejects(provider.readRefund(REFUND));
  const receipt = setup({ id: RECEIPT, type: 'payment', status: 'succeeded' });
  await assert.rejects(receipt.provider.readReceipt(RECEIPT));
});
