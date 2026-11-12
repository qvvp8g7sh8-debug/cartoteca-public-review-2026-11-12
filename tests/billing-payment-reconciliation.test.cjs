const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, status } = require('./helpers/billing-payment-fixture.cjs');

test('verified payment activates the frozen package atomically once and preserves receipt status', async (t) => {
  const f = fixture(t);
  f.configure();
  const pending = await f.begin();
  f.save({ priceKopecks: 120000, taskLimit: 9 });
  f.onRead = () => f.success();
  const paid = await f.payments.payment(f.current, pending.id);
  assert.equal(paid.status, 'succeeded');
  assert.equal(paid.state, 'paid');
  assert.equal(paid.receiptRegistration, 'pending');
  assert.equal(paid.package.priceKopecks, 99000);
  assert.equal(f.packages.status('org-a').taskLimit, 3);
  assert.equal(f.packages.status('org-a').testMode, true);
  assert.equal(f.packages.status('org-a').endsAt, Date.parse('2026-02-28T12:00:00Z'));
  f.onVerify = () => f.success();
  await f.payments.webhook(f.event(), {});
  await f.payments.webhook(f.event(), {});
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 1);
  await assert.rejects(f.begin(f.checkout({ packageVersion: 2 })), status(409));
});
for (const [name, extra] of [
  ['amount', { amountKopecks: 1 }],
  ['organization', { metadata: { checkoutId: 'foreign', organizationId: 'org-b' } }],
  ['test mode', { test: false }],
  ['payment id', { paymentId: '28646d50-000f-5000-a000-1fe4f81e5e89' }],
])
  test('provider verification rejects mismatched ' + name, async (t) => {
    const f = fixture(t);
    f.configure();
    const pending = await f.begin();
    f.onRead = () => f.success(extra);
    await assert.rejects(f.payments.payment(f.current, pending.id), status(409));
    assert.equal(f.packages.status('org-a').active, false);
  });
