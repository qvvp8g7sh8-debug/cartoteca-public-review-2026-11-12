const test = require('node:test'),
  assert = require('node:assert/strict'),
  { randomUUID } = require('node:crypto');
const {
  authScope,
  authOf,
  assertAuthScope,
  assertAuthStep,
} = require('../src/server/infrastructure/postgres/auth-intent137.cjs');
const {
  MODES,
  KEYS,
  assertMode,
  lockPlan,
  assertPlanIntent,
} = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const scope = { kind: 'platform', storeId: randomUUID() },
  input = {
    accountId: randomUUID(),
    organizationId: randomUUID(),
    emailHash: 'a'.repeat(64),
    clientKey: 'client:' + 'b'.repeat(64),
  },
  cap = authScope(input, scope),
  catalog = canonicalSqliteSchema({ kind: 'platform', version: 19 });
const step = (sql, args, method = 'run') => compile(sql, scope, args, method, catalog);
test('ordinary AUTH scope is canonical, closed and immutable', () => {
  assert.equal(MODES.includes('AUTH'), true);
  assert.equal(cap.emailKey, 'email:' + input.emailHash);
  assert.equal(cap.platformStoreId, scope.storeId);
  assert.equal(Object.isFrozen(cap), true);
  for (const bad of [
    { ...input, accountId: null },
    { ...input, clientKey: 'email:' + 'b'.repeat(64) },
    { ...input, emailHash: 'ABC' },
    { ...input, organizationId: null },
    { ...input, operation: 'admin' },
    { ...input, platformStoreId: scope.storeId },
  ])
    assert.throws(() => authScope(bad, scope), { code: 'POSTGRES_AUTH_SCOPE_INVALID' });
  assert.throws(() => assertAuthScope({ kind: 'cabinet', storeId: scope.storeId }, cap), {
    code: 'POSTGRES_AUTH_SCOPE_INVALID',
  });
});
test('AUTH shares policy/writer only; sorted exact account/email/IP keys preserve intentional sharing', () => {
  const locks = lockPlan(scope, 'AUTH', true, null, null, null, null, cap);
  assert.deepEqual(locks.slice(0, 3), [
    { key: KEYS.maintenance, shared: true },
    { key: KEYS.policy, shared: true },
    { key: KEYS.writer, shared: true },
  ]);
  assert.equal(locks.length, 6);
  assert.deepEqual(
    locks.slice(3).map((x) => x.key),
    locks
      .slice(3)
      .map((x) => x.key)
      .sort(),
  );
  assert.equal(
    locks.slice(3).every((x) => x.shared === false),
    true,
  );
  const second = authScope(
      {
        ...input,
        accountId: randomUUID(),
        organizationId: randomUUID(),
        emailHash: 'c'.repeat(64),
      },
      scope,
    ),
    keys = lockPlan(scope, 'AUTH', true, null, null, null, null, second)
      .slice(3)
      .map((x) => x.key);
  assert.equal(
    locks.slice(3).filter((x) => keys.includes(x.key)).length,
    1,
    'shared IP is intentionally global',
  );
  assert.throws(() => assertMode(scope, 'READONLY', [{ mode: 'AUTH', auth: cap }]), {
    code: 'POSTGRES_AUTH_NESTING',
  });
  assert.throws(() => lockPlan(scope, 'AUTH', true), { code: 'POSTGRES_AUTH_SCOPE_INVALID' });
  assert.equal(
    lockPlan(scope, 'IMMEDIATE', true).find((x) => x.key === KEYS.policy).shared,
    false,
    'admin/default policy EX unchanged',
  );
});
test('both caller paths use exact compiled AUTH SQL and binding checks, including reads', () => {
  const good = step('DELETE FROM login_limits WHERE key=?', [cap.emailKey]);
  assertAuthStep(good, scope, cap, catalog);
  assertPlanIntent([good], scope, 'AUTH', null, null, catalog, null, cap);
  assertAuthStep(
    step("SELECT * FROM accounts WHERE id=? AND status='active'", [cap.accountId], 'get'),
    scope,
    cap,
    catalog,
  );
  const audit =
    'INSERT INTO platform_audit(time,actor_id,organization_id,event,detail) VALUES(?,?,?,?,?)';
  assertAuthStep(
    step(audit, [1, cap.accountId, cap.organizationId, 'login_succeeded', '{}']),
    scope,
    cap,
    catalog,
  );
  for (const bad of [
    step('DELETE FROM login_limits WHERE key=?', ['client:' + 'd'.repeat(64)]),
    step("SELECT * FROM accounts WHERE id=? AND status='active'", [randomUUID()], 'get'),
    step('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?', [
      'revoked',
      cap.organizationId,
      cap.accountId,
    ]),
    step(audit, [1, cap.accountId, cap.organizationId, 'password_changed', '{}']),
    step(audit, [1, cap.accountId, randomUUID(), 'login_succeeded', '{}']),
    step('DELETE FROM login_limits WHERE key=? OR key=?', [cap.emailKey, cap.clientKey]),
  ]) {
    assert.throws(() => assertAuthStep(bad, scope, cap, catalog), {
      code: 'POSTGRES_AUTH_FORBIDDEN',
    });
    assert.throws(() => assertPlanIntent([bad], scope, 'AUTH', null, null, catalog, null, cap), {
      code: 'POSTGRES_AUTH_FORBIDDEN',
    });
  }
});
