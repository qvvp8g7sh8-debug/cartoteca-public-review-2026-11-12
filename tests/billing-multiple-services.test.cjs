const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { fixture, status } = require('./helpers/billing-payment-fixture.cjs');
const { multiServiceSchema } = require('../src/server/modules/billing/multi-service-schema.cjs');
const { createPackageStore } = require('../src/server/modules/billing/package-store.cjs');
const { createPaymentStore } = require('../src/server/modules/billing/payment-store.cjs');
const { createBillingEntitlements } = require('../src/server/modules/billing/entitlements.cjs');
const { multi } = require('./helpers/multi-service-billing-fixture.cjs');
test('schema20 defaults retain historical voice offers and reject unknown service references', (t) => {
  const f = multi(t);
  assert.equal(f.packages.catalog()[0].serviceCode, 'voice-assistant');
  assert.throws(() =>
    f.db.prepare("INSERT INTO billing_services VALUES('voice-assistant','duplicate',1)").run(),
  );
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
test('one organization can own voice and another service independently', (t) => {
  const f = multi(t);
  f.offer();
  for (const packageId of ['voice-start', 'reports-year'])
    f.packages.grantTrial('admin', f.command({ orgId: 'org-a', packageId }));
  assert(f.packages.status('org-a').active);
  assert(f.packages.status('org-a', 'reports').active);
  assert.equal(f.packages.status('org-a', 'reports').endsAt, Date.parse('2027-01-31T12:00:00Z'));
  assert.equal(f.packages.status('org-b', 'reports').active, false);
});
test('pending payments fence only the same service, including concurrent checkout', async (t) => {
  const f = multi(t);
  f.offer();
  const [voice, reports] = await Promise.all([
    f.begin(),
    f.begin(f.checkout({ packageId: 'reports-year' })),
  ]);
  assert.equal(voice.status, 'pending');
  assert.equal(reports.status, 'pending');
  assert.equal(f.created.length, 2);
  await assert.rejects(f.begin(f.checkout()), status(409));
});
test('confirmed payments activate only their service and duplicate notifications do not issue another grant', async (t) => {
  const f = multi(t);
  f.offer();
  const a = await f.begin(),
    b = await f.begin(f.checkout({ packageId: 'reports-year' }));
  await f.approve(b);
  assert.equal(f.packages.status('org-a').active, false);
  assert(f.packages.status('org-a', 'reports').active);
  await f.approve(a);
  await f.approve(a);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM billing_package_grants').get().n, 2);
  assert(f.entitlements.isServiceEnabled('org-a', 'voice-assistant'));
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
});
test('owner can pause reports without changing voice access; stale revisions and staff are denied', (t) => {
  const f = multi(t);
  f.offer();
  for (const packageId of ['voice-start', 'reports-year'])
    f.packages.grantTrial('admin', f.command({ orgId: 'org-a', packageId }));
  const request = {
    serviceCode: 'reports',
    enabled: false,
    expectedRevision: 1,
    requestId: crypto.randomUUID(),
  };
  f.entitlements.setConnection(f.current, request);
  f.entitlements.setConnection(f.current, request);
  assert.equal(f.entitlements.isServiceEnabled('org-a', 'reports'), false);
  assert(f.entitlements.isServiceEnabled('org-a'));
  assert.throws(
    () => f.entitlements.setConnection(f.current, { ...request, requestId: crypto.randomUUID() }),
    status(409),
  );
  assert.throws(
    () =>
      f.entitlements.setConnection(
        { ...f.current, accountId: 'staff-a', role: 'cosmetologist' },
        request,
      ),
    status(403),
  );
});
test('each service has separate quota and consumed voice units do not consume other units', (t) => {
  const f = multi(t);
  f.offer({ quotaUnit: 'units', periodMonths: 1, taskLimit: 2 });
  for (const packageId of ['voice-start', 'reports-year'])
    f.packages.grantTrial('admin', f.command({ orgId: 'org-a', packageId }));
  const request = {
    current: f.current,
    requestId: crypto.randomUUID(),
    payloadHash: 'a'.repeat(64),
  };
  const ticket = f.packages.reserveTask({ ...request, serviceCode: 'reports' });
  f.packages.acceptTask(ticket);
  assert.equal(f.packages.status('org-a', 'reports').remainingTasks, 1);
  assert.equal(f.packages.status('org-a').remainingTasks, 3);
  assert.throws(() => f.packages.reserveTask(request), status(409));
  assert.throws(
    () => f.packages.requireAcceptedTask({ current: f.current, requestId: request.requestId }),
    status(402),
  );
  f.packages.requireAcceptedTask({
    current: f.current,
    requestId: request.requestId,
    serviceCode: 'reports',
  });
});
test('catalog changes after checkout do not change the purchased service period or units', async (t) => {
  const f = multi(t);
  f.offer();
  const pending = await f.begin(f.checkout({ packageId: 'reports-year' }));
  f.offer({
    expectedRevision: 1,
    periodMonths: 1,
    quotaUnit: 'units',
    taskLimit: 99,
    title: 'Другие условия',
  });
  await f.approve(pending);
  const active = f.packages.status('org-a', 'reports');
  assert.equal(active.periodMonths, 12);
  assert.equal(active.quotaUnit, 'access');
  assert.equal(active.taskLimit, 1);
  assert.equal(f.created[0].config.receiptConfig.description, 'Годовой доступ к отчётам');
});
test('package identity cannot be reassigned to another service and order service stays immutable', async (t) => {
  const f = multi(t);
  f.offer();
  await f.begin(f.checkout({ packageId: 'reports-year' }));
  assert.throws(
    () => f.offer({ expectedRevision: 1, serviceCode: 'other', serviceTitle: 'Other' }),
    status(409),
  );
  assert.throws(
    () => f.db.prepare("UPDATE billing_payment_orders SET service_code='voice-assistant'").run(),
    /immutable/,
  );
});
test('expiring voice does not expire the annual service and access packages do not spend tasks', (t) => {
  const f = multi(t);
  f.offer();
  for (const packageId of ['voice-start', 'reports-year'])
    f.packages.grantTrial('admin', f.command({ orgId: 'org-a', packageId }));
  assert.throws(
    () =>
      f.packages.reserveTask({
        current: f.current,
        requestId: crypto.randomUUID(),
        payloadHash: 'a'.repeat(64),
        serviceCode: 'reports',
      }),
    status(400),
  );
  f.advance(32 * 86400000);
  assert.equal(f.entitlements.isServiceEnabled('org-a'), false);
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
});
test('real network switch stays closed for every service while trials remain available', async (t) => {
  const f = multi(t, { network: false });
  f.offer();
  await assert.rejects(f.begin(f.checkout({ packageId: 'reports-year' })), status(503));
  assert.equal(f.created.length, 0);
  f.packages.grantTrial('admin', f.command({ orgId: 'org-a', packageId: 'reports-year' }));
  assert(f.entitlements.isServiceEnabled('org-a', 'reports'));
});
test('owner view groups subscriptions and payment history without leaking another organization or credentials', async (t) => {
  const f = multi(t);
  f.offer();
  await f.begin(f.checkout({ packageId: 'reports-year' }));
  const dto = f.entitlements.view(f.current);
  assert.equal(dto.services.length, 2);
  assert.equal(dto.orders.length, 1);
  const other = f.entitlements.view({
    ...f.current,
    organizationId: 'org-b',
    accountId: 'owner-b',
  });
  assert.equal(other.orders.length, 0);
  assert.doesNotMatch(JSON.stringify(dto), /synthetic-secret|credential_hash|packageGrantId/);
});

test('package-specific fiscal settings stay private and frozen after checkout', async (t) => {
  const f = multi(t);
  f.offer({
    receipt: {
      description: 'Годовое право на отчёты',
      paymentMode: 'full_prepayment',
      paymentSubject: 'property_right',
      vatCode: 2,
    },
  });
  assert.equal(
    f.packages.catalog().find((item) => item.serviceCode === 'reports').receipt,
    undefined,
  );
  const order = await f.begin(f.checkout({ packageId: 'reports-year' }));
  f.offer({
    expectedRevision: 1,
    receipt: { description: 'Иное описание', paymentMode: 'full_payment', vatCode: 1 },
  });
  const row = f.db.prepare('SELECT value FROM billing_payment_orders WHERE id=?').get(order.id),
    saved = f.context.open(row.value).seller.receiptConfig;
  assert.equal(saved.description, 'Годовое право на отчёты');
  assert.equal(saved.paymentMode, 'full_prepayment');
  assert.equal(saved.paymentSubject, 'property_right');
  assert.equal(saved.vatCode, 2);
});

test('access-only quota rejects a hidden unit count and per-service expenses use positive cost totals', (t) => {
  const f = multi(t);
  assert.throws(() => f.offer({ taskLimit: 5 }), status(400));
  f.offer();
  f.db.exec(require('../src/server/modules/billing/wallet-schema.cjs').walletSchema);
  f.db.exec(
    "INSERT INTO billing_wallets(id,organization_id) VALUES('platform',NULL),('org:org-a','org-a')",
  );
  for (const [wallet, amount] of [
    ['platform', -1250000],
    ['org:org-a', -9000000],
  ])
    f.db
      .prepare(
        "INSERT INTO billing_entries(id,wallet_id,organization_id,kind,service,amount_microrub,balance_after_microrub,idempotency_key,fingerprint,created_at,value) VALUES(?,?,'org-a','expense','reports',?,0,?,'synthetic',1,?)",
      )
      .run(crypto.randomUUID(), wallet, amount, crypto.randomUUID(), f.context.seal({}));
  assert.equal(
    f.payments.serviceRevenues('admin', 'org-a').find((x) => x.code === 'reports')
      .providerCostMicrorub,
    '1250000',
  );
  assert.equal(
    f.payments.serviceRevenues('admin', 'org-b').find((x) => x.code === 'reports')
      .providerCostMicrorub,
    null,
  );
});
