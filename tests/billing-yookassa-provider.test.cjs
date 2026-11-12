const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createYooKassaProvider } = require('../src/server/modules/billing/yookassa-provider.cjs');

// Synthetic protocol fixtures only. Tax values are explicit test inputs, not seller advice.
const PAYMENT = '28646d50-000f-5000-a000-1fe4f81e5e88';
const OTHER_PAYMENT = '28646d50-000f-5000-a000-1fe4f81e5e89';
const checkout = () => ({
  organizationId: 'org_alpha',
  checkoutId: 'checkout_alpha',
  amountKopecks: 1234,
  idempotencyKey: 'synthetic-checkout-01',
  returnUrl: 'https://cabinet.example.test/paid/return',
  receiptEmail: 'owner@example.test',
});
const receiptConfig = () => ({
  fiscalProvider: 'yookassa',
  purchaseModel: 'package',
  paymentMode: 'full_payment',
  vatCode: 1,
  taxSystemCode: 2,
  paymentSubject: 'service',
  description: 'Тестовый пакет доступа',
});
const payment = (extra = {}) => ({
  id: PAYMENT,
  status: 'pending',
  paid: false,
  test: true,
  amount: { value: '12.34', currency: 'RUB' },
  recipient: { account_id: '12345' },
  metadata: { checkoutId: 'checkout_alpha', organizationId: 'org_alpha' },
  confirmation: {
    type: 'redirect',
    confirmation_url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=' + PAYMENT,
  },
  receipt_registration: 'pending',
  ...extra,
});
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });
function setup(responder = () => jsonResponse(payment()), extra = {}) {
  const calls = [];
  const provider = createYooKassaProvider({
    shopId: '12345',
    secretKey: 'synthetic-test-secret-only',
    returnOrigin: 'https://cabinet.example.test',
    receiptConfig: receiptConfig(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responder(url, options);
    },
    ...extra,
  });
  return { provider, calls };
}
function providerFailure(unknown) {
  return (error) =>
    error.status === 502 &&
    error.outcomeUnknown === unknown &&
    error.code === (unknown ? 'PAYMENT_OUTCOME_UNKNOWN' : 'PAYMENT_PROVIDER_UNAVAILABLE');
}

test('provider construction is offline and returns only explicit operations', () => {
  const { provider, calls } = setup();
  assert.deepEqual(Object.keys(provider).sort(), [
    'createCheckout',
    'createClosingReceipt',
    'createRefund',
    'readPayment',
    'readReceipt',
    'readRefund',
    'verifyWebhook',
  ]);
  assert.equal(calls.length, 0);
});

test('checkout uses fixed API, server auth, one idempotency key and complete fiscal data', async () => {
  const { provider, calls } = setup();
  const result = await provider.createCheckout(checkout());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/payments');
  const request = calls[0].options,
    body = JSON.parse(request.body);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(
    request.headers.Authorization,
    'Basic ' + Buffer.from('12345:synthetic-test-secret-only').toString('base64'),
  );
  assert.equal(request.headers['Idempotence-Key'], checkout().idempotencyKey);
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(body.amount, { value: '12.34', currency: 'RUB' });
  assert.equal(body.capture, true);
  assert.deepEqual(body.confirmation, { type: 'redirect', return_url: checkout().returnUrl });
  assert.deepEqual(body.metadata, { checkoutId: 'checkout_alpha', organizationId: 'org_alpha' });
  assert.equal(body.receipt.customer.email, 'owner@example.test');
  assert.equal(body.receipt.tax_system_code, 2);
  assert.equal(body.receipt.internet, 'true');
  assert.equal(body.receipt.items[0].vat_code, 1);
  assert.equal(body.receipt.items[0].payment_mode, 'full_payment');
  assert.equal(body.receipt.items[0].payment_subject, 'service');
  assert.equal(body.receipt.items[0].quantity, '1.000');
  assert.equal(result.amountKopecks, 1234);
  assert.equal(result.test, true);
  assert.equal(result.receiptRegistration, 'pending');
  assert.equal(result.succeeded, false);
  assert.equal('recipient' in result, false);
});

for (const mode of ['full_payment', 'full_prepayment'])
  test('known package supports explicit ' + mode + ' without changing its meaning', async () => {
    const { provider, calls } = setup(undefined, {
      receiptConfig: { ...receiptConfig(), paymentMode: mode },
    });
    await provider.createCheckout(checkout());
    assert.equal(JSON.parse(calls[0].options.body).receipt.items[0].payment_mode, mode);
  });

test('advance requires explicitly configured external fiscal provider', async () => {
  const { provider, calls } = setup(undefined, {
    receiptConfig: {
      ...receiptConfig(),
      fiscalProvider: 'external',
      purchaseModel: 'advance',
      paymentMode: 'advance',
      paymentSubject: 'payment',
    },
  });
  await provider.createCheckout(checkout());
  assert.equal(JSON.parse(calls[0].options.body).receipt.items[0].payment_mode, 'advance');
});

