const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBillingBrowserFixture } = require('./helpers/billing-browser-fixture.cjs');
const forbidden = (error) => error.status === 403;
async function fixture(t) {
  const f = await createBillingBrowserFixture(t, { paymentNetworkEnabled: false });
  f.platform.billing.packages.savePackage(
    f.admin.accountId,
    f.command({
      id: 'reports',
      title: 'Synthetic reporting package',
      priceKopecks: 100000,
      taskLimit: 25,
      enabled: true,
      expectedRevision: 0,
    }),
  );
  f.payment = (
    actor = f.owner,
    {
      price = 100000,
      state = 'paid',
      created = Date.now(),
      testMode = false,
      paid = state === 'paid',
      fulfilled = state === 'paid',
      detail = {},
    } = {},
  ) => {
    const id = crypto.randomUUID(),
      providerId = crypto.randomUUID();
    const order = {
      id,
      organizationId: actor.organizationId,
      accountId: actor.accountId,
      packageId: 'reports',
      packageVersion: 1,
      title: 'Synthetic reporting package',
      priceKopecks: price,
      taskLimit: 25,
      createdAt: created,
    };
    f.database.db
      .prepare(
        `INSERT INTO billing_payment_orders(id,organization_id,account_id,request_id,package_id,price_kopecks,state,provider_payment_id,provider_status,config_revision,shop_id,test_mode,created_at,changed_at,paid_confirmed_at,fulfilled_at,value) VALUES(?,?,?,?,?,?,?,?,?,1,'12345',?,?,?,?,?,?)`,
      )
      .run(
        id,
        actor.organizationId,
        actor.accountId,
        crypto.randomUUID(),
        'reports',
        price,
        state,
        providerId,
        paid ? 'succeeded' : 'canceled',
        Number(testMode),
        created,
        created,
        paid ? created : null,
        fulfilled ? created : null,
        f.database.seal({ ...detail, revision: 1, order }),
      );
    return { id, providerId, created };
  };
  f.expense = (actor, rubles, uncertain = false) => {
    const held = f.platform.billing.wallet.reserve({
      organizationId: actor.organizationId,
      accountId: actor.accountId,
      service: 'voice-assistant',
      kind: 'llm',
      provider: 'timeweb',
      amountRub: rubles,
      packageCovered: true,
    });
    f.platform.billing.wallet.settle(held.id, { actualRub: uncertain ? null : rubles, uncertain });
  };
  return f;
}

test('organization finance totals cannot contain another cabinet revenue, expense or grants', async (t) => {
  const f = await fixture(t),
    admin = f.platform.billing.admin;
  f.payment(f.owner, { price: 100000 });
  f.payment(f.other, { price: 500000 });
  f.payment(f.owner, { price: 9900000, testMode: true });
  f.payment(f.other, { price: 99000, state: 'canceled' });
  f.expense(f.owner, 100);
  f.expense(f.other, 250, true);
  f.platform.billing.packages.grantTrial(
    f.admin.accountId,
    f.command({ orgId: f.owner.organizationId, packageId: 'reports' }),
  );
  const a = admin.view(f.admin.accountId, { organizationId: f.owner.organizationId }),
    b = admin.view(f.admin.accountId, { organizationId: f.other.organizationId }),
    all = admin.summary(f.admin.accountId);
  assert.equal(a.summary.paidRevenueRub, 1000);
  assert.equal(a.summary.providerCostRub, 100);
  assert.equal(b.summary.paidRevenueRub, 5000);
  assert.equal(b.summary.providerCostRub, 250);
  assert.equal(a.summary.trialGrants, 1);
  assert.equal(b.summary.trialGrants, 0);
  assert.equal(a.summary.activePackages, 1);
  assert.equal(b.summary.activePackages, 0);
  assert.equal(a.summary.uncertainCalls, 0);
  assert.equal(b.summary.uncertainCalls, 1);
  assert.equal(all.summary.paidRevenueRub, 6000);
  assert.equal(all.summary.providerCostRub, 350);
  assert.equal(a.scope.type, 'organization');
  assert.equal(a.scope.organizationId, f.owner.organizationId);
  assert.equal(all.scope.type, 'platform');
  assert.ok(all.periodLabel);
  assert.ok(a.orders.every((order) => order.organizationId === f.owner.organizationId));
  assert.equal(f.providerCalls.length, 0);
});

test('overview summary exposes only totals and scope without merchant, catalogue or order payloads', async (t) => {
  const f = await fixture(t),
    db = f.database.db;
  const before = db.prepare('SELECT count(*) n FROM platform_audit').get().n;
  const summary = f.platform.billing.admin.summary(f.admin.accountId);
  assert.equal(summary.available, true);
  for (const field of [
    'orders',
    'organizations',
    'packages',
    'paymentConfiguration',
    'secretKey',
    'credential',
  ])
    assert.equal(field in summary, false);
  assert.equal(db.prepare('SELECT count(*) n FROM platform_audit').get().n, before);
  assert.equal(db.prepare('SELECT count(*) n FROM billing_wallets').get().n, 0);
  assert.equal(f.providerCalls.length, 0);
});

test('all cabinet finance rows remain reachable beyond the first twenty without writes', async (t) => {
  const f = await fixture(t),
    db = f.database.db;
  for (let i = 0; i < 25; i++)
    db.prepare('INSERT INTO organizations(id,value,slug,status,created_at) VALUES(?,?,?,?,?)').run(
      crypto.randomUUID(),
      f.database.seal({ name: 'Synthetic page ' + i }),
      'synthetic-report-' + i,
      'active',
      100 + i,
    );
  const first = f.platform.billing.admin.organizations(f.admin.accountId),
    second = f.platform.billing.admin.organizations(f.admin.accountId, {
      offset: first.nextOffset,
    });
  assert.equal(first.organizations.length, 20);
  assert.equal(first.total, 27);
  assert.equal(second.organizations.length, 7);
  assert.equal(second.nextOffset, null);
  assert.equal(
    new Set([...first.organizations, ...second.organizations].map((row) => row.organizationId))
      .size,
    27,
  );
  assert.equal(db.prepare('SELECT count(*) n FROM billing_wallets').get().n, 0);
  for (const offset of [-1, 1.5, 'invalid', 1000001])
    assert.throws(
      () => f.platform.billing.admin.organizations(f.admin.accountId, { offset }),
      (error) => error.status === 400,
    );
});

