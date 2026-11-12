// Proposal only; no PostgreSQL/tests executed by the author.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { TABLE, META } = require('../../src/server/infrastructure/postgres/hot-metadata-sql169.cjs');
const { identifier } = require('../../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  verifyHotMetadata169,
} = require('../../src/server/infrastructure/postgres/hot-metadata-component169.cjs');
const {
  parseHotMetadata169,
} = require('../../src/server/infrastructure/postgres/hot-metadata-query169.cjs');

async function integrityCases169(
  t,
  { f, actor, plan, raw, current, role, functionIdentity, marker, assertUnavailable },
) {
  let capability;
  await t.test(
    'binding proof and independently marker-derived expected Cstore reject wrong stores',
    async () => {
      const original = (
        await f.admin.query(
          `SELECT cabinet_store_id FROM ${TABLE} WHERE platform_store_id=$1 AND organization_id=$2`,
          [f.platform.storeId, actor.organizationId],
        )
      ).rows[0].cabinet_store_id;
      try {
        await f.admin.query(
          `UPDATE ${TABLE} SET cabinet_store_id=$1 WHERE platform_store_id=$2 AND organization_id=$3`,
          [randomUUID(), f.platform.storeId, actor.organizationId],
        );
        await assertUnavailable(() => raw());
      } finally {
        await f.admin.query(
          `UPDATE ${TABLE} SET cabinet_store_id=$1 WHERE platform_store_id=$2 AND organization_id=$3`,
          [original, f.platform.storeId, actor.organizationId],
        );
      }
      const q = plan(),
        values = [...q.values];
      values[6] = f.cabinets[1].storeId;
      const result = await f.app.query(q.text, values);
      assert.throws(
        () => parseHotMetadata169(result.rows, q.expected),
        (e) => e.status === 503,
      );
      assert.equal((await raw()).parsed.eligible, true);
    },
  );
  await t.test(
    'new registry has no business FK and orphan bindings never become eligible',
    async () => {
      const fks = await f.admin.query(
        "SELECT count(*) n FROM pg_constraint WHERE contype='f' AND conrelid IN(to_regclass($1),to_regclass($2))",
        [TABLE, META],
      );
      assert.equal(Number(fks.rows[0].n), 0);
      await f.admin.query('BEGIN');
      try {
        await f.admin.query('SET CONSTRAINTS ALL DEFERRED');
        await f.admin.query(
          'DELETE FROM cartoteca_platform.organizations WHERE _store_id=$1 AND id=$2',
          [f.platform.storeId, actor.organizationId],
        );
        const missingOrg = await raw({}, f.admin);
        assert.equal(missingOrg.parsed.eligible, false);
        assert.equal(current(missingOrg).current, null);
      } finally {
        await f.admin.query('ROLLBACK');
      }
      const before = await f.fingerprints();
      await f.admin.query('BEGIN');
      try {
        await f.admin.query('TRUNCATE cartoteca_cabinet.cabinet_appointments');
      } finally {
        await f.admin.query('ROLLBACK');
      }
      assert.deepEqual(await f.fingerprints(), before);
      assert.equal((await raw()).parsed.eligible, true);
    },
  );
  await t.test(
    'exact helper definition and grants are attested; application cannot write registry',
    async () => {
      for (const sql of [`UPDATE ${TABLE} SET binding_proof=binding_proof`, `DELETE FROM ${TABLE}`])
        await assert.rejects(f.app.query(sql), (e) => e.code === '42501');
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${functionIdentity} TO PUBLIC`);
      try {
        await assertUnavailable(() => verifyHotMetadata169(f.app, role, { marker }));
      } finally {
        await f.admin.query(`REVOKE ALL ON FUNCTION ${functionIdentity} FROM PUBLIC`);
      }
      await f.admin.query(`ALTER FUNCTION ${functionIdentity} STABLE`);
      try {
        await assertUnavailable(() => verifyHotMetadata169(f.app, role, { marker }));
      } finally {
        await f.admin.query(`ALTER FUNCTION ${functionIdentity} VOLATILE`);
      }
      const owner = (
        await f.admin.query(
          'SELECT pg_get_userbyid(proowner) owner FROM pg_proc WHERE oid=to_regprocedure($1)',
          [functionIdentity],
        )
      ).rows[0].owner;
      await f.admin.query(`ALTER FUNCTION ${functionIdentity} OWNER TO ${identifier(role)}`);
      try {
        await assertUnavailable(() => verifyHotMetadata169(f.app, role, { marker }));
      } finally {
        await f.admin.query(`ALTER FUNCTION ${functionIdentity} OWNER TO ${identifier(owner)}`);
        await f.admin.query(`GRANT EXECUTE ON FUNCTION ${functionIdentity} TO ${identifier(role)}`);
      }
      await f.admin.query(`GRANT UPDATE ON ${TABLE} TO ${identifier(role)}`);
      try {
        await assertUnavailable(() => verifyHotMetadata169(f.app, role, { marker }));
      } finally {
        await f.admin.query(`REVOKE UPDATE ON ${TABLE} FROM ${identifier(role)}`);
      }
      const definition = (
        await f.admin.query(
          'SELECT pg_get_functiondef(to_regprocedure($1)) definition,p.prosrc FROM pg_proc p WHERE p.oid=to_regprocedure($1)',
          [functionIdentity],
        )
      ).rows[0];
      assert.ok(definition.definition.includes(definition.prosrc));
      await f.admin.query(
        definition.definition.replace(
          definition.prosrc,
          () => definition.prosrc + '\n-- synthetic169 body mismatch\n',
        ),
      );
      try {
        await assertUnavailable(() => verifyHotMetadata169(f.app, role, { marker }));
      } finally {
        await f.admin.query(definition.definition);
      }
      capability = await verifyHotMetadata169(f.app, role, { marker });
      assert.equal((await raw()).parsed.eligible, true);
    },
  );
  return capability;
}
module.exports = { integrityCases169 };
