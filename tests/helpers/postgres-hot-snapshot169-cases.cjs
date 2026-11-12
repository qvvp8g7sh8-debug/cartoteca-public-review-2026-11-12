// Proposal only; no PostgreSQL/tests executed by the author.
const assert = require('node:assert/strict');
const { identifier } = require('../../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { KEYS } = require('../../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  parseHotMetadata169,
} = require('../../src/server/infrastructure/postgres/hot-metadata-query169.cjs');
const { authorityValue } = require('../../src/server/infrastructure/postgres/read-session152.cjs');
const { deadline169 } = require('./postgres-hot-metadata169-fixture.cjs');

async function snapshotCase169(t, { f, actor, plan, raw, role }) {
  await t.test(
    'one internal RC SELECT sees post-lock S1 while STABLE control sees outer S0',
    async () => {
      const gate = await f.client(true),
        gateKey = '7169000000000001',
        q = plan(),
        originalRole = (
          await f.admin.query(
            'SELECT role FROM cartoteca_platform.memberships WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3',
            [f.platform.storeId, actor.organizationId, actor.accountId],
          )
        ).rows[0].role,
        before = (await raw()).parsed.versions;
      let pending,
        unlocked = false;
      await f.admin.query('CREATE SCHEMA cartoteca_test169');
      try {
        await f.admin
          .query(`CREATE FUNCTION cartoteca_test169.gate169(p_value text,p_key bigint) RETURNS text
        LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $test$
        BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(p_key); RETURN p_value; END $test$;
        CREATE FUNCTION cartoteca_test169.old_role169(p text,o text,a text) RETURNS text
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $test$
        SELECT role FROM cartoteca_platform.memberships WHERE _store_id=p AND organization_id=o AND account_id=a $test$;
        REVOKE ALL ON FUNCTION cartoteca_test169.gate169(text,bigint),cartoteca_test169.old_role169(text,text,text) FROM PUBLIC;
        GRANT USAGE ON SCHEMA cartoteca_test169 TO ${identifier(role)};
        GRANT EXECUTE ON FUNCTION cartoteca_test169.gate169(text,bigint),cartoteca_test169.old_role169(text,text,text) TO ${identifier(role)};`);
        await gate.query('SELECT pg_advisory_lock($1::bigint)', [gateKey]);
        const call = q.text
          .trim()
          .replace(/^SELECT\s+\*\s+FROM\s+/i, '')
          .replace(/;$/, '');
        assert.notEqual(
          call,
          q.text.trim(),
          'closed query builder produces exactly a function SELECT',
        );
        assert.match(call, /hot_read_metadata169/);
        const gateParameter = '$' + (q.values.length + 1),
          gated = call.replace(
            /\$1\b/,
            `cartoteca_test169.gate169($1::text,${gateParameter}::bigint)`,
          );
        assert.notEqual(gated, call);
        pending = f.app.query(
          `SELECT cartoteca_test169.old_role169($1::text,$5::text,$4::text) outer_role169,h.* FROM ${gated} h`,
          [...q.values, gateKey],
        );
        // Avoid an unhandled rejection while the controller checks lock state.
        pending.catch(() => {});
        await deadline169(
          async () =>
            Number(
              (
                await f.admin.query(
                  "SELECT count(*) n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                  [f.app.processID],
                )
              ).rows[0].n,
            ) === 1,
          'synthetic169 outer statement did not reach its argument barrier',
        );
        await f.admin.query('BEGIN');
        try {
          const locked = (
            await f.admin.query('SELECT pg_try_advisory_xact_lock($1::bigint) held', [
              KEYS.maintenance,
            ])
          ).rows[0].held;
          assert.equal(locked, true, 'hot helper has not yet acquired maintenance S');
          await f.admin.query(
            "UPDATE cartoteca_platform.memberships SET role='salon_admin' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
            [f.platform.storeId, actor.organizationId, actor.accountId],
          );
          await f.admin.query('COMMIT');
        } catch (error) {
          await f.admin.query('ROLLBACK');
          throw error;
        }
        assert.equal(
          (await gate.query('SELECT pg_advisory_unlock($1::bigint) held', [gateKey])).rows[0].held,
          true,
        );
        unlocked = true;
        const result = await pending,
          { outer_role169, ...productionRow } = result.rows[0],
          parsed = parseHotMetadata169([productionRow], q.expected);
        assert.equal(outer_role169, originalRole, 'STABLE negative control retains S0');
        assert.equal(
          result.rows[0].membership_role,
          'salon_admin',
          'production VOLATILE internal SELECT uses S1',
        );
        assert.equal(parsed.eligible, true);
        assert.notEqual(parsed.versions, before, 'source-clock proof is from same new snapshot');
        assert.equal(
          authorityValue(parsed.authorityRows, f.database.open).current.role,
          'salon_admin',
        );
        assert.equal(
          Number(
            (
              await f.admin.query(
                "SELECT count(*) n FROM pg_locks WHERE pid=$1 AND locktype='advisory'",
                [f.app.processID],
              )
            ).rows[0].n,
          ),
          0,
        );
      } finally {
        if (!unlocked)
          await gate.query('SELECT pg_advisory_unlock($1::bigint)', [gateKey]).catch(() => {});
        if (pending) await pending.catch(() => {});
        await f.admin.query(
          'UPDATE cartoteca_platform.memberships SET role=$1 WHERE _store_id=$2 AND organization_id=$3 AND account_id=$4',
          [originalRole, f.platform.storeId, actor.organizationId, actor.accountId],
        );
        await f.admin.query('DROP SCHEMA cartoteca_test169 CASCADE');
      }
    },
  );
}
module.exports = { snapshotCase169 };
