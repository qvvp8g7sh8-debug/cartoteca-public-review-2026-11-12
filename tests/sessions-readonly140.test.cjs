const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessions } = require('../src/server/modules/auth/sessions.cjs');
function fixture(intent, values) {
  const mutations = [],
    hash = 'synthetic-session';
  const row = {
    id: 'session',
    account_id: 'actor',
    organization_id: 'org',
    expires_at: Date.now() + 60000,
    account_status: 'active',
    membership_status: 'active',
    organization_status: 'active',
    membership_role: 'salon_admin',
    global_admin: 0,
    account_value: { email: 'synthetic@example.invalid', displayName: 'Synthetic' },
    ...values,
  };
  const context = {
    db: {
      transactionIntent: intent,
      isTransaction: intent != null,
      prepare(sql) {
        return {
          get(value) {
            assert.equal(value, hash);
            return row;
          },
          run(...args) {
            mutations.push({ sql, args });
            return { changes: 1 };
          },
        };
      },
    },
    tokenHash: () => hash,
    open: (value) => value,
    availableMemberships: () => [{ organizationId: 'org', role: 'salon_admin' }],
    transaction: () => {
      throw Error('A read observer must not open a writer');
    },
    audit: () => {
      throw Error('A read observer must not audit a repair');
    },
  };
  return { ...createSessions(context), mutations };
}
test('READONLY expired session is rejected without deleting or repairing authority', () => {
  const f = fixture('READONLY', { expires_at: Date.now() - 1 });
  assert.equal(f.session('token'), null);
  assert.deepEqual(f.mutations, []);
});
test('READONLY unselected session cannot automatically attach an organization', () => {
  const f = fixture('READONLY', { organization_id: null });
  assert.equal(f.session('token'), null);
  assert.deepEqual(f.mutations, []);
});
test('READONLY valid authority preserves the exact actor and organization', () => {
  const f = fixture('READONLY');
  const actor = f.session('token');
  assert.equal(actor.accountId, 'actor');
  assert.equal(actor.organizationId, 'org');
  assert.equal(actor.role, 'salon_admin');
  assert.deepEqual(f.mutations, []);
});
test('ordinary expired-session cleanup retains its established write path', () => {
  const f = fixture(null, { expires_at: Date.now() - 1 });
  assert.equal(f.session('token'), null);
  assert.equal(f.mutations.length, 1);
  assert.match(f.mutations[0].sql, /^DELETE FROM platform_sessions /);
});