for (const [label, change] of [
  ['built-in advance', { purchaseModel: 'advance', paymentMode: 'advance' }],
  ['package disguised as advance', { paymentMode: 'advance' }],
  ['unspecified purchase model', { purchaseModel: undefined }],
  ['missing VAT', { vatCode: undefined }],
  ['missing tax system', { taxSystemCode: undefined }],
  ['unsupported VAT', { vatCode: 13 }],
  ['unsupported tax system', { taxSystemCode: 0 }],
  ['guessed subject', { paymentSubject: undefined }],
  ['empty description', { description: '' }],
  ['unexpected fiscal field', { sellerSecret: 'do-not-send' }],
])
  test('invalid fiscal configuration fails before HTTP: ' + label, () => {
    let called = false;
    assert.throws(
      () =>
        setup(undefined, {
          receiptConfig: { ...receiptConfig(), ...change },
          fetchImpl: () => {
            called = true;
          },
        }),
      { code: 'PAYMENT_INPUT_INVALID' },
    );
    assert.equal(called, false);
  });

for (const [label, change] of [
  ['foreign origin', { returnUrl: 'https://elsewhere.example/return' }],
  ['URL credentials', { returnUrl: 'https://user:pass@cabinet.example.test/return' }],
  ['insecure return', { returnUrl: 'http://cabinet.example.test/return' }],
  ['fractional kopecks', { amountKopecks: 12.34 }],
  ['zero amount', { amountKopecks: 0 }],
  ['negative amount', { amountKopecks: -1 }],
  ['unsafe integer', { amountKopecks: Number.MAX_SAFE_INTEGER + 1 }],
  ['numeric organization', { organizationId: 123 }],
  ['missing checkout', { checkoutId: '' }],
  ['newline organization', { organizationId: 'org_alpha\n' }],
  ['header injection', { idempotencyKey: 'id\r\nInjected: yes' }],
  ['long idem key', { idempotencyKey: 'a'.repeat(65) }],
  ['newline idem key', { idempotencyKey: 'idem\n' }],
  ['invalid receipt email', { receiptEmail: 'Name <owner@example.test>' }],
  ['receipt email newline', { receiptEmail: 'owner@example.test\n' }],
  ['oversized receipt email', { receiptEmail: 'x'.repeat(255) + '@example.test' }],
])
  test('invalid checkout fails before HTTP: ' + label, async () => {
    const { provider, calls } = setup();
    await assert.rejects(provider.createCheckout({ ...checkout(), ...change }), {
      code: 'PAYMENT_INPUT_INVALID',
    });
    assert.equal(calls.length, 0);
  });

test('kopecks format exactly even at the safe integer boundary', async () => {
  const value = '90071992547409.91';
  const { provider, calls } = setup(() =>
    jsonResponse(payment({ amount: { value, currency: 'RUB' } })),
  );
  const result = await provider.createCheckout({
    ...checkout(),
    amountKopecks: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(JSON.parse(calls[0].options.body).amount.value, value);
  assert.equal(result.amountKopecks, Number.MAX_SAFE_INTEGER);
});

test('caller-controlled retries reuse the same outgoing key and payload', async () => {
  const { provider, calls } = setup();
  await provider.createCheckout(checkout());
  await provider.createCheckout(checkout());
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].options.headers['Idempotence-Key'],
    calls[1].options.headers['Idempotence-Key'],
  );
  assert.equal(calls[0].options.body, calls[1].options.body);
});

for (const [label, responder] of [
  ['server error', () => jsonResponse({ description: 'secret' }, 500)],
  ['rate limited', () => jsonResponse({}, 429)],
  ['malformed JSON', () => new Response('{')],
  ['excess response', () => new Response('x'.repeat(65537))],
  [
    'network error',
    () => {
      throw Error('synthetic-test-secret-only raw provider credentials');
    },
  ],
])
  test(
    'POST failure retains unknown outcome and never automatically creates again: ' + label,
    async () => {
      const { provider, calls } = setup(responder);
      await assert.rejects(provider.createCheckout(checkout()), (error) => {
        assert.equal(providerFailure(true)(error), true);
        assert.equal(String(error.stack).includes('synthetic-test-secret-only'), false);
        assert.equal('cause' in error, false);
        return true;
      });
      assert.equal(calls.length, 1);
    },
  );

test('explicit provider rejection is known, with masked response body', async () => {
  const { provider, calls } = setup(() => jsonResponse({ description: 'private shop data' }, 400));
  await assert.rejects(provider.createCheckout(checkout()), providerFailure(false));
  assert.equal(calls.length, 1);
});

