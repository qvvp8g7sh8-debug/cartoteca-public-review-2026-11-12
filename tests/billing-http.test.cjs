const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBillingBrowserFixture } = require('./helpers/billing-browser-fixture.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
let f;
const actors = new Map();
test.before(async () => {
  f = await createBillingBrowserFixture();
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
  const body = await response.json();
  const value = {
    cookie: response.headers.get('set-cookie').split(';')[0],
    headers: authContextHeaders(body),
    user: body.user,
  };
  actors.set(email, value);
  return value;
}
async function call(route, who, body) {
  const response = await fetch(f.base + route, {
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
const command = (values) => ({
  requestId: crypto.randomUUID(),
  reason: 'Synthetic HTTP package operation',
  ...values,
});

test('prepared19 server and unchanged client notification store accept the explicit schema', () => {
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.doesNotThrow(() => createNotificationStore(f.database));
  assert.equal(f.server.listening, true);
  assert.equal(f.providerCalls.length, 0);
});

test('real HTTP owner and global finance boundaries hold for owner, employee and salon administrator', async () => {
  const root = await actor('root@billing.test');
  const owner = await actor('owner@billing.test');
  assert.equal((await call('/api/admin/billing', root)).status, 200);
  assert.equal((await call('/api/admin/billing', owner)).status, 403);
  assert.equal((await call('/api/billing', owner)).status, 200);
  assert.equal((await call('/api/billing', root)).status, 403);
  for (const role of ['salon_admin', 'cosmetologist']) {
    const staff = await actor(role + '@billing.test');
    assert.equal((await call('/api/billing', staff)).status, 403);
    assert.equal((await call('/api/admin/billing', staff)).status, 403);
  }
});

test('admin creates a package and trial through HTTP without provider calls or payment fiction', async () => {
  const root = await actor('root@billing.test');
  const before = await call('/api/admin/billing', root);
  assert.deepEqual(before.data.packages, []);
  const saved = await call(
    '/api/admin/billing/package',
    root,
    command({
      id: 'synthetic-month',
      title: 'Синтетический пакет на месяц',
      priceRub: '9.90',
      taskLimit: 3,
      enabled: true,
      expectedRevision: 0,
    }),
  );
  assert.equal(saved.status, 200);
  const trial = await call(
    '/api/admin/billing/trial',
    root,
    command({
      organizationId: f.owner.organizationId,
      packageId: 'synthetic-month',
    }),
  );
  assert.equal(trial.status, 200);
  const owner = await actor('owner@billing.test');
  const view = await call('/api/billing', owner);
  assert.equal(view.data.subscription.source, 'trial');
  assert.equal(view.data.subscription.remainingTasks, 3);
  assert.equal(view.data.paymentReady, false);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM billing_payment_orders').get().n, 0);
  assert.equal(f.providerCalls.length, 0);
  for (const email of [
    'owner@billing.test',
    'salon_admin@billing.test',
    'cosmetologist@billing.test',
  ])
    assert.equal((await call('/api/assistant/scope', await actor(email))).data.enabled, true);
});

test('customer DTO exposes fixed package price and quota without financial internals', async () => {
  const view = await call('/api/billing', await actor('owner@billing.test'));
  assert.equal(view.status, 200);
  assert.equal(view.data.packages[0].priceKopecks, 990);
  assert.equal(view.data.packages[0].taskLimit, 3);
  for (const forbidden of [
    'wallet',
    'rates',
    'markupPercent',
    'providerCostRub',
    'credential',
    'keyId',
    'secretKey',
  ])
    assert.equal(Object.hasOwn(view.data, forbidden), false, forbidden);
  assert.doesNotMatch(JSON.stringify(view.data), /synthetic-billing-secret|credential_hash/);
});

let order, checkoutBody;
test('unconfigured checkout and private admin writes cannot be smuggled through owner HTTP', async () => {
  const owner = await actor('owner@billing.test'),
    other = await actor('other@billing.test');
  const body = {
    packageId: 'synthetic-month',
    packageVersion: 1,
    requestId: crypto.randomUUID(),
    receiptEmail: 'synthetic@example.test',
    acceptedTermsVersion: 'packages-20261019-draft',
  };
  assert.equal((await call('/api/billing/checkout', other, body)).status, 503);
  assert.equal(
    (
      await call(
        '/api/admin/billing/trial',
        owner,
        command({
          organizationId: f.other.organizationId,
          packageId: 'synthetic-month',
        }),
      )
    ).status,
    403,
  );
  assert.equal(f.providerCalls.length, 0);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM billing_payment_orders').get().n, 0);
});

test('synthetic provider DI supports real HTTP checkout while every owner and order scope stays fresh', async () => {
  await f.configurePayments();
  const owner = await actor('owner@billing.test'),
    other = await actor('other@billing.test');
  checkoutBody = {
    packageId: 'synthetic-month',
    packageVersion: 1,
    requestId: crypto.randomUUID(),
    receiptEmail: 'synthetic@example.test',
    acceptedTermsVersion: 'packages-20261019-draft',
  };
  const result = await call('/api/billing/checkout', other, checkoutBody);
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'pending');
  order = result.data;
  assert.equal(f.providerCalls.filter(({ kind }) => kind === 'create').length, 1);
  const before = f.providerCalls.length;
  assert.equal((await call('/api/billing/payment?id=' + order.checkoutId, owner)).status, 404);
  assert.equal(f.providerCalls.length, before);
  const stale = { ...owner, cookie: other.cookie };
  assert.equal((await call('/api/billing/checkout', stale, checkoutBody)).status, 428);
  assert.equal(f.providerCalls.length, before);
});

test('verified synthetic payment grants one explicitly test package and never real revenue', async () => {
  f.markPaid(order.checkoutId);
  const other = await actor('other@billing.test');
  const result = await call('/api/billing/payment?id=' + order.checkoutId, other);
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'succeeded');
  const view = await call('/api/billing', other);
  assert.equal(view.data.subscription.active, true);
  assert.equal(view.data.subscription.source, 'paid');
  assert.equal(view.data.subscription.testMode, true);
  const repeated = await call('/api/billing/checkout', other, checkoutBody);
  assert.equal(repeated.data.checkoutId, order.checkoutId);
  assert.equal(f.providerCalls.filter(({ kind }) => kind === 'create').length, 1);
  assert.equal(
    f.database.db
      .prepare('SELECT count(*) n FROM billing_package_grants WHERE source_order_id=?')
      .get(order.checkoutId).n,
    1,
  );
  const admin = await call('/api/admin/billing', await actor('root@billing.test'));
  assert.equal(admin.data.summary.paidRevenueRub, 0);
  assert.doesNotMatch(JSON.stringify(admin.data), /synthetic-billing-secret/);
});
