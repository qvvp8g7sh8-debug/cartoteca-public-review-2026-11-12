const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, status } = require('./helpers/billing-payment-fixture.cjs');
const { configuration } = require('../src/server/config.cjs');
const { gatedRelease } = require('../src/server/application/release-gate.cjs');
const { runtimeOptions } = require('../src/server/application/process-role.cjs');

test('payment transport defaults OFF and accepts only an explicit boolean/environment opt-in', () => {
  assert.equal(configuration({}, {}).paymentNetworkEnabled, false);
  assert.equal(
    configuration({}, { CARTOTECA_PAYMENT_NETWORK_ENABLED: '0' }).paymentNetworkEnabled,
    false,
  );
  assert.equal(
    configuration({}, { CARTOTECA_PAYMENT_NETWORK_ENABLED: '1' }).paymentNetworkEnabled,
    true,
  );
  assert.equal(
    configuration({ paymentNetworkEnabled: false }, { CARTOTECA_PAYMENT_NETWORK_ENABLED: '1' })
      .paymentNetworkEnabled,
    false,
  );
  for (const value of ['1', 'true', 1, null, {}])
    assert.throws(
      () => configuration({ paymentNetworkEnabled: value }, {}),
      /payment network flag/,
    );
});

test('gated release and preflight keep payment transport OFF even with an explicit option', () => {
  assert.equal(
    gatedRelease({ releaseGate: true, paymentNetworkEnabled: true }).paymentNetworkEnabled,
    false,
  );
  assert.equal(
    runtimeOptions({ processRole: 'preflight', paymentNetworkEnabled: true }).paymentNetworkEnabled,
    false,
  );
});

test('a complete saved merchant draft cannot create an order or provider when transport is OFF', async (t) => {
  const f = fixture(t, { paymentNetworkEnabled: false });
  f.configure();
  const view = f.payments.config('admin');
  assert.equal(view.configured, true);
  assert.equal(view.secretConfigured, true);
  assert.equal(view.ready, false);
  assert.equal(view.networkEnabled, false);
  assert.equal(f.payments.publicConfig().ready, false);
  assert.match(view.notice, /выключен на сервере/);
  await assert.rejects(
    f.begin(),
    (error) =>
      error.status === 503 &&
      error.code === 'PAYMENTS_NETWORK_DISABLED' &&
      error.outcomeUnknown === false,
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_payment_orders').get().n, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.configs.length, 0);
});

test('an absent direct-store option is OFF even with an injected fake factory', async (t) => {
  const f = fixture(t);
  delete f.context.paymentNetworkEnabled;
  f.reopen();
  f.configure();
  await assert.rejects(f.begin(), status(503));
  assert.equal(f.configs.length, 0);
  assert.equal(f.payments.config('admin').ready, false);
});

test('turning transport OFF preserves pending history without provider reads, webhook grants or retries', async (t) => {
  const f = fixture(t);
  f.configure();
  const input = f.checkout(),
    pending = await f.begin(input);
  const calls = f.calls.length,
    configs = f.configs.length;
  f.context.paymentNetworkEnabled = false;
  f.reopen();
  const result = await f.payments.payment(f.current, pending.id);
  assert.equal(result.id, pending.id);
  assert.equal(result.status, 'pending');
  assert.match(result.notice, /выключен на сервере/);
  assert.equal(result.confirmationUrl, null);
  const before = f.row();
  const replay = await f.begin(input);
  assert.equal(replay.id, pending.id);
  assert.equal(replay.confirmationUrl, null);
  assert.deepEqual(f.row(), before);
  await assert.rejects(f.begin({ ...input, receiptEmail: 'changed@example.test' }), status(409));
  assert.equal((await f.payments.webhook(f.event(), {})).reconciliationRequired, true);
  const review = await f.review();
  assert.equal(review.operation.code, 'merchant_unavailable');
  await assert.rejects(f.begin(), status(503));
  assert.equal(f.calls.length, calls);
  assert.equal(f.configs.length, configs);
  assert.equal(f.packages.status('org-a').active, false);
  assert.equal(f.row().paid_confirmed_at, null);
  assert.equal(f.payments.adminSummary('admin').paidRevenueKopecks, '0');
});

test('trial package activation is available with payment transport OFF and produces no payment', (t) => {
  const f = fixture(t, { paymentNetworkEnabled: false });
  f.packages.grantTrial('admin', f.command({ orgId: 'org-a', packageId: 'voice-start' }));
  assert.equal(f.packages.status('org-a').active, true);
  assert.equal(f.packages.status('org-a').source, 'trial');
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_payment_orders').get().n, 0);
});
