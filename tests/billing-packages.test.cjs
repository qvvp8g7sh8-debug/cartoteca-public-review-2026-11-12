const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createPackageStore } = require('../src/server/modules/billing/package-store.cjs');
const { packageSchema } = require('../src/server/modules/billing/package-schema.cjs');
const {
  serviceConnectionSchema,
} = require('../src/server/modules/billing/entitlements-schema.cjs');
function fixture(
  t,
  { prepared = true, seed = true, now = Date.parse('2026-01-31T12:34:56.789Z') } = {},
) {
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
  if (prepared) db.exec(serviceConnectionSchema + packageSchema);
  const f = { db, clock: now };
  const key = crypto.randomBytes(32);
  const seal = (value) => {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', key, iv),
      body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
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
  const transaction = (callback) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const context = {
    db,
    seal,
    open,
    transaction,
    now: () => f.clock,
    id: crypto.randomUUID,
    audit() {},
  };
  const packages = createPackageStore(context);
  const command = (extra) => ({
    requestId: crypto.randomUUID(),
    reason: 'Synthetic package setup',
    ...extra,
  });
  const save = (extra = {}) =>
    packages.savePackage(
      'admin',
      command({
        id: 'voice-start',
        title: 'Synthetic voice package',
        priceKopecks: 99000,
        taskLimit: 3,
        enabled: true,
        expectedRevision: 0,
        ...extra,
      }),
    );
  if (prepared && seed) save();
  const current = {
    organizationId: 'org-a',
    accountId: 'owner-a',
    role: 'owner',
    sessionId: 'synthetic-session-a',
  };
  const trial = (extra = {}) =>
    packages.grantTrial('admin', command({ orgId: 'org-a', packageId: 'voice-start', ...extra }));
  const reserve = (extra = {}) =>
    packages.reserveTask({
      current,
      requestId: crypto.randomUUID(),
      payloadHash: crypto.createHash('sha256').update('Synthetic task').digest('hex'),
      ...extra,
    });
  const order = (extra = {}) => ({
    id: 'synthetic-paid-order',
    organizationId: 'org-a',
    packageId: 'voice-start',
    packageVersion: 1,
    title: 'Synthetic voice package',
    priceKopecks: 99000,
    taskLimit: 3,
    ...extra,
  });
  t.after(() => db.close());
  return {
    ...f,
    db,
    context,
    open,
    packages,
    command,
    save,
    current,
    trial,
    reserve,
    order,
    setNow: (value) => {
      f.clock = Date.parse(value);
    },
  };
}
const status = (code) => (error) => error.status === code;
test('package store never executes DDL or invents prices, trials or public packages', (t) => {
  const f = fixture(t, { prepared: false, seed: false });
  assert.equal(f.packages.available(), false);
  assert.deepEqual(f.packages.catalog(), []);
  assert.equal(f.packages.status('org-a').active, false);
  assert.throws(() => f.save(), status(503));
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'billing_%'").get().n,
    0,
  );
  const ready = fixture(t, { seed: false });
  assert.deepEqual(ready.packages.catalog(), []);
  assert.equal(ready.packages.status('org-a').active, false);
});
test('admin package definitions use fixed price, quota, optimistic revisions and idempotent commands', (t) => {
  const f = fixture(t),
    input = f.command({
      id: 'voice-extra',
      title: 'Synthetic extra package',
      priceKopecks: 120000,
      taskLimit: 7,
      enabled: true,
      expectedRevision: 0,
    });
  assert.throws(() => f.packages.savePackage('owner-a', input), status(403));
  const first = f.packages.savePackage('admin', input);
  assert.equal(first.version, 1);
  assert.equal(f.packages.savePackage('admin', input).replayed, true);
  assert.throws(
    () => f.packages.savePackage('admin', { ...input, priceKopecks: 120001 }),
    status(409),
  );
  assert.throws(() => f.save({ expectedRevision: 0 }), status(409));
  assert.equal(f.packages.catalog().length, 2);
});
test('zero-price or zero-quota sales cannot be enabled while drafts remain private', (t) => {
  const f = fixture(t, { seed: false });
  assert.throws(() => f.save({ priceKopecks: 0 }), status(400));
  assert.throws(() => f.save({ taskLimit: 0 }), status(400));
  f.save({ enabled: false, priceKopecks: 0, taskLimit: 0 });
  assert.deepEqual(f.packages.catalog(), []);
  assert.equal(f.packages.adminCatalog('admin').length, 1);
});
test('trial activation lasts one clamped calendar month and creates no fake payment or wallet balance', (t) => {
  const f = fixture(t),
    grant = f.trial();
  assert.equal(grant.source, 'trial');
  assert.equal(grant.startsAt, Date.parse('2026-01-31T12:34:56.789Z'));
  assert.equal(grant.endsAt, Date.parse('2026-02-28T12:34:56.789Z'));
  const row = f.db.prepare('SELECT * FROM billing_package_grants').get();
  assert.equal(row.price_kopecks, 0);
  assert.equal(row.source_order_id, null);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='billing_wallets'").get().n,
    0,
  );
});
test('a grant creates only an encrypted internal key and repeated trial requests do not rotate it', (t) => {
  const f = fixture(t),
    requestId = crypto.randomUUID(),
    first = f.trial({ requestId });
  const row = f.db.prepare('SELECT * FROM billing_service_connections').get(),
    plain = f.open(row.value);
  assert.match(plain.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(plain.packageGrantId, first.grantId);
  assert.equal(Buffer.from(row.value).includes(Buffer.from(plain.credential)), false);
  assert.equal(JSON.stringify(first).includes(plain.credential), false);
  assert.equal(f.trial({ requestId }).replayed, true);
  assert.deepEqual(
    f.db.prepare('SELECT value FROM billing_service_connections').get().value,
    row.value,
  );
});
test('existing active package cannot be replaced or stacked even after all its tasks are used', (t) => {
  const f = fixture(t);
  f.trial();
  for (let i = 0; i < 3; i++) f.packages.acceptTask(f.reserve());
  assert.equal(f.packages.status('org-a').active, true);
  assert.equal(f.packages.status('org-a').remainingTasks, 0);
  assert.throws(() => f.trial(), status(409));
  assert.throws(() => f.packages.fulfillPaidOrder(f.order()), status(409));
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 1);
});
test('expiry discards unused quota and a new purchase starts a new month without rollover', (t) => {
  const f = fixture(t);
  f.trial();
  f.packages.acceptTask(f.reserve());
  f.setNow('2026-02-28T12:34:56.789Z');
  assert.equal(f.packages.status('org-a').active, false);
  assert.equal(f.packages.status('org-a').remainingTasks, 0);
  const next = f.packages.fulfillPaidOrder(f.order());
  assert.equal(next.source, 'paid');
  assert.equal(next.remainingTasks, 3);
  assert.equal(next.endsAt, Date.parse('2026-03-28T12:34:56.789Z'));
});
test('verified order fulfillment is atomic, preserves frozen order terms and applies a paid order once', (t) => {
  const f = fixture(t),
    order = f.order();
  f.save({ expectedRevision: 1, priceKopecks: 150000, taskLimit: 9 });
  const granted = f.packages.fulfillPaidOrder(order);
  assert.equal(granted.taskLimit, 3);
  assert.equal(granted.packageVersion, 1);
  assert.equal(f.packages.fulfillPaidOrder(order).replayed, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 1);
  assert.throws(() => f.packages.fulfillPaidOrder({ ...order, taskLimit: 4 }), status(409));
  assert.throws(() => f.packages.fulfillPaidOrderInTransaction(order), /existing SQL transaction/);
});
test('task reserves atomically protect the remaining quota from overlapping requests', (t) => {
  const f = fixture(t);
  f.trial();
  const tickets = [f.reserve(), f.reserve(), f.reserve()];
  assert.equal(f.packages.status('org-a').reservedTasks, 3);
  assert.equal(f.packages.status('org-a').remainingTasks, 0);
  assert.throws(
    () => f.reserve(),
    (error) => error.code === 'ASSISTANT_PACKAGE_EXHAUSTED',
  );
  f.packages.rejectTask(tickets[0]);
  assert.equal(f.packages.status('org-a').remainingTasks, 1);
  assert.equal(f.reserve().state, 'reserved');
});
test('accepted and uncertain attempts consume exactly one task and duplicate initial requests never dispatch twice', (t) => {
  const f = fixture(t);
  f.trial();
  const requestId = crypto.randomUUID(),
    ticket = f.reserve({ requestId });
  assert.throws(
    () => f.reserve({ requestId }),
    (error) => error.code === 'TASK_IN_PROGRESS',
  );
  f.packages.acceptTask(ticket, { outbound: true });
  f.packages.acceptTask(ticket, { uncertain: true });
  assert.equal(f.packages.status('org-a').usedTasks, 1);
  assert.throws(
    () => f.reserve({ requestId }),
    (error) => error.code === 'TASK_ALREADY_COUNTED',
  );
  const second = f.reserve();
  f.packages.rejectTask(second, { outbound: true, uncertain: true });
  assert.equal(f.packages.status('org-a').usedTasks, 2);
});
test('released retries are free and attempt numbers reject late callbacks from previous attempts', (t) => {
  const f = fixture(t);
  f.trial();
  const requestId = crypto.randomUUID(),
    first = f.reserve({ requestId });
  f.packages.rejectTask(first);
  assert.throws(
    () => f.packages.acceptTask(first),
    (error) => error.code === 'TASK_NOT_RESERVED',
  );
  const retried = f.reserve({ requestId });
  assert.equal(retried.attempt, 2);
  assert.throws(() => f.packages.rejectTask(first), status(403));
  f.packages.acceptTask(retried);
  assert.equal(f.packages.status('org-a').usedTasks, 1);
});
test('task identity binds organization, account and session while transcripts never enter the ledger', (t) => {
  const f = fixture(t);
  f.trial();
  const ticket = f.reserve({ dialogueId: 'synthetic-dialogue' });
  for (const change of [
    { organizationId: 'org-b' },
    { accountId: 'staff-a' },
    { sessionId: 'another-session' },
  ])
    assert.throws(() => f.packages.acceptTask({ ...ticket, ...change }), status(403));
  const raw = f.db.prepare('SELECT * FROM billing_package_tasks').get();
  assert.equal(JSON.stringify(raw).includes('Synthetic task'), false);
  assert.equal(JSON.stringify(raw).includes('synthetic-dialogue'), false);
  assert.equal(JSON.stringify(raw).includes('synthetic-session-a'), false);
  assert.throws(
    () => f.reserve({ requestId: ticket.requestId, payloadHash: 'a'.repeat(64) }),
    (error) => error.code === 'TASK_KEY_CONFLICT',
  );
});
test('account, organization and subscription suspension prevent new tasks but incurred tasks still settle', (t) => {
  const f = fixture(t);
  f.trial();
  const ticket = f.reserve();
  f.db.prepare("UPDATE subscriptions SET status='suspended' WHERE organization_id='org-a'").run();
  assert.equal(f.packages.status('org-a').active, false);
  assert.throws(() => f.reserve(), status(403));
  f.packages.acceptTask(ticket, { uncertain: true });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM billing_package_tasks WHERE state='uncertain'").get().n,
    1,
  );
  f.db.prepare("UPDATE subscriptions SET status='active' WHERE organization_id='org-a'").run();
  f.db.prepare("UPDATE accounts SET status='suspended' WHERE id='owner-a'").run();
  assert.throws(() => f.reserve(), status(403));
});
test('grant and internal key roll back together if automatic key binding fails', (t) => {
  const f = fixture(t);
  f.db.exec(
    "CREATE TRIGGER synthetic_key_failure BEFORE INSERT ON billing_service_connections BEGIN SELECT RAISE(ABORT,'synthetic key failure'); END;",
  );
  assert.throws(() => f.trial(), /synthetic key failure/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_package_grants').get().n, 0);
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM billing_package_operations WHERE actor_id=?').get('admin')
      .n,
    1,
  );
});
test('accepted last task authorizes its own continuation and speech until expiry only', (t) => {
  const f = fixture(t);
  f.trial();
  const tickets = [f.reserve(), f.reserve(), f.reserve()];
  for (const ticket of tickets) f.packages.acceptTask(ticket);
  assert.equal(f.packages.status('org-a').remainingTasks, 0);
  assert.equal(
    f.packages.requireAcceptedTask({ current: f.current, requestId: tickets[2].requestId }).id,
    tickets[2].id,
  );
  assert.throws(
    () =>
      f.packages.requireAcceptedTask({
        current: { ...f.current, sessionId: 'foreign-session' },
        requestId: tickets[2].requestId,
      }),
    status(402),
  );
  f.setNow('2026-02-28T12:34:56.789Z');
  assert.throws(
    () => f.packages.requireAcceptedTask({ current: f.current, requestId: tickets[2].requestId }),
    status(402),
  );
});
test('test checkout grants retain an explicit test marker and do not impersonate a real payment', (t) => {
  const f = fixture(t),
    order = f.order({ testMode: true });
  const grant = f.packages.fulfillPaidOrder(order);
  assert.equal(grant.testMode, true);
  assert.equal(f.packages.status('org-a').testMode, true);
  assert.throws(() => f.packages.fulfillPaidOrder({ ...order, testMode: false }), status(409));
});
test('trial grants cannot race a pending verified payment order', (t) => {
  const f = fixture(t);
  f.db.exec(
    "CREATE TABLE billing_payment_orders(organization_id TEXT,state TEXT); INSERT INTO billing_payment_orders VALUES('org-a','pending');",
  );
  assert.throws(() => f.trial(), status(409));
  assert.equal(f.packages.status('org-a').active, false);
});
