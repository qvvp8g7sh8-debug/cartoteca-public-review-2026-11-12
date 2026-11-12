const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assistantBoundariesFixture,
  command,
} = require('./helpers/assistant-boundaries-fixture.cjs');

test('owner, salon administrator and staff require their own explicit grant and retain current membership scope', async (t) => {
  const f = await assistantBoundariesFixture(t, { grantRoles: [] });
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    assert.equal(f.api.access(f.current(role)).enabled, false);
    await assert.rejects(f.request('llm', role), { status: 403 });
    f.grant(role);
    const current = f.current(role),
      scope = f.api.access(current);
    assert.equal(current.role, role);
    assert.equal(scope.enabled, true);
    assert.equal(scope.organizationId, f.owner.organizationId);
    assert.equal((await f.request('llm', role)).action.type, 'calendar');
  }
  assert.equal(f.api.access(f.store.session(f.adminSession.token)).enabled, false);
  assert.equal(f.calls.llm, 3);
  assert.equal(f.readState().policy.mode, 'selected');
});
test('a granted staff member cannot reuse an assistant context with forged role or another organization', async (t) => {
  const f = await assistantBoundariesFixture(t);
  const c = f.context('cosmetologist');
  for (const forged of [{ role: 'owner' }, { organizationId: f.other.organizationId }]) {
    const context = { ...c, current: { ...c.current, ...forged } };
    await assert.rejects(f.api.turn(context, { text: 'Календарь', policyVersion: f.revision() }), {
      status: 403,
    });
  }
  assert.equal(f.calls.llm, 0);
  assert.equal(Object.keys(f.readState().reservations).length, 0);
});
test('deleted and recreated membership does not inherit the prior grant even when account and role match', async (t) => {
  const f = await assistantBoundariesFixture(t),
    staff = f.actors.cosmetologist;
  const old = f.database.db
    .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
    .get(staff.organizationId, staff.accountId);
  f.database.db
    .prepare('DELETE FROM memberships WHERE organization_id=? AND account_id=?')
    .run(staff.organizationId, staff.accountId);
  f.database.db
    .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
    .run(staff.organizationId, staff.accountId, 'cosmetologist', 'active', old.created_at + 1000);
  assert.equal(f.api.access(f.current('cosmetologist')).enabled, false);
  await assert.rejects(f.request('llm', 'cosmetologist'), { status: 403 });
  f.grant('cosmetologist');
  assert.equal(f.api.access(f.current('cosmetologist')).enabled, true);
  assert.equal((await f.request('llm', 'cosmetologist')).action.type, 'calendar');
});
test('tenant roles and a revoked global administrator cannot mutate provider, grant or restore state', async (t) => {
  const f = await assistantBoundariesFixture(t),
    before = f.readState();
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    const account = f.actors[role].accountId;
    assert.throws(
      () => f.admin.settings(account, command(f.revision(), { policy: { mode: 'off' } })),
      { status: 403 },
    );
    assert.throws(
      () =>
        f.admin.setMember(
          account,
          command(f.revision(), {
            organizationId: f.owner.organizationId,
            accountId: account,
            enabled: true,
          }),
        ),
      { status: 403 },
    );
    assert.throws(() => f.admin.restore(account, command(f.revision(), { revision: 0 })), {
      status: 403,
    });
  }
  assert.deepEqual(f.readState(), before);
  f.database.db.prepare('UPDATE accounts SET global_admin=0 WHERE id=?').run(f.actor);
  assert.throws(() => f.admin.view(f.actor), { status: 403 });
  assert.throws(
    () => f.admin.settings(f.actor, command(before.revision, { policy: { mode: 'off' } })),
    { status: 403 },
  );
  assert.deepEqual(f.readState(), before);
});
