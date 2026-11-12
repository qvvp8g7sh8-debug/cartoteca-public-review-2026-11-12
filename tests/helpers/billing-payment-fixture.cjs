const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createPackageStore } = require('../../src/server/modules/billing/package-store.cjs');
const { createPaymentStore } = require('../../src/server/modules/billing/payment-store.cjs');
const {
  serviceConnectionSchema,
} = require('../../src/server/modules/billing/entitlements-schema.cjs');
const { packageSchema } = require('../../src/server/modules/billing/package-schema.cjs');
const { paymentSchema } = require('../../src/server/modules/billing/payment-schema.cjs');
const PAYMENT = '28646d50-000f-5000-a000-1fe4f81e5e88';
// Memory-only fixtures. Tax inputs and keys are synthetic, never seller defaults.
function fixture(t, { prepared = true, paymentNetworkEnabled = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE accounts(id TEXT PRIMARY KEY,global_admin INTEGER,status TEXT);
CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
CREATE TABLE subscriptions(organization_id TEXT PRIMARY KEY,status TEXT);
CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT);
INSERT INTO accounts VALUES('admin',1,'active'),('owner-a',0,'active'),('staff-a',0,'active'),('owner-b',0,'active');
INSERT INTO organizations VALUES('org-a','active'),('org-b','active');
INSERT INTO subscriptions VALUES('org-a','active'),('org-b','active');
INSERT INTO memberships VALUES('org-a','owner-a','owner','active'),('org-a','staff-a','cosmetologist','active'),('org-b','owner-b','owner','active');`);
  if (prepared) db.exec(serviceConnectionSchema + packageSchema + paymentSchema);
  const f = { db, clock: Date.parse('2026-01-31T12:00:00Z'), calls: [], configs: [] };
  const key = crypto.randomBytes(32);
  const seal = (value) => {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const open = (value) => {
    const bytes = Buffer.from(value),
      decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    );
  };
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  f.row = () =>
    db
      .prepare('SELECT * FROM billing_payment_orders ORDER BY created_at DESC,id DESC LIMIT 1')
      .get();
  f.data = () => open(f.row().value);
  f.dto = (extra = {}) => {
    const row = f.row();
    return {
      paymentId: PAYMENT,
      status: 'pending',
      succeeded: false,
      amountKopecks: row.price_kopecks,
      currency: 'RUB',
      metadata: { checkoutId: row.id, organizationId: row.organization_id },
      test: Boolean(row.test_mode),
      receiptRegistration: 'pending',
      confirmationUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=' + PAYMENT,
      ...extra,
    };
  };
  const context = {
    db,
    seal,
    open,
    transaction,
    now: () => f.clock,
    id: crypto.randomUUID,
    audit() {},
    paymentNetworkEnabled,
    paymentProviderFactory(config) {
      f.configs.push(structuredClone(config));
      return {
        async createCheckout(input) {
          f.calls.push({ type: 'create', input: structuredClone(input) });
          return f.onCreate ? f.onCreate(input) : f.dto();
        },
        async readPayment(id) {
          f.calls.push({ type: 'read', id });
          return f.onRead ? f.onRead(id) : f.dto();
        },
        async readRefund(id) {
          f.calls.push({ type: 'refund', id });
          return f.onRefund(id);
        },
        async readReceipt(id) {
          f.calls.push({ type: 'receipt', id });
          return f.onReceipt(id);
        },
        async verifyWebhook(body) {
          f.calls.push({ type: 'verify' });
          return f.onVerify ? f.onVerify(body) : f.dto();
        },
      };
    },
  };
  f.context = context;
  f.packages = createPackageStore(context);
  f.payments = createPaymentStore(context, f.packages);
  f.command = (extra) => ({
    requestId: crypto.randomUUID(),
    reason: 'Synthetic test operation',
    ...extra,
  });
  f.save = (extra = {}) =>
    f.packages.savePackage(
      'admin',
      f.command({
        id: 'voice-start',
        title: 'Synthetic monthly package',
        priceKopecks: 99000,
        taskLimit: 3,
        enabled: true,
        expectedRevision: f.packages.catalog()[0]?.version || 0,
        ...extra,
      }),
    );
  if (prepared) f.save();
  f.receipt = () => ({
    fiscalProvider: 'yookassa',
    purchaseModel: 'package',
    paymentMode: 'full_payment',
    vatCode: 1,
    taxSystemCode: 2,
    paymentSubject: 'service',
    description: 'Synthetic monthly package',
  });
  f.settings = (extra = {}) =>
    f.command({
      configured: true,
      shopId: '12345',
      secretKey: 'synthetic-secret-only',
      returnOrigin: 'https://cabinet.example.test',
      testMode: true,
      receiptConfig: f.receipt(),
      expectedRevision: f.payments.config('admin').revision,
      ...extra,
    });
  f.configure = (extra = {}) => f.payments.adminSettings('admin', f.settings(extra));
  f.checkout = (extra = {}) => ({
    packageId: 'voice-start',
    packageVersion: 1,
    requestId: crypto.randomUUID(),
    receiptEmail: 'owner@example.test',
    acceptedTermsVersion: f.payments.termsVersion,
    ...extra,
  });
  f.current = {
    organizationId: 'org-a',
    accountId: 'owner-a',
    role: 'owner',
    sessionId: 'synthetic-session',
  };
  f.begin = (input = f.checkout(), options) => f.payments.beginCheckout(f.current, input, options);
  f.success = (extra = {}) =>
    f.dto({ status: 'succeeded', succeeded: true, confirmationUrl: null, ...extra });
  f.event = () => ({
    type: 'notification',
    event: 'payment.succeeded',
    object: { id: PAYMENT, metadata: { checkoutId: f.row().id } },
  });
  f.mutateOrder = (fn) => {
    const row = f.row(),
      value = open(row.value);
    fn(value);
    db.prepare('UPDATE billing_payment_orders SET value=? WHERE id=?').run(seal(value), row.id);
  };
  f.reviewInput = (extra = {}) =>
    f.command({
      checkoutId: f.row().id,
      action: 'reconcile',
      expectedRevision: f.payments
        .adminSummary('admin')
        .orders.find((item) => item.id === f.row().id).revision,
      ...extra,
    });
  f.review = (extra = {}, options) => f.payments.review('admin', f.reviewInput(extra), options);
  f.reopen = () => {
    f.payments = createPaymentStore(context, f.packages);
    return f.payments;
  };
  f.advance = (milliseconds) => {
    f.clock += milliseconds;
  };
  t.after(() => db.close());
  return f;
}
const status = (code) => (error) => error.status === code;
module.exports = { fixture, status, PAYMENT };
