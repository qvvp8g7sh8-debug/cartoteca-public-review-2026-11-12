const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createBillingAudit,
  billingAuditDetail,
  billingAuditTarget,
} = require('../src/server/modules/billing/audit.cjs');
const { createBillingBrowserFixture } = require('./helpers/billing-browser-fixture.cjs');

test('billing audit snapshots whitelist business fields, types and bounded operation identities', () => {
  const result = billingAuditDetail('billing_payment_settings_changed', {
    reason: ' Synthetic only ',
    operationId: 'legacy-test-id',
    before: { configured: false },
    after: {
      configured: true,
      testMode: true,
      revision: 3,
      vatCode: 99,
      secretKey: 'synthetic-hidden',
      email: 'synthetic@example.test',
      confirmationUrl: 'https://example.test',
      providerPayload: { arbitrary: 'hidden' },
      receiptConfig: { secretKey: 'hidden' },
    },
  });
  assert.deepEqual(result, {
    reason: 'Synthetic only',
    before: { configured: false },
    after: { configured: true, testMode: true, revision: 3 },
  });
  assert.equal(billingAuditTarget('billing_payment_review', 'email@example.test'), null);
  assert.equal(
    billingAuditTarget('billing_payment_settings_changed', 'https://example.test'),
    null,
  );
  const uuid = crypto.randomUUID();
  assert.equal(
    billingAuditTarget('billing_service_connected', uuid + ':voice-assistant'),
    uuid + ':voice-assistant',
  );
  assert.equal(billingAuditDetail('unknown_event', { secretKey: 'hidden' }), null);
});

test('minimal no-op audit callers and missing test details tables do not block business commands', () => {
  assert.doesNotThrow(() =>
    createBillingAudit({ audit() {} })('billing_package_saved', null, null, {
      after: { title: 'Synthetic' },
    }),
  );
  const db = new DatabaseSync(':memory:');
  try {
    let metadata;
    const record = createBillingAudit({
      db,
      seal() {
        throw Error('Must not seal without a details table');
      },
      audit(event, actor, org, detail) {
        metadata = detail;
        return 1;
      },
    });
    assert.equal(
      record('billing_package_saved', null, null, {
        targetId: 'synthetic',
        reason: 'hidden reason',
        after: { title: 'Synthetic', priceKopecks: 990 },
      }),
      1,
    );
    assert.deepEqual(metadata, {
      version: 1,
      targetType: 'billing_package',
      targetId: 'synthetic',
      fields: ['title', 'priceKopecks'],
    });
  } finally {
    db.close();
  }
});

test('an enclosing business transaction rolls back metadata when encrypted details cannot be saved', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE platform_audit(id INTEGER PRIMARY KEY,detail TEXT); CREATE TABLE admin_audit_details(audit_id INTEGER,value BLOB)',
  );
  try {
    const record = createBillingAudit({
      db,
      seal() {
        throw Error('Synthetic encryption failure');
      },
      audit(event, actor, org, detail) {
        return Number(
          db.prepare('INSERT INTO platform_audit(detail) VALUES(?)').run(JSON.stringify(detail))
            .lastInsertRowid,
        );
      },
    });
    db.exec('BEGIN');
    assert.throws(
      () =>
        record('billing_package_saved', null, null, {
          targetId: 'synthetic',
          after: { title: 'Synthetic' },
        }),
      /Synthetic encryption failure/,
    );
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) n FROM platform_audit').get().n, 0);
  } finally {
    db.close();
  }
});

