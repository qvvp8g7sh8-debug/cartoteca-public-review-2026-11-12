const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, status } = require('./helpers/billing-payment-fixture.cjs');

test('payment store stays unavailable before explicit schema preparation', (t) => {
  const f = fixture(t, { prepared: false });
  assert.equal(f.payments.available(), false);
  assert.equal(f.payments.publicConfig().ready, false);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.configure(), status(503));
});
test('merchant starts disabled and accepts an incomplete disabled fiscal draft', (t) => {
  const f = fixture(t);
  const initial = f.payments.config('admin');
  assert.equal(initial.configured, false);
  assert.equal(initial.testMode, true);
  assert.equal(initial.secretConfigured, false);
  const saved = f.configure({
    configured: false,
    shopId: '',
    secretKey: undefined,
    returnOrigin: '',
    receiptConfig: initial.receiptConfig,
  });
  assert.equal(saved.ready, false);
  assert.equal(saved.revision, 1);
  assert.equal(f.calls.length, 0);
});
test('settings hide keys, retain an omitted key and apply revision and idempotency guards', (t) => {
  const f = fixture(t),
    input = f.settings();
  const first = f.payments.adminSettings('admin', input);
  assert.equal(first.ready, true);
  assert.equal(first.secretConfigured, true);
  assert.equal(JSON.stringify(first).includes('synthetic-secret-only'), false);
  assert.equal(f.payments.adminSettings('admin', input).revision, 1);
  assert.throws(
    () => f.payments.adminSettings('admin', { ...input, shopId: '54321' }),
    status(409),
  );
  const update = f.settings();
  delete update.secretKey;
  assert.equal(f.payments.adminSettings('admin', update).secretConfigured, true);
  assert.throws(() => f.payments.adminSettings('owner-a', f.settings()), status(403));
  assert.throws(() => f.configure({ expectedRevision: 0 }), status(409));
});
test('owner authorization is fresh and checkout rejects card or unknown fields', async (t) => {
  const f = fixture(t);
  f.configure();
  await assert.rejects(
    f.payments.beginCheckout({ ...f.current, role: 'cosmetologist' }, f.checkout()),
    status(403),
  );
  await assert.rejects(f.begin(f.checkout({ cardNumber: '4242424242424242' })), status(400));
  f.db.prepare("UPDATE memberships SET status='revoked' WHERE account_id='owner-a'").run();
  await assert.rejects(f.begin(), status(403));
  assert.equal(f.calls.length, 0);
});
test('intent is durable before create, freezes package terms and never copies the secret', async (t) => {
  const f = fixture(t);
  f.configure();
  f.onCreate = (input) => {
    assert.equal(f.db.isTransaction, false);
    assert.equal(f.row().state, 'creating');
    assert.equal(input.idempotencyKey, f.row().id);
    assert.equal(f.data().receiptEmail, 'owner@example.test');
    assert.equal(Object.hasOwn(f.data().seller, 'secretKey'), false);
    assert.equal(Buffer.from(f.row().value).includes(Buffer.from('owner@example.test')), false);
    return f.dto();
  };
  const result = await f.begin();
  assert.equal(result.status, 'pending');
  assert.equal(result.checkoutId, result.id);
  assert.equal(result.package.priceKopecks, 99000);
  assert.equal(f.data().receiptEmail, null);
  assert.equal(JSON.stringify(result).includes('owner@example.test'), false);
  assert.equal(f.packages.status('org-a').active, false);
});
test('an existing order survives restart and reads the provider without another create', async (t) => {
  const f = fixture(t);
  f.configure();
  const input = f.checkout();
  const first = await f.begin(input);
  f.reopen();
  const replay = await f.begin(input);
  assert.equal(replay.id, first.id);
  assert.deepEqual(
    f.calls.map((x) => x.type),
    ['create', 'read'],
  );
  await assert.rejects(f.begin({ ...input, receiptEmail: 'another@example.test' }), status(409));
  await assert.rejects(f.begin(), status(409));
});
test('one persisted lease prevents a second concurrent create', async (t) => {
  const f = fixture(t);
  f.configure();
  const input = f.checkout();
  let resolve;
  f.onCreate = () =>
    new Promise((done) => {
      resolve = done;
    });
  const first = f.begin(input);
  const second = await f.begin(input);
  assert.equal(second.state, 'creating');
  assert.equal(f.calls.length, 1);
  resolve(f.dto());
  await first;
});
test('unknown create replays only the original payload and key within twenty four hours', async (t) => {
  const f = fixture(t);
  f.configure();
  const input = f.checkout();
  f.onCreate = () => {
    throw Object.assign(Error('Synthetic network outcome'), { outcomeUnknown: true });
  };
  assert.equal((await f.begin(input)).state, 'uncertain');
  const original = f.calls[0].input;
  f.save({ priceKopecks: 120000, taskLimit: 5 });
  f.configure({ receiptConfig: { ...f.receipt(), description: 'Different current description' } });
  f.onCreate = () => f.dto();
  const replay = await f.begin(input);
  assert.equal(replay.package.priceKopecks, 99000);
  assert.deepEqual(f.calls[1].input, original);
  assert.equal(f.configs[1].receiptConfig.description, 'Synthetic monthly package');
});
test('uncertain create past twenty four hours requires reconciliation without a new payment', async (t) => {
  const f = fixture(t);
  f.configure();
  const input = f.checkout();
  f.onCreate = () => {
    throw Object.assign(Error('Synthetic timeout'), { outcomeUnknown: true });
  };
  await f.begin(input);
  f.advance(24 * 60 * 60 * 1000);
  assert.equal((await f.begin(input)).status, 'review');
  assert.equal(f.calls.length, 1);
  assert.equal(f.data().receiptEmail, null);
});
test('a definitive create rejection clears receipt email and is never replayed', async (t) => {
  const f = fixture(t);
  f.configure();
  const input = f.checkout();
  f.onCreate = () => {
    throw Object.assign(Error('Synthetic rejection'), { outcomeUnknown: false });
  };
  assert.equal((await f.begin(input)).state, 'rejected');
  assert.equal(f.data().receiptEmail, null);
  await f.begin(input);
  assert.equal(f.calls.length, 1);
});

test('saved order amount, merchant and ownership cannot be rewritten or deleted', async (t) => {
  const f = fixture(t);
  f.configure();
  await f.begin();
  assert.throws(
    () =>
      f.db.prepare('UPDATE billing_payment_orders SET price_kopecks=1 WHERE id=?').run(f.row().id),
    /immutable/,
  );
  assert.throws(
    () =>
      f.db
        .prepare("UPDATE billing_payment_orders SET organization_id='org-b' WHERE id=?")
        .run(f.row().id),
    /immutable/,
  );
  assert.throws(
    () => f.db.prepare('DELETE FROM billing_payment_orders WHERE id=?').run(f.row().id),
    /immutable/,
  );
  assert.equal(f.row().price_kopecks, 99000);
});
