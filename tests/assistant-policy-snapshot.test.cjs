const test = require('node:test');
const assert = require('node:assert/strict');
const { rowsFixture } = require('./helpers/assistant-rows-core-fixture.cjs');
const { createAssistantPolicy } = require('../src/server/modules/assistant/access/policy.cjs');

test('bundled scope preserves scope/member/state parity and never caches authority', async (t) => {
  const f = await rowsFixture(t);
  const legacy = createAssistantPolicy(f.context, { ...f.repository, readScope: undefined });
  const current = f.current();
  assert.deepEqual(f.policy.requireScope(current, 3), legacy.requireScope(current, 3));
  assert.throws(() => f.policy.requireScope({ ...current, role: 'salon_admin' }, 3), {
    status: 403,
  });
  assert.throws(() => f.policy.requireScope({ ...current, organizationId: 'different-org' }, 3), {
    status: 403,
  });
  assert.throws(() => f.policy.requireScope({ ...current, globalAdmin: true }, 3), { status: 403 });
  f.context.db
    .prepare(
      'UPDATE memberships SET created_at=created_at+1 WHERE organization_id=? AND account_id=?',
    )
    .run(current.organizationId, current.accountId);
  assert.throws(() => f.policy.requireScope(current, 3), { status: 403 });
});

test('bundled scope rejects tampered encrypted grant bindings and current policy bindings', async (t) => {
  const f = await rowsFixture(t),
    current = f.current();
  f.context.db
    .prepare(
      'UPDATE assistant_grants SET grant_version=grant_version+1 WHERE organization_id=? AND account_id=?',
    )
    .run(current.organizationId, current.accountId);
  assert.throws(() => f.policy.requireScope(current, 3), /scalar binding mismatch/u);
  f.context.db
    .prepare(
      'UPDATE assistant_grants SET grant_version=grant_version-1 WHERE organization_id=? AND account_id=?',
    )
    .run(current.organizationId, current.accountId);
  assert.equal(f.policy.requireScope(current, 3).scope.enabled, true);
  f.context.db.prepare('UPDATE assistant_settings SET revision=revision+1 WHERE id=1').run();
  assert.throws(() => f.policy.requireScope(current, 3), /scalar binding mismatch/u);
});

test('disabled policy exposes no membership or grant through the bundled query', async (t) => {
  const f = await rowsFixture(t, {
    initial: (state) => {
      state.policy.mode = 'off';
    },
  });
  const snapshot = f.repository.readSnapshot(() => f.repository.readScope(f.current()));
  assert.equal(snapshot.memberRow, null);
  assert.equal(snapshot.grant, null);
  assert.equal(f.policy.access(f.current()).enabled, false);
});

test('paid access with no pilot grant remains fresh for service and account revocation', async (t) => {
  const f = await rowsFixture(t, {
    initial: (state) => {
      state.grants = [];
    },
  });
  let enabled = true;
  const context = {
    ...f.context,
    billing: { hasServiceConnection: () => true, isServiceEnabled: () => enabled },
  };
  const policy = createAssistantPolicy(context, f.repository),
    current = f.current();
  assert.equal(policy.requireScope(current, 3).scope.billing.paid, true);
  enabled = false;
  assert.throws(() => policy.requireScope(current, 3), { status: 403 });
  enabled = true;
  f.context.db
    .prepare('UPDATE accounts SET status=? WHERE id=?')
    .run('suspended', current.accountId);
  assert.throws(() => policy.requireScope(current, 3), { status: 403 });
});
