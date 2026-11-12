const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { multi } = require('./helpers/multi-service-billing-fixture.cjs');
const { status } = require('./helpers/billing-payment-fixture.cjs');
async function paid(t, { testMode = true } = {}) {
  const f = multi(t);
  if (!testMode) f.configure({ expectedRevision: 1, testMode: false });
  f.offer();
  const a = await f.begin(),
    b = await f.begin(f.checkout({ packageId: 'reports-year' }));
  await f.approve(a);
  await f.approve(b);
  f.voice = a.id;
  f.reports = b.id;
  f.action = (kind = 'refund', extra = {}) => ({
    requestId: crypto.randomUUID(),
    checkoutId: f.reports,
    kind,
    expectedRevision: f.payments.adminOrders('admin').orders.find((o) => o.id === f.reports)
      .revision,
    amountKopecks: 250000,
    receiptEmail: 'receipt@example.test',
    accessPolicy: 'keep',
    reason: 'Synthetic financial operation',
    ...extra,
  });
  return f;
}
test('confirmed full refund revokes only that service, keeps history and does not repeat POST', async (t) => {
  const f = await paid(t),
    input = f.action();
  const result = await f.payments.financialAction('admin', input);
  assert.equal(result.status, 'succeeded');
  assert.equal(f.entitlements.isServiceEnabled('org-a', 'reports'), false);
  assert(f.entitlements.isServiceEnabled('org-a'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 2);
  await f.payments.financialAction('admin', input);
  assert.equal(f.financialCreated.length, 1);
  const row = f.db.prepare('SELECT value FROM billing_financial_actions').get();
  assert.equal(f.context.open(row.value).receiptEmail, null);
});
test('partial refund preserves access unless explicitly revoked and never over-refunds', async (t) => {
  const f = await paid(t, { testMode: false });
  await f.payments.financialAction('admin', f.action('refund', { amountKopecks: 10000 }));
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
  await assert.rejects(
    f.payments.financialAction('admin', f.action('refund', { amountKopecks: 250000 })),
    status(400),
  );
  await f.payments.financialAction(
    'admin',
    f.action('refund', { amountKopecks: 10000, accessPolicy: 'revoke' }),
  );
  assert.equal(f.entitlements.isServiceEnabled('org-a', 'reports'), false);
  assert.equal(
    f.payments.serviceRevenues('admin').find((x) => x.code === 'reports').refundedKopecks,
    '20000',
  );
});
test('an unknown refund uses exactly the saved key and payload on retry without another refund object', async (t) => {
  const f = await paid(t);
  f.failFinancialOnce = true;
  const input = f.action();
  const first = await f.payments.financialAction('admin', input);
  assert.equal(first.status, 'uncertain');
  const second = await f.payments.financialAction('admin', input);
  assert.equal(second.status, 'succeeded');
  assert.equal(f.idempotent.size, 1);
  assert.equal(
    f.financialCreated[0].input.idempotencyKey,
    f.financialCreated[1].input.idempotencyKey,
  );
  assert.deepEqual(f.financialCreated[0].input, f.financialCreated[1].input);
});
test('unknown operations past24h stop POST retries; reference check can resolve only the matching object', async (t) => {
  const f = await paid(t);
  f.failFinancialOnce = true;
  const input = f.action();
  const first = await f.payments.financialAction('admin', input);
  f.advance(86400001);
  assert.equal((await f.payments.financialAction('admin', input)).status, 'review');
  assert.equal(f.financialCreated.length, 1);
  const saved = [...f.idempotent.values()][0];
  assert.equal(
    (
      await f.payments.refreshFinancialAction('admin', {
        id: first.id,
        referenceId: saved.id,
        reason: 'Verified provider reference',
      })
    ).status,
    'succeeded',
  );
});
test('pending refund keeps the service until confirmation and refresh is GET-only', async (t) => {
  const f = await paid(t);
  f.financialStatus = 'pending';
  const first = await f.payments.financialAction('admin', f.action());
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
  f.financialRemote.get(first.providerId).status = 'succeeded';
  await f.payments.refreshFinancialAction('admin', { id: first.id });
  assert.equal(f.financialCreated.length, 1);
  assert.equal(f.entitlements.isServiceEnabled('org-a', 'reports'), false);
});
test('closing receipt requires actual prepayment and explicit service-provided confirmation', async (t) => {
  const f = await paid(t);
  await assert.rejects(
    f.payments.financialAction('admin', f.action('receipt', { serviceProvided: true })),
    status(409),
  );
});
test('a full-prepayment order can get one closing receipt, without another charge or access change', async (t) => {
  const f = multi(t);
  f.configure({
    expectedRevision: 1,
    receiptConfig: { ...f.receipt(), paymentMode: 'full_prepayment' },
  });
  f.offer();
  const order = await f.begin(f.checkout({ packageId: 'reports-year' }));
  await f.approve(order);
  const input = {
    requestId: crypto.randomUUID(),
    checkoutId: order.id,
    kind: 'receipt',
    expectedRevision: f.payments.adminOrders('admin').orders[0].revision,
    serviceProvided: true,
    receiptEmail: 'receipt@example.test',
    reason: 'Synthetic provision confirmed',
  };
  assert.equal((await f.payments.financialAction('admin', input)).status, 'succeeded');
  assert.equal(f.created.length, 1);
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
  await assert.rejects(
    f.payments.financialAction('admin', {
      ...input,
      requestId: crypto.randomUUID(),
      expectedRevision: f.payments.adminOrders('admin').orders[0].revision,
    }),
    status(409),
  );
});
test('owners, stale revisions and restored orders cannot start financial mutations', async (t) => {
  const f = await paid(t);
  await assert.rejects(f.payments.financialAction('owner-a', f.action()), status(403));
  await assert.rejects(
    f.payments.financialAction('admin', f.action('refund', { expectedRevision: 999 })),
    status(409),
  );
  const row = f.db.prepare('SELECT * FROM billing_payment_orders WHERE id=?').get(f.reports),
    data = f.context.open(row.value);
  data.restoredReview = true;
  f.db
    .prepare('UPDATE billing_payment_orders SET value=? WHERE id=?')
    .run(f.context.seal(data), row.id);
  await assert.rejects(f.payments.financialAction('admin', f.action()), status(409));
  assert.equal(f.financialCreated.length, 0);
});
test('transport OFF blocks refund and receipt creation before intent persistence', async (t) => {
  const f = await paid(t);
  f.context.paymentNetworkEnabled = false;
  f.reopen();
  await assert.rejects(f.payments.financialAction('admin', f.action()), status(503));
  assert.equal(f.financialCreated.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_financial_actions').get().n, 0);
});

test('refund callback verifies the saved provider object and never trusts the posted amount or status', async (t) => {
  const f = await paid(t);
  f.financialStatus = 'pending';
  const action = await f.payments.financialAction('admin', f.action());
  const event = {
    type: 'notification',
    event: 'refund.succeeded',
    object: { id: action.providerId, amount: { value: '2500.00' }, status: 'succeeded' },
  };
  assert.equal((await f.payments.webhook(event)).status, 'pending');
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
  f.financialRemote.get(action.providerId).status = 'succeeded';
  await f.payments.webhook(event);
  await f.payments.webhook(event);
  assert.equal(f.entitlements.isServiceEnabled('org-a', 'reports'), false);
  assert(f.entitlements.isServiceEnabled('org-a'));
  assert.equal(f.financialCreated.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_grant_revocations').get().n, 1);
});

test('owner status check synchronizes known pending financial objects using GET only', async (t) => {
  const f = await paid(t);
  f.financialStatus = 'pending';
  const action = await f.payments.financialAction('admin', f.action());
  f.financialRemote.get(action.providerId).status = 'succeeded';
  const result = await f.payments.payment(f.current, f.reports);
  assert.equal(result.refund.knownRefundedKopecks, 250000);
  assert.equal(f.financialCreated.length, 1);
});

test('foreign refund object and callback while network OFF cannot change another service', async (t) => {
  const f = await paid(t);
  f.financialStatus = 'pending';
  const action = await f.payments.financialAction('admin', f.action());
  const foreign = f.financialRemote.get(action.providerId);
  foreign.paymentId = crypto.randomUUID();
  foreign.status = 'succeeded';
  await assert.rejects(
    f.payments.webhook({
      type: 'notification',
      event: 'refund.succeeded',
      object: { id: action.providerId },
    }),
    status(409),
  );
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
  f.context.paymentNetworkEnabled = false;
  f.reopen();
  assert.equal(
    (
      await f.payments.webhook({
        type: 'notification',
        event: 'refund.succeeded',
        object: { id: action.providerId },
      })
    ).ignored,
    true,
  );
  assert(f.packages.status('org-a', 'reports').active);
});


test('binding a receipt for a different settlement amount cannot confirm the intended full offset',async t=>{
 const f=multi(t);f.configure({expectedRevision:1,receiptConfig:{...f.receipt(),paymentMode:'full_prepayment'}});f.offer();
 const order=await f.begin(f.checkout({packageId:'reports-year'}));await f.approve(order);f.failFinancialOnce=true;
 const action=await f.payments.financialAction('admin',{requestId:crypto.randomUUID(),checkoutId:order.id,kind:'receipt',expectedRevision:f.payments.adminOrders('admin').orders[0].revision,serviceProvided:true,receiptEmail:'receipt@example.test',reason:'Synthetic provision'});
 const dto=[...f.financialRemote.values()][0];dto.settledKopecks=100;
 await assert.rejects(f.payments.refreshFinancialAction('admin',{id:action.id,referenceId:dto.id,reason:'Synthetic reference'}),status(409));
 assert.equal(f.db.prepare('SELECT state FROM billing_financial_actions').get().state,'uncertain');
});