let f;
test.before(async () => {
  f = await createBillingBrowserFixture();
});
test.after(async () => {
  await f?.close();
});
test('real schema19 package changes record encrypted before/after and preserve request idempotency', () => {
  const body = f.command({
    id: 'synthetic-audit-package',
    title: 'Synthetic protected package title',
    priceRub: '9.90',
    taskLimit: 3,
    enabled: true,
    expectedRevision: 0,
    reason: 'Synthetic protected reason for audit only',
  });
  f.platform.billing.admin.package(f.admin.accountId, body);
  f.platform.billing.admin.package(f.admin.accountId, body);
  const row = f.database.db
    .prepare(
      "SELECT a.detail,d.value FROM platform_audit a JOIN admin_audit_details d ON d.audit_id=a.id WHERE a.event='billing_package_saved'",
    )
    .get();
  const metadata = JSON.parse(row.detail),
    detail = f.database.open(row.value);
  assert.equal(metadata.version, 1);
  assert.equal(Object.hasOwn(metadata, 'reason'), false);
  assert.equal(Object.hasOwn(metadata, 'after'), false);
  assert.equal(Buffer.from(row.value).includes(Buffer.from(body.title)), false);
  assert.equal(Buffer.from(row.value).includes(Buffer.from(body.reason)), false);
  assert.equal(detail.reason, body.reason);
  assert.equal(detail.after.priceKopecks, 990);
  assert.equal(detail.operationId, body.requestId);
  assert.equal(
    f.database.db
      .prepare("SELECT count(*) n FROM platform_audit WHERE event='billing_package_saved'")
      .get().n,
    1,
  );
  f.platform.billing.admin.package(
    f.admin.accountId,
    f.command({ ...body, expectedRevision: 1, priceRub: '12.50', requestId: crypto.randomUUID() }),
  );
  const item = f.platform.admin.audit(f.admin.accountId, { event: 'billing_package_saved' })
    .items[0];
  assert.equal(item.detail.before.priceKopecks, 990);
  assert.equal(item.detail.after.priceKopecks, 1250);
});

test('settings secrets and unexpected encrypted fields cannot be returned by the billing audit reader', async () => {
  await f.configurePayments();
  const item = f.platform.admin.audit(f.admin.accountId, {
    event: 'billing_payment_settings_changed',
  }).items[0];
  assert.equal(item.detail.after.configured, true);
  assert.doesNotMatch(
    JSON.stringify(item),
    /synthetic-billing-secret|secretKey|confirmationUrl|receiptEmail/,
  );
  f.database.db.prepare('UPDATE admin_audit_details SET value=? WHERE audit_id=?').run(
    f.database.seal({
      reason: 'Synthetic bounded reason',
      operationId: 'not-a-uuid',
      after: {
        configured: true,
        secretKey: 'must-not-return',
        email: 'hidden@example.test',
        providerPayload: { hidden: true },
      },
    }),
    item.id,
  );
  const reread = f.platform.admin.audit(f.admin.accountId, {
    event: 'billing_payment_settings_changed',
  }).items[0];
  assert.deepEqual(reread.detail.after, { configured: true });
  assert.equal(Object.hasOwn(reread.detail, 'operationId'), false);
  assert.doesNotMatch(JSON.stringify(reread), /must-not-return|hidden@example|providerPayload/);
  assert.equal(f.providerCalls.length, 0);
});

test('legacy billing rows remain unchanged and their arbitrary plaintext details are not displayed', () => {
  const row = f.database.db
    .prepare(
      'INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,?,?)',
    )
    .run(
      Date.now(),
      f.admin.accountId,
      null,
      'billing_payment_settings_changed',
      JSON.stringify({ reason: 'legacy hidden detail', secretKey: 'legacy-secret' }),
    );
  const id = Number(row.lastInsertRowid),
    before = f.database.db.prepare('SELECT detail FROM platform_audit WHERE id=?').get(id).detail;
  const result = f.platform.admin
    .audit(f.admin.accountId, { event: 'billing_payment_settings_changed' })
    .items.find((item) => item.id === id);
  assert.equal(result.detail.legacy, true);
  assert.doesNotMatch(JSON.stringify(result), /legacy hidden detail|legacy-secret/);
  assert.equal(
    f.database.db.prepare('SELECT detail FROM platform_audit WHERE id=?').get(id).detail,
    before,
  );
});
