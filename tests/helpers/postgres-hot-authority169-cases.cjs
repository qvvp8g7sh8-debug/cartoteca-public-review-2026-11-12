// Proposal only; no PostgreSQL/tests executed by the author.
const assert = require('node:assert/strict');
const {
  MAX_AUTHORITY_BYTES,
} = require('../../src/server/infrastructure/postgres/hot-metadata-sql169.cjs');

async function authorityCases169(t, { f, actor, plan, raw, current, tokenHash }) {
  await t.test(
    'byte eligibility applies before BLOB return and does not cap ordinary authority',
    async () => {
      const original = (
        await f.admin.query(
          'SELECT value FROM cartoteca_platform.accounts WHERE _store_id=$1 AND id=$2',
          [f.platform.storeId, actor.accountId],
        )
      ).rows[0].value;
      const baseline = await raw(),
        bytes = Number(baseline.rows[0].authority_bytes169);
      assert.equal((await raw({ maxAuthorityBytes: bytes })).parsed.eligible, true);
      const small = await raw({ maxAuthorityBytes: bytes - 1 });
      assert.equal(small.parsed.unsupported, 'authority-size');
      assert.equal(small.parsed.authorityRows, null);
      assert.equal(small.rows[0].account_value, null);
      assert.equal(small.rows[0].session_value, null);
      assert.throws(() => plan({ maxAuthorityBytes: MAX_AUTHORITY_BYTES + 1 }));
      try {
        await f.admin.query(
          'UPDATE cartoteca_platform.accounts SET value=$1 WHERE _store_id=$2 AND id=$3',
          [
            f.database.seal({
              email: 'large@synthetic.invalid',
              displayName: 'Synthetic169',
              padding: 'X'.repeat(70000),
            }),
            f.platform.storeId,
            actor.accountId,
          ],
        );
        const large = await raw();
        assert.equal(large.parsed.unsupported, 'authority-size');
        assert.equal(large.rows[0].account_value, null);
        assert.equal(large.rows[0].session_value, null);
        assert.ok(Number(large.rows[0].authority_bytes169) > MAX_AUTHORITY_BYTES);
        assert.equal((await f.oldAuthority()).current.accountId, actor.accountId);
      } finally {
        await f.admin.query(
          'UPDATE cartoteca_platform.accounts SET value=$1 WHERE _store_id=$2 AND id=$3',
          [original, f.platform.storeId, actor.accountId],
        );
      }
    },
  );
  await t.test('existing role/status/session/MFA/expiry projection is unchanged', async () => {
    const account = (
        await f.admin.query(
          'SELECT value,status,global_admin FROM cartoteca_platform.accounts WHERE _store_id=$1 AND id=$2',
          [f.platform.storeId, actor.accountId],
        )
      ).rows[0],
      session = (
        await f.admin.query(
          'SELECT organization_id,value,expires_at FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND token_hash=$2',
          [f.platform.storeId, tokenHash(actor.token)],
        )
      ).rows[0],
      org = (
        await f.admin.query(
          'SELECT status FROM cartoteca_platform.organizations WHERE _store_id=$1 AND id=$2',
          [f.platform.storeId, actor.organizationId],
        )
      ).rows[0],
      membership = (
        await f.admin.query(
          'SELECT status,role FROM cartoteca_platform.memberships WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3',
          [f.platform.storeId, actor.organizationId, actor.accountId],
        )
      ).rows[0];
    const updateAccount = (status, globalAdmin = account.global_admin, value = account.value) =>
      f.admin.query(
        'UPDATE cartoteca_platform.accounts SET status=$1,global_admin=$2,value=$3 WHERE _store_id=$4 AND id=$5',
        [status, globalAdmin, value, f.platform.storeId, actor.accountId],
      );
    const updateMembership = (status, selectedRole = membership.role) =>
      f.admin.query(
        'UPDATE cartoteca_platform.memberships SET status=$1,role=$2 WHERE _store_id=$3 AND organization_id=$4 AND account_id=$5',
        [status, selectedRole, f.platform.storeId, actor.organizationId, actor.accountId],
      );
    try {
      for (const selectedRole of ['owner', 'salon_admin', 'cosmetologist']) {
        await updateMembership('active', selectedRole);
        assert.equal(current(await raw()).current.role, selectedRole);
      }
      await updateMembership(membership.status, membership.role);
      await updateMembership('inactive');
      assert.equal(current(await raw()).current, null);
      await updateMembership(membership.status);
      await updateAccount('inactive');
      assert.equal(current(await raw()).current, null);
      await updateAccount(account.status);
      await f.admin.query(
        'UPDATE cartoteca_platform.organizations SET status=$1 WHERE _store_id=$2 AND id=$3',
        ['inactive', f.platform.storeId, actor.organizationId],
      );
      assert.equal(current(await raw()).current, null);
      await f.admin.query(
        'UPDATE cartoteca_platform.organizations SET status=$1 WHERE _store_id=$2 AND id=$3',
        [org.status, f.platform.storeId, actor.organizationId],
      );
      await f.admin.query(
        'UPDATE cartoteca_platform.platform_sessions SET organization_id=NULL WHERE _store_id=$1 AND token_hash=$2',
        [f.platform.storeId, tokenHash(actor.token)],
      );
      assert.equal(current(await raw()).unsupported, 'session-selection');
      await f.admin.query(
        'UPDATE cartoteca_platform.platform_sessions SET organization_id=$1 WHERE _store_id=$2 AND token_hash=$3',
        [session.organization_id, f.platform.storeId, tokenHash(actor.token)],
      );
      const mfa = f.database.seal({
        ...f.database.open(account.value),
        adminMfa: { enabled: true, revision: 17 },
      });
      await updateAccount('active', 1, mfa);
      await f.admin.query(
        'UPDATE cartoteca_platform.platform_sessions SET value=$1 WHERE _store_id=$2 AND token_hash=$3',
        [f.database.seal({ adminMfaRevision: 16 }), f.platform.storeId, tokenHash(actor.token)],
      );
      const deniedMfa = await raw();
      assert.equal(current(deniedMfa).current, null);
      assert.equal(
        (deniedMfa.rows[0].scope_rows169 || []).some((r) => r[0] === 'cabinet'),
        false,
      );
      await f.admin.query(
        'UPDATE cartoteca_platform.platform_sessions SET value=$1 WHERE _store_id=$2 AND token_hash=$3',
        [f.database.seal({ adminMfaRevision: 17 }), f.platform.storeId, tokenHash(actor.token)],
      );
      assert.equal(
        current(await raw()).current.globalAdmin,
        true,
        'kernel later rejects403; DB capability does not invent a different MFA policy',
      );
      await updateAccount(account.status);
      await f.admin.query(
        'UPDATE cartoteca_platform.platform_sessions SET value=$1,expires_at=$2 WHERE _store_id=$3 AND token_hash=$4',
        [session.value, Date.now() - 1, f.platform.storeId, tokenHash(actor.token)],
      );
      assert.equal(current(await raw()).current, null);
      await f.admin.query(
        'UPDATE cartoteca_platform.platform_sessions SET expires_at=$1 WHERE _store_id=$2 AND token_hash=$3',
        [session.expires_at, f.platform.storeId, tokenHash(actor.token)],
      );
      const beforeWait = await raw(),
        mockNow = t.mock.method(Date, 'now', () => Number(session.expires_at) + 1);
      try {
        assert.equal(
          current(beforeWait).current,
          null,
          'expiry is checked after later async asset waits',
        );
      } finally {
        mockNow.mock.restore();
      }
    } finally {
      await updateAccount(account.status);
      await updateMembership(membership.status, membership.role);
      await f.admin.query(
        'UPDATE cartoteca_platform.organizations SET status=$1 WHERE _store_id=$2 AND id=$3',
        [org.status, f.platform.storeId, actor.organizationId],
      );
      await f.admin.query(
        'UPDATE cartoteca_platform.platform_sessions SET organization_id=$1,value=$2,expires_at=$3 WHERE _store_id=$4 AND token_hash=$5',
        [
          session.organization_id,
          session.value,
          session.expires_at,
          f.platform.storeId,
          tokenHash(actor.token),
        ],
      );
    }
  });
}
module.exports = { authorityCases169 };