test('timeout settles even if an injected transport ignores AbortSignal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { provider, calls } = setup(() => new Promise(() => {}));
  const rejected = assert.rejects(provider.createCheckout(checkout()), providerFailure(true));
  t.mock.timers.tick(12001);
  await rejected;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
});

test('read uses only the fixed payment resource and GET never reports a new-payment outcome', async () => {
  const { provider, calls } = setup(() => jsonResponse({}, 500));
  await assert.rejects(provider.readPayment(PAYMENT), providerFailure(false));
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/payments/' + PAYMENT);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal('Idempotence-Key' in calls[0].options.headers, false);
  assert.equal('body' in calls[0].options, false);
  await assert.rejects(provider.readPayment('https://elsewhere.example/payment'), {
    code: 'PAYMENT_INPUT_INVALID',
  });
  assert.equal(calls.length, 1);
});

test('webhook ignores forged amount, status, organization and headers; re-fetches current payment', async () => {
  const { provider, calls } = setup();
  const result = await provider.verifyWebhook(
    JSON.stringify({
      type: 'notification',
      event: 'payment.succeeded',
      object: {
        id: PAYMENT,
        paid: true,
        amount: { value: '999.99', currency: 'EUR' },
        metadata: { organizationId: 'attacker', checkoutId: 'other' },
      },
    }),
    { 'x-signature': 'forged', 'x-forwarded-for': '185.71.76.1' },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/payments/' + PAYMENT);
  assert.equal(result.succeeded, false);
  assert.equal(result.amountKopecks, 1234);
  assert.deepEqual(result.metadata, { organizationId: 'org_alpha', checkoutId: 'checkout_alpha' });
});

test('a verified success includes separate receipt registration state', async () => {
  const { provider } = setup(() =>
    jsonResponse(
      payment({
        status: 'succeeded',
        paid: true,
        confirmation: null,
        receipt_registration: 'canceled',
      }),
    ),
  );
  const result = await provider.verifyWebhook({
    type: 'notification',
    event: 'payment.succeeded',
    object: { id: PAYMENT },
  });
  assert.equal(result.succeeded, true);
  assert.equal(result.receiptRegistration, 'canceled');
  assert.equal(result.confirmationUrl, null);
});

for (const [label, extra] of [
  ['another merchant', { recipient: { account_id: '54321' } }],
  ['wrong payment id', { id: OTHER_PAYMENT }],
  ['foreign currency', { amount: { value: '12.34', currency: 'EUR' } }],
  ['missing order binding', { metadata: {} }],
  ['bad amount format', { amount: { value: '1e3', currency: 'RUB' } }],
  ['newline amount', { amount: { value: '12.34\n', currency: 'RUB' } }],
  ['unknown payment state', { status: 'approved' }],
  ['unpaid success', { status: 'succeeded', paid: false }],
  ['missing test mode', { test: undefined }],
])
  test('read rejects malformed or unrelated provider object: ' + label, async () => {
    const { provider } = setup(() => jsonResponse(payment(extra)));
    await assert.rejects(provider.readPayment(PAYMENT), providerFailure(false));
  });

for (const url of [
  'http://yoomoney.ru/checkout/payments/v2/contract',
  'https://yoomoney.ru.evil.test/checkout/payments/v2/contract',
  'https://user@ yoomoney.ru/checkout/payments/v2/contract',
  'https://yoomoney.ru/elsewhere',
])
  test('unsafe confirmation URL never reaches the client: ' + url, async () => {
    const { provider } = setup(() =>
      jsonResponse(payment({ confirmation: { type: 'redirect', confirmation_url: url } })),
    );
    await assert.rejects(provider.createCheckout(checkout()), providerFailure(true));
  });

test('unsupported or excessive webhooks fail before any provider request', async () => {
  const { provider, calls } = setup();
  for (const body of [
    '{',
    'x'.repeat(65537),
    { type: 'notification', event: 'refund.succeeded', object: { id: PAYMENT } },
    { type: 'notification', event: 'payment.succeeded', object: { id: PAYMENT + '/capture' } },
  ])
    await assert.rejects(provider.verifyWebhook(body), { code: 'PAYMENT_INPUT_INVALID' });
  assert.equal(calls.length, 0);
});

test('documented api-pages hosted confirmation is accepted without fetching it', async () => {
  const url = 'https://yoomoney.ru/api-pages/v2/payment-confirm/epl?orderId=' + PAYMENT;
  const { provider, calls } = setup(() =>
    jsonResponse(payment({ confirmation: { type: 'redirect', confirmation_url: url } })),
  );
  const result = await provider.createCheckout(checkout());
  assert.equal(result.confirmationUrl, url);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/payments');
});
