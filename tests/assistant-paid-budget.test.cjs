const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');
const { createAssistantBudget } = require('../src/server/modules/assistant/access/budget.cjs');
const { createWalletStore } = require('../src/server/modules/billing/wallet-store.cjs');
const { walletSchema } = require('../src/server/modules/billing/wallet-schema.cjs');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,global_admin INTEGER,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE memberships(organization_id TEXT,account_id TEXT,role TEXT,status TEXT,created_at INTEGER);
    INSERT INTO accounts VALUES('admin',1,'active'),('member',0,'active');
    INSERT INTO organizations VALUES('org-a','active');
    INSERT INTO memberships VALUES('org-a','member','owner','active',123);`);
  db.exec(walletSchema);
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
    transaction,
    seal: (value) => Buffer.from(JSON.stringify(value)),
    open: (value) => JSON.parse(Buffer.from(value).toString('utf8')),
    crypto,
    id: crypto.randomUUID,
  };
  const f = { context, db, paid: true, connected: true, billingReads: 0, updates: 0, reads: 0 };
  f.state = initialState();
  f.state.revision = 7;
  f.state.policy.mode = 'selected';
  f.state.providers.llm = { provider: 'timeweb', model: 'synthetic-llm' };
  f.current = { organizationId: 'org-a', accountId: 'member', role: 'owner' };
  const store = {
    read() {
      f.reads++;
      return structuredClone(f.state);
    },
    update(callback) {
      f.updates++;
      const copy = structuredClone(f.state);
      const result = callback(copy);
      f.state = copy;
      return result;
    },
  };
  const wallet = createWalletStore(context);
  context.billing = {
    wallet,
    hasServiceConnection() {
      f.billingReads++;
      return f.connected;
    },
    isServiceEnabled() {
      f.billingReads++;
      return f.paid;
    },
  };
  f.wallet = wallet;
  wallet.changeSettings('admin', {
    expectedRevision: 0,
    requestId: crypto.randomUUID(),
    reason: 'Synthetic setup',
    configured: true,
    defaultMarkupBps: 2500,
    insufficientFundsPolicy: 'prepaid',
  });
  wallet.adjustCredit('org-a', {
    actorId: 'admin',
    idempotencyKey: crypto.randomUUID(),
    amountMicrorub: 100000000,
    reason: 'Synthetic funding',
  });
  f.policy = createAssistantPolicy(context, store);
  f.budget = createAssistantBudget(context, store, f.policy);
  f.reserve = (amount = 1, kind = 'llm') => f.budget.reserve(f.current, 7, kind, amount);
  f.grant = () => {
    const member = f.policy.membership('org-a', 'member');
    f.state.grants = [
      { organizationId: 'org-a', accountId: 'member', membershipId: member.membershipId },
    ];
  };
  t.after(() => db.close());
  return f;
}
const status = (code) => (error) => error.status === code;
test('paid organization grants current members access without a pilot grant and exposes no base tariff', (t) => {
  const f = fixture(t),
    scope = f.policy.access(f.current);
  assert.equal(f.state.grants.length, 0);
  assert.equal(scope.enabled, true);
  assert.deepEqual(scope.billing, { paid: true, service: 'voice-assistant' });
  assert.doesNotMatch(JSON.stringify(scope), /llmInput|llmOutput|markupBps|rates/);
  f.db.prepare("UPDATE memberships SET status='suspended'").run();
  assert.equal(f.policy.access(f.current).enabled, false);
});
test('global off mode does not query paid service access', (t) => {
  const f = fixture(t);
  f.state.policy.mode = 'off';
  f.billingReads = 0;
  assert.equal(f.policy.access(f.current).enabled, false);
  assert.equal(f.billingReads, 0);
});
test('disconnecting a paid organization cannot recover access through an old pilot grant', (t) => {
  const f = fixture(t);
  f.grant();
  f.paid = false;
  assert.equal(f.policy.access(f.current).enabled, false);
  assert.throws(() => f.reserve(), status(403));
  f.connected = false;
  assert.equal(f.policy.access(f.current).enabled, true);
  assert.equal(f.policy.access(f.current).billing, undefined);
});
test('paid reservations and settlement write SQL only and retain a frozen pricing snapshot', (t) => {
  const f = fixture(t),
    before = structuredClone(f.state);
  const reservation = f.reserve();
  assert.equal(reservation.paid, true);
  assert.equal(f.updates, 0);
  assert.deepEqual(f.state, before);
  const row = f.db.prepare('SELECT value FROM billing_reservations WHERE id=?').get(reservation.id);
  const saved = f.context.open(row.value);
  assert.equal(saved.pricing.assistantRevision, 7);
  assert.equal(saved.pricing.inputRubPerMillion, f.state.rates.llmInput);
  const settled = f.budget.settle(reservation, 0.4);
  assert.equal(settled.chargedMicrorub, 0);
  assert.equal(f.wallet.getWallet('org-a').balanceMicrorub, 100000000);
  assert.equal(f.wallet.getWallet('org-a').providerCostMicrorub, 400000);
  assert.equal(f.updates, 0);
});
test('SQL daily attempts are shared across STT, LLM and TTS and preserve existing pilot attempts', (t) => {
  const f = fixture(t);
  f.state.policy.limits.dailyRequests = 2;
  const member = f.policy.membership('org-a', 'member');
  f.state.daily[new Date().toISOString().slice(0, 10) + ':' + member.membershipId] = 1;
  f.budget.settle(f.reserve(0, 'stt'), 0);
  assert.throws(() => f.reserve(0, 'tts'), status(429));
  assert.equal(f.wallet.totals('org-a').calls, 1);
});
test('paid monthly safety budget includes previous pilot spending and pending SQL spend', (t) => {
  const f = fixture(t),
    month = new Date().toISOString().slice(0, 7);
  f.state.policy.limits.monthlyBudgetRub = 2;
  f.state.usage[month] = { spentRub: 1, calls: 1, uncertainCalls: 0 };
  f.reserve(0.75);
  assert.throws(() => f.reserve(0.5), status(429));
  assert.equal(f.wallet.monthlyProviderUsage().reservedMicrorub, 750000);
});
test('legacy pilot safety budget includes paid organizational spend without writing a second money ledger', (t) => {
  const f = fixture(t);
  f.budget.settle(f.reserve(1), 1);
  f.paid = false;
  f.connected = false;
  f.grant();
  f.state.policy.limits.monthlyBudgetRub = 1.5;
  assert.throws(() => f.reserve(0.6), status(429));
  const reservation = f.reserve(0.5);
  assert.equal(reservation.paid, undefined);
  f.budget.settle(reservation, 0.2);
  assert.equal(f.wallet.totals('org-a').calls, 1);
});
test('fresh entitlement and policy revision are checked inside the SQL reserve transaction', (t) => {
  const f = fixture(t),
    original = f.context.billing.isServiceEnabled;
  let reads = 0;
  f.context.billing.isServiceEnabled = () => ++reads === 1;
  assert.throws(() => f.reserve(), status(403));
  assert.equal(f.wallet.totals('org-a').pendingReservations, 0);
  f.context.billing.isServiceEnabled = original;
  assert.throws(() => f.budget.reserve(f.current, 6, 'llm', 1), status(409));
  assert.equal(f.wallet.totals('org-a').pendingReservations, 0);
});
test('revocation after paid outbound still settles incurred expense and uncertainty once', (t) => {
  const f = fixture(t),
    reservation = f.reserve();
  f.paid = false;
  const result = f.budget.settle(reservation, null);
  assert.equal(result.uncertain, true);
  assert.equal(result.chargedMicrorub, 0);
  assert.equal(f.budget.settle(reservation, null).replayed, true);
  assert.equal(f.wallet.getWallet('org-a').chargedMicrorub, 0);
  assert.equal(f.wallet.getWallet('org-a').providerCostMicrorub, 1000000);
});
