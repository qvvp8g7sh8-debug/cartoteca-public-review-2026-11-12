const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, status, PAYMENT } = require('./helpers/billing-payment-fixture.cjs');
async function pending(t) {
  const f = fixture(t);
  f.configure();
  await f.begin();
  return f;
}
test('review requires active global administrator, exact version and known action', async (t) => {
  const f = await pending(t);
  await assert.rejects(f.payments.review('owner-a', f.reviewInput()), status(403));
  await assert.rejects(f.review({ expectedRevision: 999 }), status(409));
  await assert.rejects(f.review({ action: 'approve_paid' }), status(400));
  assert.equal(f.calls.length, 1);
});
test('admin reconciliation confirms a known payment and permanently replays the same operation', async (t) => {
  const f = await pending(t),
    input = f.reviewInput();
  f.onRead = () => f.success();
  const result = await f.payments.review('admin', input);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.reconciliation.status, 'checked');
  const calls = f.calls.length;
  f.reopen();
  assert.equal((await f.payments.review('admin', input)).operation.replayed, true);
  assert.equal(f.calls.length, calls);
  await assert.rejects(
    f.payments.review('admin', { ...input, reason: 'Different operation body' }),
    status(409),
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 1);
});
test('unknown payment older than the idempotency window is recovered only from a verified existing ID', async (t) => {
  const f = fixture(t);
  f.configure();
  f.onCreate = () => {
    throw Object.assign(Error('Synthetic unknown'), { outcomeUnknown: true });
  };
  await f.begin();
  f.advance(86400001);
  f.onRead = () => f.success();
  const result = await f.review({ paymentId: PAYMENT });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.providerPaymentId, PAYMENT);
  assert.equal(f.data().receiptEmail, null);
  assert.deepEqual(
    f.calls.map((x) => x.type),
    ['create', 'read'],
  );
});
test('unknown order cannot be closed as unpaid or administratively recreated', async (t) => {
  const f = fixture(t);
  f.configure();
  f.onCreate = () => {
    throw Object.assign(Error('Synthetic unknown'), { outcomeUnknown: true });
  };
  await f.begin();
  const before = f.calls.length;
  assert.equal((await f.review()).operation.code, 'payment_id_required');
  const blocked = await f.review({ action: 'retry_create' });
  assert.equal(blocked.operation.code, 'safe_retry_disabled');
  assert.equal(blocked.canRetryCreate, false);
  assert.equal(f.calls.length, before);
  assert.equal(f.row().state, 'uncertain');
  await assert.rejects(f.review({ action: 'close_unpaid' }), status(400));
});
test('explicit reconciliation restores a frozen order without issuing a second package', async (t) => {
  const f = await pending(t);
  f.mutateOrder((data) => {
    data.restoredReview = true;
  });
  f.onRead = () => f.success();
  assert.equal((await f.review()).status, 'succeeded');
  assert.equal(f.data().restoredReview, false);
  f.mutateOrder((data) => {
    data.restoredReview = true;
  });
  await f.review();
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 1);
});
test('mismatched payment proof cannot grant a package or clear restored review', async (t) => {
  const f = await pending(t);
  f.mutateOrder((data) => {
    data.restoredReview = true;
  });
  f.onRead = () => f.success({ amountKopecks: 1 });
  const result = await f.review();
  assert.equal(result.operation.code, 'payment_mismatch');
  assert.equal(f.data().restoredReview, true);
  assert.equal(f.packages.status('org-a').active, false);
});
test('concurrent operation replay waits on the same durable intent', async (t) => {
  const f = await pending(t),
    input = f.reviewInput();
  let resolve;
  f.onRead = () =>
    new Promise((done) => {
      resolve = done;
    });
  const first = f.payments.review('admin', input),
    second = await f.payments.review('admin', input);
  assert.equal(second.operation.status, 'pending');
  assert.equal(f.calls.filter((x) => x.type === 'read').length, 1);
  resolve(f.success());
  assert.equal((await first).status, 'succeeded');
});
test('revoked session after provider read blocks fulfillment and allows the same operation to recover later', async (t) => {
  const f = await pending(t),
    input = f.reviewInput();
  let valid = true;
  f.onRead = () => {
    valid = false;
    return f.success();
  };
  const guard = () => {
    if (!valid) throw Object.assign(Error('Synthetic revoked session'), { status: 403 });
  };
  await assert.rejects(f.payments.review('admin', input, { assertCurrent: guard }), status(403));
  assert.equal(f.packages.status('org-a').active, false);
  f.advance(30001);
  valid = true;
  f.onRead = () => f.success();
  assert.equal(
    (await f.payments.review('admin', input, { assertCurrent: guard })).status,
    'succeeded',
  );
});
test('a changed order during asynchronous reconciliation rejects the stale response', async (t) => {
  const f = await pending(t);
  f.onRead = () => {
    f.mutateOrder((data) => {
      data.revision++;
    });
    return f.success();
  };
  const result = await f.review();
  assert.equal(result.operation.code, 'order_changed');
  assert.equal(f.packages.status('org-a').active, false);
});
test('emergency key removal during reconciliation records paid proof but never grants access', async (t) => {
  const f = fixture(t);
  f.configure({ testMode: false });
  await f.begin();
  f.onRead = () => {
    f.configure({ clearSecret: true, secretKey: undefined });
    return f.success();
  };
  const result = await f.review();
  assert.equal(result.operation.code, 'paid_access_blocked');
  assert.equal(result.status, 'review');
  assert.equal(f.packages.status('org-a').active, false);
  assert.equal(f.payments.adminSummary('admin').paidRevenueRub, 990);
});
test('unconfigured or changed merchant blocks reconciliation without any network attempt', async (t) => {
  const f = await pending(t);
  f.configure({ shopId: '54321' });
  const calls = f.calls.length;
  const result = await f.review();
  assert.equal(result.operation.code, 'merchant_unavailable');
  assert.equal(f.calls.length, calls);
});
test('failed read releases its review lock and a fresh operation may retry a safe GET', async (t) => {
  const f = await pending(t);
  f.onRead = () => {
    throw Error('Synthetic unavailable');
  };
  assert.equal((await f.review()).operation.code, 'provider_unavailable');
  assert.equal(f.data().reviewLock, undefined);
  f.onRead = () => f.success();
  assert.equal((await f.review()).status, 'succeeded');
});
test('only a verified canceled payment frees a pending organization purchase', async (t) => {
  const f = await pending(t);
  f.onRead = () => f.dto({ status: 'canceled', confirmationUrl: null });
  assert.equal((await f.review()).status, 'canceled');
  assert.equal(f.packages.status('org-a').active, false);
  f.advance(1);
  f.onCreate = () => f.dto({ paymentId: '28646d50-000f-5000-a000-1fe4f81e5e93' });
  assert.equal((await f.begin()).status, 'pending');
});

test('completed review replay uses current restored state and never returns an archived checkout link', async (t) => {
  const f = await pending(t),
    input = f.reviewInput();
  const first = await f.payments.review('admin', input);
  assert.ok(first.confirmationUrl);
  f.mutateOrder((data) => {
    data.restoredReview = true;
  });
  const calls = f.calls.length;
  const replay = await f.payments.review('admin', input);
  assert.equal(replay.operation.replayed, true);
  assert.equal(replay.operation.code, 'restored_requires_reconcile');
  assert.equal(replay.status, 'review');
  assert.equal(replay.confirmationUrl, null);
  assert.equal(f.calls.length, calls);
  assert.equal(f.data().restoredReview, true);
  assert.equal(f.packages.status('org-a').active, false);
});
