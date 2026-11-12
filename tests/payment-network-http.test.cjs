const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBillingBrowserFixture } = require('./helpers/billing-browser-fixture.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
let f;
const actors = new Map();
test.before(async () => {
  f = await createBillingBrowserFixture(null, { paymentNetworkEnabled: false });
  f.platform.billing.packages.savePackage(
    f.admin.accountId,
    f.command({
      id: 'http-off',
      title: 'Synthetic HTTP OFF',
      priceKopecks: 100000,
      taskLimit: 3,
      enabled: true,
      expectedRevision: 0,
    }),
  );
  await f.configurePayments();
});
test.after(async () => {
  await f?.close();
});
async function actor(email) {
  if (actors.has(email)) return actors.get(email);
  const response = await fetch(f.base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: f.base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
    body: JSON.stringify({ email, password: f.password }),
  });
  assert.equal(response.status, 200);
  const body = await response.json(),
    result = {
      cookie: response.headers.get('set-cookie').split(';')[0],
      headers: authContextHeaders(body),
    };
  actors.set(email, result);
  return result;
}
async function call(route, email, body) {
  const who = await actor(email),
    response = await fetch(f.base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: f.base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: who.cookie,
        ...who.headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { status: response.status, data: await response.json() };
}
test('HTTP owner sees payment OFF despite a complete saved synthetic merchant draft', async () => {
  const result = await call('/api/billing', 'owner@billing.test');
  assert.equal(result.status, 200);
  assert.equal(result.data.paymentReady, false);
  assert.match(result.data.paymentNotice, /выключен на сервере/);
  assert.equal(JSON.stringify(result.data).includes('synthetic-billing-secret'), false);
  assert.equal(f.providerCalls.length, 0);
});
test('HTTP checkout cannot create any order or provider call while OFF', async () => {
  const body = {
    packageId: 'http-off',
    packageVersion: 1,
    requestId: crypto.randomUUID(),
    receiptEmail: 'owner@billing.test',
    acceptedTermsVersion: f.platform.billing.payments.termsVersion,
  };
  const result = await call('/api/billing/checkout', 'owner@billing.test', body);
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'PAYMENTS_NETWORK_DISABLED');
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM billing_payment_orders').get().n, 0);
  assert.equal(f.providerCalls.length, 0);
});
test('all new reporting GET routes retain global-admin-only access', async () => {
  for (const route of [
    '/api/admin/billing/summary',
    '/api/admin/billing/organizations',
    '/api/admin/billing/orders',
  ]) {
    assert.equal((await call(route, 'root@billing.test')).status, 200);
    for (const email of [
      'owner@billing.test',
      'salon_admin@billing.test',
      'cosmetologist@billing.test',
    ])
      assert.equal((await call(route, email)).status, 403);
  }
  assert.equal(f.providerCalls.length, 0);
});
test('HTTP trial activates the organization package with all payment transport still OFF', async () => {
  const result = await call('/api/admin/billing/trial', 'root@billing.test', {
    requestId: crypto.randomUUID(),
    reason: 'Synthetic nonpayment trial',
    organizationId: f.owner.organizationId,
    packageId: 'http-off',
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.summary.paidRevenueRub, 0);
  const owner = await call('/api/billing', 'owner@billing.test');
  assert.equal(owner.data.subscription.active, true);
  assert.equal(owner.data.subscription.source, 'trial');
  assert.equal(owner.data.paymentReady, false);
  assert.equal(f.providerCalls.length, 0);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM billing_payment_orders').get().n, 0);
});
