const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const {
  accountingScope,
} = require('../src/server/infrastructure/postgres/assistant-accounting145.cjs');
const {
  assertMode,
  lockPlan,
  assertPlanIntent,
  KEYS,
} = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const scope = { kind: 'platform', storeId: randomUUID(), revisionProfile: 3 };
const input = {
  operation: 'reserve',
  ledger: 'pilot',
  organizationId: randomUUID(),
  accountId: randomUUID(),
  membershipId: 'm'.repeat(43),
  month: '2026-10',
  day: '2026-10-26',
  reservationId: null,
};
const catalog = canonicalSqliteSchema({
  kind: 'platform',
  version: 19,
  components: { assistantRows: true },
});
const blob = Buffer.alloc(32);
const capability = (values = {}, store = scope) => accountingScope({ ...input, ...values }, store);
function allowed(sql, args, cap = capability(), store = scope) {
  const plan = compile(sql, store, args, 'run', catalog);
  assertPlanIntent(plan.steps || [plan], store, 'ACCOUNTING', null, null, catalog, null, null, cap);
}
test('accounting locks leave clinical writer shared, keep backup/policy barriers and close all nesting', () => {
  const locks = lockPlan(scope, 'ACCOUNTING', true, null, null, null, null, null, capability());
  assert.deepEqual(locks.slice(0, 3), [
    { key: KEYS.maintenance, shared: true },
    { key: KEYS.policy, shared: true },
    { key: KEYS.writer, shared: true },
  ]);
  assert.equal(locks.filter((x) => !x.shared).length, 3);
  assert.throws(() => lockPlan(scope, 'ACCOUNTING'), { code: 'POSTGRES_ACCOUNTING_SCOPE_INVALID' });
  assert.throws(
    () => assertMode(scope, 'IMMEDIATE', [{ scope, mode: 'ACCOUNTING', accounting: capability() }]),
    { code: 'POSTGRES_ACCOUNTING_NESTING' },
  );
  assert.throws(() => accountingScope({ ...input, extra: 'SQL' }, scope), {
    code: 'POSTGRES_ACCOUNTING_SCOPE_INVALID',
  });
  assert.throws(() => accountingScope(input, { kind: 'cabinet', storeId: scope.storeId }), {
    code: 'POSTGRES_ACCOUNTING_SCOPE_INVALID',
  });
});
test('pilot reserve is exact to member/day/month and cannot change grants, settings, credits or clinical data', () => {
  const sql =
    'INSERT INTO assistant_usage_days VALUES(?,?,?) ON CONFLICT(day,membership_id) DO UPDATE SET requests=excluded.requests';
  allowed(sql, [input.day, input.membershipId, 1]);
  for (const args of [
    [input.day, 'f'.repeat(43), 1],
    ['2026-10-25', input.membershipId, 1],
    [input.day, input.membershipId, -1],
  ])
    assert.throws(() => allowed(sql, args), { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' });
  for (const [sql, args] of [
    ["UPDATE assistant_settings SET mode='off' WHERE id=1", []],
    ['DELETE FROM assistant_grants WHERE organization_id=?', [input.organizationId]],
    ['DELETE FROM accounts WHERE id=?', [input.accountId]],
    ['UPDATE billing_wallets SET balance_microrub=999999 WHERE id=?', ['platform']],
  ])
    assert.throws(() => allowed(sql, args), { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' });
});
test('fresh parameter checks survive cached template reuse and changed native store identity', () => {
  const sql = 'UPDATE assistant_usage_months SET reserved_microrub=? WHERE month=?';
  allowed(sql, [100, input.month]);
  assert.throws(() => allowed(sql, [100, '2026-09']), { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' });
  const foreign = { ...scope, storeId: randomUUID() };
  allowed(sql, [100, input.month], capability({}, foreign), foreign);
  assert.throws(() => allowed(sql, [100, input.month], capability(), foreign), {
    code: 'POSTGRES_ACCOUNTING_SCOPE_INVALID',
  });
  allowed(sql, [101, input.month]);
});
test('paid reserve preserves package-only service and exact actor; arbitrary wallet writes denied', () => {
  const sql =
    "INSERT INTO billing_reservations(id,organization_id,account_id,service,kind,provider,state,provider_quote_microrub,charge_quote_microrub,markup_bps,created_at,value,package_covered) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)";
  const args = [
    randomUUID(),
    input.organizationId,
    input.accountId,
    'voice-assistant',
    'llm',
    'timeweb',
    100,
    0,
    0,
    Date.now(),
    blob,
    1,
  ];
  const wallet = capability({ ledger: 'wallet' });
  allowed(sql, args, wallet);
  for (const [at, value] of [
    [1, randomUUID()],
    [2, randomUUID()],
    [3, 'sms'],
    [11, 0],
  ]) {
    const changed = [...args];
    changed[at] = value;
    assert.throws(() => allowed(sql, changed, wallet), { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' });
  }
  allowed(
    'INSERT INTO billing_wallets(id,organization_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING',
    ['platform', null],
    wallet,
  );
  assert.throws(
    () =>
      allowed(
        'INSERT INTO billing_wallets(id,organization_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING',
        ['org:' + randomUUID(), input.organizationId],
        wallet,
      ),
    { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' },
  );
});
test('settlement and outbound are exact-reservation capabilities, never grant editing or replay admission', () => {
  const id = randomUUID(),
    cap = capability({ operation: 'settle', reservationId: id });
  allowed('DELETE FROM assistant_reservations WHERE id=?', [id], cap);
  assert.throws(
    () => allowed('DELETE FROM assistant_reservations WHERE id=?', [randomUUID()], cap),
    { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' },
  );
  assert.throws(
    () =>
      allowed(
        'UPDATE assistant_usage_months SET reserved_microrub=? WHERE month=?',
        [1, input.month],
        cap,
      ),
    { code: 'POSTGRES_ACCOUNTING_FORBIDDEN' },
  );
  const outbound = capability({ operation: 'outbound', reservationId: id });
  allowed(
    "UPDATE assistant_reservations SET state='outbound' WHERE id=? AND state='reserved'",
    [id],
    outbound,
  );
  assert.throws(() => allowed('DELETE FROM assistant_reservations WHERE id=?', [id], outbound), {
    code: 'POSTGRES_ACCOUNTING_FORBIDDEN',
  });
});

test('unknown COMMIT is not replayed or converted to a free success by the accounting FIFO', async () => {
  const { createAsyncWriteLock } = require('../src/server/infrastructure/async-write-lock.cjs');
  const unknown = Object.assign(Error('Synthetic unknown COMMIT'), {
    code: 'POSTGRES_COMMIT_UNKNOWN',
    outcomeUnknown: true,
    channelPoisoned: true,
  });
  let calls = 0,
    commits = 0;
  const db = {
    isOpen: true,
    isTransaction: false,
    prepare: () => ({ get: () => ({ timeout: 0 }) }),
    exec(sql) {
      if (sql === 'BEGIN ACCOUNTING') {
        this.isTransaction = true;
        return;
      }
      if (sql === 'COMMIT') {
        commits++;
        this.isTransaction = false;
        this.isOpen = false;
        throw unknown;
      }
    },
  };
  const writer = createAsyncWriteLock(db, { acquire: () => db.exec('BEGIN ACCOUNTING') });
  await assert.rejects(
    writer.transaction(() => {
      calls++;
      return 'not a committed result';
    }),
    (error) => error === unknown,
  );
  assert.equal(calls, 1);
  assert.equal(commits, 1);
  assert.equal(unknown.outcomeUnknown, true);
  writer.close();
});