test('keyset payment history reaches old orders with equal timestamps and exact search', async (t) => {
  const f = await fixture(t),
    api = f.platform.billing.admin;
  const seeded = Array.from({ length: 73 }, () =>
    f.payment(f.owner, { state: 'canceled', created: 1234567890 }),
  );
  const first = api.orders(f.admin.accountId, { organizationId: f.owner.organizationId });
  assert.equal(first.orders.length, 50);
  assert.ok(first.nextCursor);
  const second = api.orders(f.admin.accountId, {
    organizationId: f.owner.organizationId,
    before: first.nextCursor,
  });
  assert.equal(second.orders.length, 23);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.orders, ...second.orders].map((order) => order.id)).size, 73);
  const old = second.orders.at(-1),
    byOrder = api.orders(f.admin.accountId, { q: old.id }),
    provider = seeded.find((item) => item.id === old.id).providerId;
  assert.equal(byOrder.orders[0].id, old.id);
  assert.equal(api.orders(f.admin.accountId, { q: provider.toUpperCase() }).orders[0].id, old.id);
  assert.equal(
    api.orders(f.admin.accountId, { organizationId: f.other.organizationId, q: old.id }).orders
      .length,
    0,
  );
  assert.equal(api.view(f.admin.accountId).ordersNextCursor, first.nextCursor);
});

test('payment filters distinguish confirmed money and an unresolved paid package', async (t) => {
  const f = await fixture(t),
    api = f.platform.billing.admin;
  const review = f.payment(f.owner, { state: 'review', paid: true, fulfilled: false });
  const pending = f.payment(f.other, { state: 'pending', paid: false, fulfilled: false });
  f.payment(f.other, { state: 'rejected', paid: false, fulfilled: false });
  assert.equal(api.orders(f.admin.accountId, { status: 'attention' }).orders[0].id, review.id);
  assert.equal(api.orders(f.admin.accountId, { status: 'paid' }).orders[0].id, review.id);
  assert.equal(api.orders(f.admin.accountId, { status: 'pending' }).orders[0].id, pending.id);
  assert.equal(api.orders(f.admin.accountId, { status: 'rejected' }).orders.length, 1);
  assert.equal(api.orders(f.admin.accountId, { status: 'paid' }).orders[0].status, 'review');
  assert.equal(api.orders(f.admin.accountId, { status: 'canceled' }).orders.length, 0);
});

test('new reporting endpoints reject foreign roles and malformed cursors before any provider call', async (t) => {
  const f = await fixture(t),
    api = f.platform.billing.admin;
  for (const method of ['summary', 'organizations', 'orders'])
    for (const actor of [f.owner, f.other, f.staff.salon_admin, f.staff.cosmetologist])
      assert.throws(() => api[method](actor.accountId), forbidden);
  for (const input of [
    { q: 'not-an-id' },
    { status: 'all OR 1=1' },
    { before: '9999999999999999:bad' },
    { before: '1:bad:extra' },
    { limit: 99999 },
  ])
    assert.throws(
      () => api.orders(f.admin.accountId, input),
      (error) => error.status === 400,
    );
  assert.equal(f.providerCalls.length, 0);
});

test('attention scan reaches encrypted review flags on old completed payments without losing its cursor', async (t) => {
  const f = await fixture(t),
    api = f.platform.billing.admin;
  const details = [
    { restoredReview: true },
    { refundReview: { requestedAt: 1 } },
    { receiptReview: { requestedAt: 1 } },
    { reconciliation: { status: 'blocked', code: 'provider_unavailable' } },
  ];
  const expected = [];
  for (let i = 0; i < 241; i++) {
    const item = f.payment(f.owner, { created: 1000 + i, detail: details[i] || {} });
    if (i < 4) expected.push(item.id);
  }
  const first = api.orders(f.admin.accountId, { status: 'attention' });
  assert.equal(first.orders.length, 0);
  assert.ok(first.nextCursor);
  const next = api.orders(f.admin.accountId, { status: 'attention', before: first.nextCursor });
  assert.deepEqual(next.orders.map((item) => item.id).sort(), expected.sort());
  assert.equal(next.nextCursor, null);
  for (const id of expected)
    assert.equal(api.orders(f.admin.accountId, { status: 'attention', q: id }).orders[0].id, id);
});

test('exact revenue and expense strings survive totals above the JavaScript safe-integer sum', async (t) => {
  const f = await fixture(t),
    api = f.platform.billing.admin;
  f.payment(f.owner, { price: Number.MAX_SAFE_INTEGER });
  f.payment(f.owner, { price: 2 });
  f.expense(f.owner, 100.123456);
  const summary = api.summary(f.admin.accountId),
    local = api.view(f.admin.accountId, { organizationId: f.owner.organizationId });
  assert.equal(summary.summary.paidRevenueKopecks, '9007199254740993');
  assert.equal(summary.summary.providerCostMicrorub, '100123456');
  assert.equal(local.summary.paidRevenueKopecks, '9007199254740993');
  assert.equal(local.organizations[0].paidKopecks, '9007199254740993');
  assert.equal(local.organizations[0].costMicrorub, '100123456');
});
