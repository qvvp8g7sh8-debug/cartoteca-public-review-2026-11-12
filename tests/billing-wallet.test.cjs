const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createWalletStore } = require('../src/server/modules/billing/wallet-store.cjs');
const { walletSchema } = require('../src/server/modules/billing/wallet-schema.cjs');
const { rubToMicrorub, markedUp, addMoney } = require('../src/server/modules/billing/money.cjs');
function fixture(t, prepared = true) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,global_admin INTEGER,status TEXT);
    CREATE TABLE organizations(id TEXT PRIMARY KEY);
    INSERT INTO accounts VALUES('admin',1,'active'),('member',0,'active');
    INSERT INTO organizations VALUES('org-a'),('org-b');`);
  if (prepared) db.exec(walletSchema);
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
  const store = createWalletStore({ db, seal, open, crypto, transaction, id: crypto.randomUUID });
  const command = (extra = {}) => ({
    expectedRevision: store.getSettings().revision,
    requestId: crypto.randomUUID(),
    reason: 'Synthetic configuration',
    ...extra,
  });
  const credit = (org, amount = 10000000, extra = {}) =>
    store.adjustCredit(org, {
      actorId: 'admin',
      idempotencyKey: crypto.randomUUID(),
      amountMicrorub: amount,
      reason: 'Synthetic balance credit',
      ...extra,
    });
  const configure = (markup = 0) =>
    store.changeSettings(
      'admin',
      command({
        configured: true,
        insufficientFundsPolicy: 'prepaid',
        defaultMarkupBps: markup,
      }),
    );
  const reserve = (extra = {}) =>
    store.reserve({
      organizationId: 'org-a',
      accountId: 'member',
      service: 'voice-assistant',
      kind: 'llm',
      provider: 'timeweb',
      amountRub: 1,
      ...extra,
    });
  t.after(() => db.close());
  return { db, store, command, credit, configure, reserve, open };
}
const status = (code) => (error) => error.status === code;
test('wallet storage never prepares or migrates the database on access', (t) => {
  const f = fixture(t, false);
  assert.equal(f.store.available(), false);
  assert.equal(f.store.getSettings().configured, false);
  assert.equal(f.store.getWallet('org-a').available, false);
  assert.throws(() => f.reserve(), status(503));
  assert.throws(() => f.credit('org-a'), status(503));
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'billing_%'").get().n,
    0,
  );
});
test('money uses decimal microrubles and exact integer markup without kopeck rounding', () => {
  assert.equal(rubToMicrorub('0.000001'), 1);
  assert.equal(rubToMicrorub('1e-7'), 1);
  assert.equal(rubToMicrorub(0.1), 100000);
  assert.equal(rubToMicrorub('12.345678'), 12345678);
  assert.equal(markedUp(1, 2500), 2);
  assert.equal(markedUp(100000, 2500), 125000);
  assert.equal(addMoney(12345678, 2), 12345680);
  for (const value of [-1, NaN, Infinity, 'invalid', '9007199254.740992'])
    assert.throws(() => rubToMicrorub(value));
  assert.throws(() => addMoney(Number.MAX_SAFE_INTEGER, 1));
});
test('confirmed prepaid policy stays inactive and creates no wallet rows on reads', (t) => {
  const { store, db } = fixture(t);
  assert.deepEqual(store.getSettings(), {
    available: true,
    revision: 0,
    defaultMarkupBps: 0,
    configured: false,
    insufficientFundsPolicy: 'prepaid',
    changedAt: null,
  });
  assert.equal(store.getWallet('org-a').balanceMicrorub, 0);
  assert.equal(store.getWallet('org-a').markupBps, null);
  assert.equal(store.getWallet(null).walletId, 'platform');
  assert.equal(db.prepare('SELECT count(*) n FROM billing_wallets').get().n, 0);
});
test('financial administration rechecks an active global administrator inside the transaction', (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.store.changeSettings('member', f.command({ defaultMarkupBps: 1000 })),
    status(403),
  );
  assert.throws(() => f.credit('org-a', 100, { actorId: 'member' }), status(403));
  f.db.prepare("UPDATE accounts SET status='suspended' WHERE id='admin'").run();
  assert.throws(() => f.credit('org-a'), status(403));
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_entries').get().n, 0);
});
test('default and nullable organization markup use independent revisions and idempotent commands', (t) => {
  const f = fixture(t),
    input = f.command({ defaultMarkupBps: 2500 });
  f.store.changeSettings('admin', input);
  assert.equal(f.store.changeSettings('admin', input).replayed, true);
  assert.throws(
    () => f.store.changeSettings('admin', { ...input, defaultMarkupBps: 3000 }),
    status(409),
  );
  assert.throws(
    () => f.store.changeSettings('admin', f.command({ expectedRevision: 0 })),
    status(409),
  );
  assert.equal(f.store.getWallet('org-a').effectiveMarkupBps, 2500);
  f.store.setOrganizationSettings(
    'admin',
    'org-a',
    f.command({ expectedRevision: 0, markupBps: 5000 }),
  );
  assert.equal(f.store.getWallet('org-a').effectiveMarkupBps, 5000);
  assert.equal(f.store.getWallet('org-b').effectiveMarkupBps, 2500);
  assert.equal(f.store.getWallet('org-a').organizationRevision, 1);
  f.store.setOrganizationSettings(
    'admin',
    'org-a',
    f.command({ expectedRevision: 1, markupBps: null }),
  );
  assert.equal(f.store.getWallet('org-a').effectiveMarkupBps, 2500);
});
test('credits are isolated, idempotent and permanently append-only with encrypted reasons', (t) => {
  const f = fixture(t),
    idempotencyKey = crypto.randomUUID();
  f.credit('org-a', 1234567, { idempotencyKey });
  assert.equal(f.credit('org-a', 1234567, { idempotencyKey }).replayed, true);
  assert.throws(() => f.credit('org-a', 1234568, { idempotencyKey }), status(409));
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 1234567);
  assert.equal(f.store.getWallet('org-b').balanceMicrorub, 0);
  f.credit(null, 2000000);
  assert.equal(f.store.getWallet(null).balanceMicrorub, 2000000);
  const history = f.store.listHistory('org-a');
  assert.equal(history.total, 1);
  assert.equal(history.items[0].detail.reason, 'Synthetic balance credit');
  const raw = f.db.prepare('SELECT value FROM billing_entries WHERE wallet_id=?').get('org:org-a');
  assert.equal(Buffer.from(raw.value).includes(Buffer.from('Synthetic balance credit')), false);
  assert.throws(
    () => f.db.exec("DELETE FROM billing_entries WHERE wallet_id='org:org-a'"),
    /append-only/,
  );
  assert.throws(() => f.db.exec('UPDATE billing_entries SET amount_microrub=0'), /append-only/);
});
test('unconfigured payment policy blocks positive paid reservations and does not hold funds', (t) => {
  const f = fixture(t);
  f.credit('org-a');
  assert.throws(() => f.reserve(), status(503));
  assert.equal(f.store.getWallet('org-a').reservedMicrorub, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_reservations').get().n, 0);
});
test('prepaid reserves prevent concurrent overspending and release only the explicit zero outcome', (t) => {
  const f = fixture(t);
  f.configure(2500);
  f.credit('org-a', 1500000);
  const reservation = f.reserve();
  assert.equal(reservation.chargeMicrorub, 1250000);
  assert.throws(() => f.reserve(), status(402));
  assert.equal(f.store.getWallet('org-a').availableMicrorub, 250000);
  const result = f.store.settle(reservation.id, { actualRub: 0 });
  assert.equal(result.state, 'released');
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 1500000);
  assert.equal(f.store.getWallet('org-a').reservedMicrorub, 0);
});
test('settlement freezes markup, debits customer and master atomically, and applies once', (t) => {
  const f = fixture(t);
  f.configure(2500);
  f.credit('org-a');
  const reservation = f.reserve({ amountRub: 2 });
  f.store.changeSettings('admin', f.command({ defaultMarkupBps: 9000 }));
  const result = f.store.settle(reservation.id, { actualRub: '1.2', estimated: false });
  assert.equal(result.chargedMicrorub, 1500000);
  assert.equal(result.markupBps, 2500);
  assert.equal(result.estimated, false);
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 8500000);
  assert.equal(f.store.getWallet(null).balanceMicrorub, -1200000);
  assert.equal(f.store.getWallet(null).reservedMicrorub, 0);
  assert.equal(f.store.settle(reservation.id, { actualRub: 0 }).replayed, true);
  assert.equal(f.store.listHistory('org-a').total, 2);
  assert.equal(f.store.listHistory(null).total, 1);
});
test('unknown external spend requires explicit uncertainty and does not expire or become free', (t) => {
  const f = fixture(t);
  f.configure(1000);
  f.credit('org-a');
  const reservation = f.reserve();
  f.db.prepare('UPDATE billing_reservations SET created_at=0 WHERE id=?').run(reservation.id);
  assert.throws(() => f.store.settle(reservation.id, { actualRub: null }), status(400));
  assert.equal(f.store.totals('org-a').pendingReservations, 1);
  const result = f.store.settle(reservation.id, { actualRub: null, uncertain: true });
  assert.equal(result.actualMicrorub, 1000000);
  assert.equal(result.chargedMicrorub, 1100000);
  assert.equal(result.uncertain, true);
  assert.equal(f.store.totals('org-a').uncertainCalls, 1);
});
test('a cost above its reserve remains visible without unauthorized customer overdraft', (t) => {
  const f = fixture(t);
  f.configure(5000);
  f.credit('org-a', 1500000);
  const reservation = f.reserve();
  const result = f.store.settle(reservation.id, { actualRub: 2 });
  assert.equal(result.chargedMicrorub, 1500000);
  assert.equal(result.retailMicrorub, 3000000);
  assert.equal(result.unpaidChargeMicrorub, 1500000);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 0);
  assert.equal(f.store.getWallet(null).providerCostMicrorub, 2000000);
  assert.equal(
    f.store.listHistory('org-a').items.find((item) => item.kind === 'charge').detail
      .unpaidChargeMicrorub,
    1500000,
  );
});
test('shared wallet supports another paid service and totals reconcile across organizations', (t) => {
  const f = fixture(t);
  f.configure();
  f.credit('org-a', 3000000);
  f.credit('org-b', 5000000);
  const voice = f.reserve();
  const other = f.reserve({ service: 'another-paid-service' });
  f.store.settle(voice.id, { actualRub: 1 });
  f.store.settle(other.id, { actualRub: '0.5' });
  const totals = f.store.totals();
  assert.equal(totals.providerCostMicrorub, 1500000);
  assert.equal(totals.chargedMicrorub, 1500000);
  assert.equal(totals.customerBalanceMicrorub, 6500000);
  assert.equal(f.store.totals('org-b').providerCostMicrorub, 0);
});
test('SQL failure midway through settlement rolls every projection and ledger entry back', (t) => {
  const f = fixture(t);
  f.configure();
  f.credit('org-a');
  const reservation = f.reserve();
  f.db.exec(
    "CREATE TRIGGER synthetic_failure BEFORE INSERT ON billing_entries WHEN NEW.kind='charge' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
  );
  assert.throws(() => f.store.settle(reservation.id, { actualRub: 1 }), /synthetic failure/);
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 10000000);
  assert.equal(f.store.getWallet('org-a').reservedMicrorub, 1000000);
  assert.equal(f.store.getWallet(null).providerCostMicrorub, 0);
  assert.equal(f.store.listHistory(null).total, 0);
  assert.equal(f.store.totals('org-a').pendingReservations, 1);
});
test('manual payment references are encrypted and bound to the idempotent credit payload', (t) => {
  const f = fixture(t),
    idempotencyKey = crypto.randomUUID();
  f.credit('org-a', 1000000, {
    idempotencyKey,
    paymentReference: 'Synthetic PP-42',
    document: 'Synthetic invoice 17',
  });
  assert.throws(
    () =>
      f.credit('org-a', 1000000, {
        idempotencyKey,
        paymentReference: 'Synthetic PP-43',
        document: 'Synthetic invoice 17',
      }),
    status(409),
  );
  const item = f.store.listHistory('org-a').items[0];
  assert.equal(item.detail.paymentReference, 'Synthetic PP-42');
  assert.equal(item.detail.paymentVerified, false);
  assert.equal(item.detail.receiptIssued, false);
  const raw = f.db.prepare('SELECT value FROM billing_entries').get();
  assert.equal(Buffer.from(raw.value).includes(Buffer.from('Synthetic PP-42')), false);
});
test('zero-cost cache follower settles without a second charge or consuming the owner reserve', (t) => {
  const f = fixture(t);
  f.configure(2500);
  f.credit('org-a');
  const owner = f.reserve();
  const follower = f.reserve({ kind: 'tts', amountRub: 0 });
  f.store.settle(follower.id, { actualRub: 0 });
  assert.equal(f.store.getWallet('org-a').reservedMicrorub, owner.chargeMicrorub);
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 10000000);
  f.store.settle(owner.id, { actualRub: '0.2' });
  assert.equal(f.store.getWallet('org-a').chargedMicrorub, 250000);
  assert.equal(f.store.getWallet('org-a').reservedMicrorub, 0);
});
test('package-covered provider expense records cost once and never debits customer funds or applies markup', (t) => {
  const f = fixture(t);
  f.configure(9000);
  const reservation = f.reserve({ packageCovered: true });
  assert.equal(reservation.chargeMicrorub, 0);
  assert.equal(reservation.markupBps, 0);
  const result = f.store.settle(reservation.id, { actualRub: 0.4 });
  assert.equal(result.chargedMicrorub, 0);
  assert.equal(result.unpaidChargeMicrorub, 0);
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 0);
  assert.equal(f.store.getWallet('org-a').providerCostMicrorub, 400000);
  assert.equal(f.store.getWallet(null).providerCostMicrorub, 400000);
  assert.equal(f.store.listHistory('org-a').total, 0);
  assert.equal(f.store.listHistory(null).total, 1);
  assert.equal(f.store.totals().providerCostMicrorub, 400000);
});
test('trial package provider costs do not require activating the retired cash-wallet prototype', (t) => {
  const f = fixture(t),
    reservation = f.reserve({ packageCovered: true });
  assert.equal(f.store.getSettings().configured, false);
  f.store.settle(reservation.id, { actualRub: null, uncertain: true });
  assert.equal(f.store.getWallet('org-a').chargedMicrorub, 0);
  assert.equal(f.store.getWallet(null).providerCostMicrorub, 1000000);
});

test('provider task evidence is encrypted, outbound is monotone and uncertain spend needs explicit review', (t) => {
  const f = fixture(t),
    task = {
      id: 'synthetic-task',
      requestId: crypto.randomUUID(),
      grantId: 'synthetic-grant',
      attempt: 1,
      sessionHash: 'a'.repeat(64),
    };
  const reservation = f.reserve({ packageCovered: true, task });
  const raw = () =>
    f.db.prepare('SELECT value FROM billing_reservations WHERE id=?').get(reservation.id).value;
  assert.equal(Buffer.from(raw()).includes(Buffer.from(task.requestId)), false);
  assert.deepEqual(f.open(raw()).task, task);
  assert.equal(f.open(raw()).outboundAt, undefined);
  const sent = f.store.markOutbound(reservation.id);
  assert.equal(f.store.markOutbound(reservation.id).outboundAt, sent.outboundAt);
  assert.throws(() => f.store.reservationReview('member'), status(403));
  const pending = f.store.reservationReview('admin', { organizationId: 'org-a' });
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].task, task);
  assert.equal(pending[0].outboundAt, sent.outboundAt);
  assert.equal(f.store.reservationReview('admin', { organizationId: 'org-b' }).length, 0);
  f.store.settle(reservation.id, { actualRub: null, uncertain: true });
  f.store.settle(reservation.id, { actualRub: null, uncertain: true });
  const review = f.store.reservationReview('admin');
  assert.equal(review[0].uncertain, true);
  assert.equal(review[0].requiresReview, true);
  assert.equal(f.store.getWallet().providerCostMicrorub, 1000000);
  assert.equal(f.store.getWallet('org-a').balanceMicrorub, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM billing_entries WHERE kind='expense'").get().n,
    1,
  );
});

test('invalid provider task evidence fails before reserving funds and never stores arbitrary payload', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.reserve({
        packageCovered: true,
        task: {
          requestId: 'x',
          sessionHash: 'a'.repeat(64),
          transcript: 'Forbidden clinical text',
        },
      }),
    status(400),
  );
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_reservations').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM billing_wallets').get().n, 0);
});