test('webhook uses a fresh verified payment, ignoring notification amount and status', async (t) => {
  const f = fixture(t);
  f.configure();
  await f.begin();
  const forged = f.event();
  forged.object.amount = { value: '999999.99', currency: 'RUB' };
  forged.object.paid = true;
  forged.object.status = 'succeeded';
  const result = await f.payments.webhook(forged, { 'x-signature': 'forged' });
  assert.equal(result.status, 'pending');
  assert.equal(f.packages.status('org-a').active, false);
  assert.equal(f.calls.at(-1).type, 'verify');
  assert.equal(f.data().rawWebhook, undefined);
});
test('unknown webhook does not call the provider or create a local order', async (t) => {
  const f = fixture(t);
  f.configure();
  const result = await f.payments.webhook(
    {
      type: 'notification',
      event: 'payment.succeeded',
      object: { id: '28646d50-000f-5000-a000-1fe4f81e5e88' },
    },
    {},
  );
  assert.equal(result.ignored, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.row(), undefined);
});
test('session guard is checked again after an asynchronous payment operation', async (t) => {
  const f = fixture(t);
  f.configure();
  let valid = true;
  f.onCreate = () => {
    valid = false;
    return f.success();
  };
  await assert.rejects(
    f.begin(f.checkout(), {
      assertCurrent() {
        if (!valid) throw Object.assign(Error('Synthetic revoked session'), { status: 403 });
      },
    }),
    status(403),
  );
  assert.equal(f.packages.status('org-a').active, false);
  assert.equal(f.row().fulfilled_at, null);
});
test('original owner revocation prevents webhook fulfillment but records real captured revenue', async (t) => {
  const f = fixture(t);
  f.configure({ testMode: false });
  await f.begin();
  f.db.prepare("UPDATE memberships SET status='revoked' WHERE account_id='owner-a'").run();
  f.onVerify = () => f.success();
  assert.equal((await f.payments.webhook(f.event(), {})).status, 'review');
  assert.equal(f.packages.status('org-a').active, false);
  const summary = f.payments.adminSummary('admin');
  assert.equal(summary.paidRevenueKopecks, '99000');
  assert.equal(summary.paidRevenueRub, 990);
  assert.equal(summary.orders[0].status, 'review');
});
test('test payment is labeled and excluded from actual revenue', async (t) => {
  const f = fixture(t);
  f.configure();
  await f.begin();
  f.onVerify = () => f.success();
  await f.payments.webhook(f.event(), {});
  const summary = f.payments.adminSummary('admin', 'org-a');
  assert.equal(summary.paidRevenueRub, 0);
  assert.equal(summary.orders[0].testMode, true);
  assert.equal(JSON.stringify(summary).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(summary).includes('owner@example.test'), false);
});
test('key rotation uses only the current central credential for the same merchant', async (t) => {
  const f = fixture(t);
  f.configure();
  const pending = await f.begin();
  f.configure({ secretKey: 'synthetic-rotated-secret' });
  await f.payments.payment(f.current, pending.id);
  assert.equal(f.configs.at(-1).secretKey, 'synthetic-rotated-secret');
  assert.equal(Object.hasOwn(f.data().seller, 'secretKey'), false);
  const saved = f.configure({ clearSecret: true, secretKey: undefined });
  assert.equal(saved.ready, false);
  assert.equal(saved.configured, false);
  assert.equal(saved.secretConfigured, false);
  assert.match(saved.securityNotice, /не отзывает/);
  const count = f.calls.length;
  await f.payments.payment(f.current, pending.id);
  await f.payments.webhook(f.event(), {});
  assert.equal(f.calls.length, count);
});
test('a changed merchant cannot reconcile another merchant order', async (t) => {
  const f = fixture(t);
  f.configure();
  const pending = await f.begin();
  f.configure({ shopId: '54321' });
  const count = f.calls.length;
  await f.payments.payment(f.current, pending.id);
  assert.equal((await f.payments.webhook(f.event(), {})).reconciliationRequired, true);
  assert.equal(f.calls.length, count);
  assert.equal(f.packages.status('org-a').active, false);
});
test('restored order is read only, has no checkout link and ignores old callbacks', async (t) => {
  const f = fixture(t);
  f.configure();
  const input = f.checkout(),
    pending = await f.begin(input);
  f.mutateOrder((data) => {
    data.restoredReview = true;
  });
  const count = f.calls.length;
  const result = await f.payments.payment(f.current, pending.id);
  assert.equal(result.status, 'review');
  assert.equal(result.confirmationUrl, null);
  assert.equal((await f.begin(input)).confirmationUrl, null);
  assert.equal((await f.payments.webhook(f.event(), {})).ignored, true);
  assert.equal(f.calls.length, count);
  assert.equal(f.packages.status('org-a').active, false);
});
test('restored completed payment remains history and cannot grant access again', async (t) => {
  const f = fixture(t);
  f.configure();
  const pending = await f.begin();
  f.onRead = () => f.success();
  await f.payments.payment(f.current, pending.id);
  f.mutateOrder((data) => {
    data.restoredReview = true;
  });
  const count = f.calls.length;
  const result = await f.payments.payment(f.current, pending.id);
  assert.equal(result.status, 'succeeded');
  assert.match(result.notice, /история/);
  assert.equal(result.confirmationUrl, null);
  await f.payments.webhook(f.event(), {});
  assert.equal(f.calls.length, count);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 1);
});
test('later conflicting provider state requires reconciliation without automatic package revocation', async (t) => {
  const f = fixture(t);
  f.configure();
  const pending = await f.begin();
  f.onRead = () => f.success();
  await f.payments.payment(f.current, pending.id);
  f.onVerify = () => f.dto({ status: 'canceled', confirmationUrl: null });
  await f.payments.webhook(f.event(), {});
  assert.equal(f.packages.status('org-a').active, true);
  assert.match(f.payments.adminSummary('admin').orders[0].notice, /сверка/);
});
