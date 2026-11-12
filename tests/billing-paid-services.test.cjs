const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { walletSchema } = require('../src/server/modules/billing/wallet-schema.cjs');
const {
  serviceConnectionSchema,
} = require('../src/server/modules/billing/entitlements-schema.cjs');
const { packageSchema } = require('../src/server/modules/billing/package-schema.cjs');
const { paymentSchema } = require('../src/server/modules/billing/payment-schema.cjs');
const { createPaidServices } = require('../src/server/modules/billing/paid-services.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { routes } = require('../src/server/modules/billing/routes.cjs');
function fixture(t, prepared = true) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE accounts(id TEXT PRIMARY KEY,global_admin INTEGER,status TEXT,value BLOB);
 CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT,value BLOB,created_at INTEGER);
 CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,created_at INTEGER);
 CREATE TABLE subscriptions(organization_id TEXT PRIMARY KEY,status TEXT);
 INSERT INTO memberships VALUES('org-a','owner-a','owner','active',1),('org-a','staff','cosmetologist','active',2),('org-a','salon-admin','salon_admin','active',3),('org-b','owner-b','owner','active',4);
 INSERT INTO subscriptions VALUES('org-a','active'),('org-b','active');`);
  const key = crypto.randomBytes(32),
    f = { clock: Date.now() };
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
  for (const id of ['admin', 'owner-a', 'owner-b', 'staff', 'salon-admin'])
    db.prepare('INSERT INTO accounts VALUES(?,?,?,?)').run(
      id,
      Number(id === 'admin'),
      'active',
      seal({ displayName: 'Synthetic ' + id }),
    );
  for (const id of ['org-a', 'org-b'])
    db.prepare('INSERT INTO organizations VALUES(?,?,?,?)').run(
      id,
      'active',
      seal({ name: 'Synthetic ' + id }),
      123,
    );
  if (prepared) db.exec(walletSchema + serviceConnectionSchema + packageSchema + paymentSchema);
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
    crypto,
    id: crypto.randomUUID,
    now: () => f.clock,
    audit() {},
    paymentFetch() {
      throw Error('No real provider may be called');
    },
  };
  const billing = createPaidServices(context);
  context.billing = billing;
  const ownerA = {
      organizationId: 'org-a',
      accountId: 'owner-a',
      role: 'owner',
      sessionId: 'synthetic-owner-session',
    },
    ownerB = {
      organizationId: 'org-b',
      accountId: 'owner-b',
      role: 'owner',
      sessionId: 'synthetic-other-session',
    };
  const command = (extra) => ({
    requestId: crypto.randomUUID(),
    reason: 'Synthetic package setup',
    ...extra,
  });
  const define = () =>
    billing.packages.savePackage(
      'admin',
      command({
        id: 'voice-test',
        title: 'Synthetic voice package',
        priceKopecks: 100000,
        taskLimit: 2,
        enabled: true,
        expectedRevision: 0,
      }),
    );
  const trial = (org = 'org-a') =>
    billing.packages.grantTrial('admin', command({ orgId: org, packageId: 'voice-test' }));
  t.after(() => db.close());
  return {
    db,
    open,
    billing,
    context,
    ownerA,
    ownerB,
    command,
    define,
    trial,
    setClock: (value) => {
      f.clock = value;
    },
  };
}
const status = (code) => (error) => error.status === code;
test('schema11 finance GET returns unavailable and does not create package or payment tables', (t) => {
  const f = fixture(t, false);
  assert.equal(f.billing.view(f.ownerA).available, false);
  assert.equal(f.billing.admin.view('admin').available, false);
  assert.equal(f.billing.isServiceEnabled('org-a'), false);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'billing_%'").get().n,
    0,
  );
});
test('package management and payment details are owner-only while active staff keep assistant access', (t) => {
  const f = fixture(t);
  f.define();
  f.trial();
  assert.equal(f.billing.view(f.ownerA).available, true);
  for (const current of [
    { ...f.ownerA, accountId: 'salon-admin', role: 'salon_admin' },
    { ...f.ownerA, accountId: 'staff', role: 'cosmetologist' },
    { ...f.ownerA, organizationId: 'org-b' },
    { ...f.ownerA, globalAdmin: true },
  ])
    assert.throws(() => f.billing.view(current), status(403));
  const state = initialState();
  state.policy.mode = 'selected';
  const policy = createAssistantPolicy(f.context, { read: () => structuredClone(state) });
  assert.equal(
    policy.access({ ...f.ownerA, accountId: 'staff', role: 'cosmetologist' }).enabled,
    true,
  );
});
test('trial access works while merchant checkout and the former cash-wallet prototype remain unconfigured', (t) => {
  const f = fixture(t);
  f.define();
  f.trial();
  const dto = f.billing.view(f.ownerA);
  assert.equal(dto.paymentReady, false);
  assert.equal(dto.subscription.enabled, true);
  assert.equal(dto.subscription.source, 'trial');
  assert.equal(dto.subscription.remainingTasks, 2);
  assert.equal(f.billing.wallet.getSettings().configured, false);
  assert.equal(f.billing.isServiceEnabled('org-a'), true);
});
test('customer package DTO contains fixed package price and quota with no markup, wallet, provider cost or internal key', (t) => {
  const f = fixture(t);
  f.define();
  f.trial();
  const dto = f.billing.view(f.ownerA),
    serialized = JSON.stringify(dto);
  assert.equal(dto.packages[0].priceKopecks, 100000);
  assert.equal(dto.packages[0].taskLimit, 2);
  assert.doesNotMatch(
    serialized,
    /markup|providerCost|balanceRub|reservedRub|wallet|credential|fingerprint|grantId|packageVersion|"detail"/i,
  );
  const row = f.db.prepare('SELECT * FROM billing_service_connections').get(),
    secret = f.open(row.value).credential;
  assert.equal(serialized.includes(secret), false);
  assert.equal(Buffer.from(row.value).includes(Buffer.from(secret)), false);
});
test('organizations never share package activation or task quota', (t) => {
  const f = fixture(t);
  f.define();
  f.trial();
  const a = f.billing.view(f.ownerA),
    b = f.billing.view(f.ownerB);
  assert.equal(a.subscription.enabled, true);
  assert.equal(b.subscription.enabled, false);
  assert.equal(b.subscription.remainingTasks, 0);
  assert.equal(f.billing.hasServiceConnection('org-b'), false);
});
test('expiry preserves the paid marker and blocks old pilot grants from bypassing the package requirement', (t) => {
  const f = fixture(t);
  f.define();
  const grant = f.trial();
  const state = initialState();
  state.policy.mode = 'selected';
  const policy = createAssistantPolicy(f.context, { read: () => structuredClone(state) }),
    member = policy.membership('org-a', 'owner-a');
  state.grants = [
    { organizationId: 'org-a', accountId: 'owner-a', membershipId: member.membershipId },
  ];
  assert.equal(policy.access(f.ownerA).enabled, true);
  f.setClock(grant.endsAt);
  assert.equal(f.billing.hasServiceConnection('org-a'), true);
  assert.equal(f.billing.isServiceEnabled('org-a'), false);
  assert.equal(policy.access(f.ownerA).enabled, false);
});
test('package connection can be paused and re-enabled only by its owner and retries do not rotate the key', (t) => {
  const f = fixture(t);
  f.define();
  f.trial();
  const initial = f.billing.view(f.ownerA),
    input = {
      enabled: false,
      expectedRevision: initial.subscription.connectionRevision,
      requestId: crypto.randomUUID(),
    };
  assert.throws(
    () =>
      f.billing.setConnection(
        { ...f.ownerA, accountId: 'salon-admin', role: 'salon_admin' },
        input,
      ),
    status(403),
  );
  const paused = f.billing.setConnection(f.ownerA, input);
  f.billing.setConnection(f.ownerA, input);
  assert.equal(paused.subscription.enabled, false);
  const enable = {
    enabled: true,
    expectedRevision: paused.subscription.connectionRevision,
    requestId: crypto.randomUUID(),
  };
  f.billing.setConnection(f.ownerA, enable);
  const before = f.db.prepare('SELECT value FROM billing_service_connections').get().value;
  f.billing.setConnection(f.ownerA, enable);
  assert.deepEqual(
    f.db.prepare('SELECT value FROM billing_service_connections').get().value,
    before,
  );
});
test('a bare connection toggle never grants a package and cannot smuggle another organization or a price', (t) => {
  const f = fixture(t);
  f.define();
  const input = { enabled: true, expectedRevision: 0, requestId: crypto.randomUUID() };
  assert.throws(() => f.billing.setConnection(f.ownerA, input), status(402));
  assert.throws(
    () => f.billing.setConnection(f.ownerA, { ...input, organizationId: 'org-b', priceRub: 0 }),
    status(400),
  );
  assert.equal(f.billing.packages.status('org-a').active, false);
});
test('active package period remains enabled after its last task for authorized continuation and speech', (t) => {
  const f = fixture(t);
  f.define();
  f.trial();
  let ticket;
  for (let i = 0; i < 2; i++) {
    ticket = f.billing.packages.reserveTask({
      current: f.ownerA,
      requestId: crypto.randomUUID(),
      payloadHash: crypto
        .createHash('sha256')
        .update('Synthetic ' + i)
        .digest('hex'),
    });
    f.billing.packages.acceptTask(ticket);
  }
  assert.equal(f.billing.view(f.ownerA).subscription.remainingTasks, 0);
  assert.equal(f.billing.isServiceEnabled('org-a'), true);
  assert.equal(
    f.billing.packages.requireAcceptedTask({ current: f.ownerA, requestId: ticket.requestId }).id,
    ticket.id,
  );
});
test('subscription suspension and tampered key proof fail closed for paid assistant access', (t) => {
  const f = fixture(t);
  f.define();
  f.trial();
  f.db.prepare("UPDATE subscriptions SET status='suspended' WHERE organization_id='org-a'").run();
  assert.equal(f.billing.isServiceEnabled('org-a'), false);
  f.db.prepare("UPDATE subscriptions SET status='active' WHERE organization_id='org-a'").run();
  f.db
    .prepare("UPDATE billing_service_connections SET credential_hash='invalid-synthetic-proof'")
    .run();
  assert.equal(f.billing.isServiceEnabled('org-a'), false);
});
test('admin trial actions reject owners and create no manual-credit payment or receipt fiction', (t) => {
  const f = fixture(t);
  f.define();
  assert.throws(
    () =>
      f.billing.admin.trial(
        'owner-a',
        f.command({ organizationId: 'org-a', packageId: 'voice-test' }),
      ),
    status(403),
  );
  const dto = f.billing.admin.trial(
    'admin',
    f.command({ organizationId: 'org-a', packageId: 'voice-test' }),
  );
  assert.equal(dto.organizations[0].subscription.source, 'trial');
  assert.equal(dto.summary.paidRevenueRub, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_payment_orders').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_entries').get().n, 0);
});
test('account changes during body reading reject every private finance POST before mutation', async () => {
  for (const route of routes.filter(
    (route) => route.method === 'POST' && route.access !== 'public',
  )) {
    let writes = 0;
    const deny = () => {
      writes++;
    };
    const c = {
      req: {},
      res: {},
      current: { accountId: 'admin' },
      readBody: async () => ({}),
      assertCurrent() {
        throw Object.assign(Error('Synthetic account changed'), { status: 428 });
      },
      platform: {
        billing: {
          setConnection: deny,
          payments: { beginCheckout: deny },
          admin: new Proxy({}, { get: () => deny }),
        },
      },
      json() {
        assert.fail('Changed account must not receive success');
      },
    };
    await assert.rejects(route.handle(c), status(428));
    assert.equal(writes, 0);
  }
});
