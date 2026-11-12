const test = require('node:test'),
  assert = require('node:assert/strict');
const { createYooKassaProvider } = require('../src/server/modules/billing/yookassa-provider.cjs');
const payment = '28646d50-000f-5000-a000-1fe4f81e5e88',
  refund = '28646d50-000f-5000-a000-1fe4f81e5e89',
  receipt = 'rt-28646d50-000f-5000-a000-1fe4f81e5e90',
  key = '28646d50-000f-5000-a000-1fe4f81e5e91';
function provider(mode, reply) {
  const calls = [];
  return {
    calls,
    api: createYooKassaProvider({
      shopId: '12345',
      secretKey: 'synthetic-provider-key',
      returnOrigin: 'https://cabinet.example.test',
      receiptConfig: {
        fiscalProvider: 'yookassa',
        purchaseModel: 'package',
        paymentMode: mode,
        vatCode: 1,
        taxSystemCode: 2,
        paymentSubject: 'service',
        description: 'Synthetic service',
      },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(reply), { status: 200 });
      },
    }),
  };
}
const input = {
  paymentId: payment,
  amountKopecks: 12501,
  idempotencyKey: key,
  receiptEmail: 'receipt@example.test',
};
test('refund adapter sends exact minor units, original payment and stable key to refunds only', async () => {
  const f = provider('full_payment', {
    id: refund,
    payment_id: payment,
    status: 'succeeded',
    amount: { value: '125.01', currency: 'RUB' },
  });
  const dto = await f.api.createRefund(input),
    call = f.calls[0],
    body = JSON.parse(call.options.body);
  assert.equal(call.url, 'https://api.yookassa.ru/v3/refunds');
  assert.equal(call.options.headers['Idempotence-Key'], key);
  assert.deepEqual(body.amount, { value: '125.01', currency: 'RUB' });
  assert.equal(body.payment_id, payment);
  assert.equal(body.receipt.items[0].description, 'Synthetic service');
  assert.equal(dto.amountKopecks, 12501);
});
test('closing receipt sends no new charge and declares prepayment settlement explicitly', async () => {
  const f = provider('full_prepayment', {
    id: receipt,
    payment_id: payment,
    type: 'payment',
    status: 'pending',
  });
  const dto = await f.api.createClosingReceipt(input),
    call = f.calls[0],
    body = JSON.parse(call.options.body);
  assert.equal(call.url, 'https://api.yookassa.ru/v3/receipts');
  assert.equal(body.type, 'payment');
  assert.equal(body.send, true);
  assert.equal(body.items[0].payment_mode, 'full_payment');
  assert.deepEqual(body.settlements, [
    { type: 'prepayment', amount: { value: '125.01', currency: 'RUB' } },
  ]);
  assert.equal(dto.id, receipt);
});
test('closing a full-payment receipt and injecting card fields are rejected before any fetch', async () => {
  const f = provider('full_payment', {});
  await assert.rejects(f.api.createClosingReceipt(input), (e) => e.status === 400);
  await assert.rejects(
    f.api.createRefund({ ...input, cardNumber: '0000' }),
    (e) => e.status === 400,
  );
  assert.equal(f.calls.length, 0);
});
test('mismatched refund amount stays an unknown result, never a confirmed refund', async () => {
  const f = provider('full_payment', {
    id: refund,
    payment_id: payment,
    status: 'succeeded',
    amount: { value: '1000.00', currency: 'RUB' },
  });
  await assert.rejects(f.api.createRefund(input), (e) => e.outcomeUnknown === true);
});
test('reader accepts the actual rt-hyphen receipt identifier', async () => {
  const f = provider('full_prepayment', {
    id: receipt,
    payment_id: payment,
    type: 'payment',
    status: 'succeeded',
    items: [{ payment_mode: 'full_payment' }],
    settlements: [{ type: 'prepayment' }],
  });
  assert.equal((await f.api.readReceipt(receipt)).classification, 'prepayment_offset_observed');
  assert.equal(f.calls[0].options.method, 'GET');
});


test('full original refund lets YooKassa reuse its original receipt without sending a replacement receipt',async()=>{
 const f=provider('full_payment',{id:refund,payment_id:payment,status:'succeeded',amount:{value:'125.01',currency:'RUB'}});
 await f.api.createRefund({...input,originalAmountKopecks:12501});assert.equal(Object.hasOwn(JSON.parse(f.calls[0].options.body),'receipt'),false);
});
