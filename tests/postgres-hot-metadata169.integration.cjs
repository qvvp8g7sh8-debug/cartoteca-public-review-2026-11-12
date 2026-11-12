// WORKSPACE PROPOSAL ONLY. No PostgreSQL/tests were executed by this author.
// Covers the DB capability, not later native-kernel HMAC/assets/pool integration.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { hotMetadataFixture169 } = require('./helpers/postgres-hot-metadata169-fixture.cjs');
const {
  prepareHotMetadata169,
} = require('../src/server/infrastructure/postgres/hot-metadata-prepare169.cjs');
const {
  verifyHotMetadata169,
} = require('../src/server/infrastructure/postgres/hot-metadata-component169.cjs');
const {
  hotMetadataQuery169,
  parseHotMetadata169,
} = require('../src/server/infrastructure/postgres/hot-metadata-query169.cjs');
const {
  TABLE,
  FUNCTION,
} = require('../src/server/infrastructure/postgres/hot-metadata-sql169.cjs');
const { authorityValue } = require('../src/server/infrastructure/postgres/read-session152.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');

const { authorityCases169 } = require('./helpers/postgres-hot-authority169-cases.cjs');
const { integrityCases169 } = require('./helpers/postgres-hot-integrity169-cases.cjs');
const { snapshotCase169 } = require('./helpers/postgres-hot-snapshot169-cases.cjs');

const argumentTypes169 =
  'text,text,text,text,text,text,text,text,text,bigint,text,bigint,text,bigint';
test(
  '169 optional DB-only hot metadata preserves authority, source proofs and post-lock snapshot',
  { timeout: 180000 },
  async (t) => {
    const f = await hotMetadataFixture169(t),
      marker = f.identity.lineage,
      role = f.runtime.application.user,
      actor = f.actors[0],
      functionIdentity = `${FUNCTION}(${argumentTypes169})`;
    let capability,
      prepared = false;
    const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
    function plan(options = {}) {
      return hotMetadataQuery169({
        marker,
        capability,
        claimedAccountId: actor.accountId,
        claimedOrganizationId: actor.organizationId,
        tokenHash: tokenHash(actor.token),
        platformTemplate: { version: f.catalog.version, hash: digest(f.catalog) },
        ...options,
      });
    }
    async function raw(options = {}, connection = f.app) {
      const query = plan(options);
      assert.equal(query.unsupported, undefined, 'candidate must have an explicit marker binding');
      const result = await connection.query(query.text, query.values);
      return { query, rows: result.rows, parsed: parseHotMetadata169(result.rows, query.expected) };
    }
    function current(value) {
      assert.ok(value.parsed.authorityRows);
      return authorityValue(value.parsed.authorityRows, f.database.open);
    }
    async function transition(rollback = false, selectedMarker = marker) {
      await f.admin.query('BEGIN');
      try {
        const value = await prepareHotMetadata169(f.admin, role, {
          marker: selectedMarker,
          rollback,
        });
        await f.admin.query('COMMIT');
        prepared = !rollback;
        return value;
      } catch (error) {
        await f.admin.query('ROLLBACK');
        throw error;
      }
    }
    async function assertUnavailable(fn) {
      await assert.rejects(fn, (error) => error.status === 503);
    }
    try {
      const businessBefore = await f.fingerprints(),
        assetsBefore = f.assetStats();
      await t.test(
        'absent is optional; a partial object is invalid rather than absent',
        async () => {
          assert.equal(await verifyHotMetadata169(f.app, role, { marker }), null);
          await f.admin.query(`CREATE TABLE ${TABLE}(synthetic169 BIGINT)`);
          try {
            await assertUnavailable(() => verifyHotMetadata169(f.app, role, { marker }));
          } finally {
            await f.admin.query(`DROP TABLE ${TABLE}`);
          }
        },
      );
      await transition();
      capability = await verifyHotMetadata169(f.app, role, { marker });
      assert.equal(capability.version, 1);
      assert.equal(capability.eligibleMarker, true);
      assert.deepEqual(await f.fingerprints(), businessBefore);
      assert.deepEqual(f.assetStats(), assetsBefore);

      await t.test(
        'raw BYTEA authority and exactly three clocks use one no-GUC client statement',
        async () => {
          const old = await f.oldAuthority(),
            at = f.trace.length,
            value = await raw();
          assert.equal(f.trace.length - at, 1);
          assert.equal(value.rows.length, 1);
          assert.equal(Buffer.isBuffer(value.rows[0].account_value), true);
          assert.equal(Buffer.isBuffer(value.rows[0].session_value), true);
          assert.deepEqual(current(value), old);
          assert.equal(value.parsed.eligible, true);
          assert.equal(value.parsed.scope.storeId, f.cabinets[0].storeId);
          const versions = JSON.parse(value.parsed.versions);
          assert.equal(versions.length, 4);
          assert.equal(versions[0], capability.readScopes.epoch);
          assert.deepEqual(
            versions.slice(1).map((r) => r.slice(0, 3)),
            [
              ['platform', f.platform.storeId, '*'],
              ['platform', f.platform.storeId, actor.organizationId],
              ['cabinet', f.cabinets[0].storeId, '*'],
            ],
          );
          assert.doesNotMatch(
            value.query.text,
            /set_config|BEGIN|COMMIT|cabinet_appointments|cabinet_patient_records/i,
          );
          await f.app.query(
            "SELECT set_config('cartoteca.kind','cabinet',false),set_config('cartoteca.store_id',$1,false)",
            [f.cabinets[1].storeId],
          );
          assert.equal(
            (await raw()).parsed.eligible,
            true,
            'helper does not trust caller store GUC',
          );
        },
      );
      await t.test(
        'actual token identity survives wrong claims for existing428; no C clock is exposed',
        async () => {
          for (const options of [
            { claimedAccountId: f.actors[3].accountId },
            { claimedOrganizationId: f.actors[3].organizationId },
          ]) {
            const value = await raw(options),
              authority = current(value);
            assert.equal(value.parsed.eligible, false);
            assert.equal(authority.current.accountId, actor.accountId);
            assert.equal(authority.current.organizationId, actor.organizationId);
            assert.equal(
              (value.rows[0].scope_rows169 || []).some((r) => r[0] === 'cabinet'),
              false,
            );
          }
          const none = await raw({ tokenHash: tokenHash('unknown-synthetic169-token') });
          assert.equal(current(none).current, null);
        },
      );
      await t.test(
        'valid marker generation mismatch declines hot without disabling the capability',
        async () => {
          const oldMarker = { ...marker, migrationId: randomUUID() },
            oldCapability = await verifyHotMetadata169(f.app, role, { marker: oldMarker });
          assert.equal(oldCapability.version, 1);
          assert.equal(oldCapability.eligibleMarker, false);
          const value = await raw({ marker: oldMarker, capability: oldCapability });
          assert.equal(value.parsed.eligible, false);
          assert.match(value.parsed.unsupported, /generation/);
          assert.equal((await raw()).parsed.eligible, true);
          const noExplicit = {
            ...marker,
            stores: marker.stores.filter((s) => s.organizationId !== f.organizations[1]),
          };
          assert.equal(
            plan({ marker: noExplicit, claimedOrganizationId: f.organizations[1] }).unsupported,
            'explicit-binding',
          );
        },
      );
      await authorityCases169(t, { f, actor, plan, raw, current, tokenHash });
      await t.test(
        'raw DML clocks commit atomically and rollback leaves visible proof unchanged',
        async () => {
          const before = (await raw()).parsed.versions;
          await f.admin.query('BEGIN');
          await f.admin.query(
            "UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key='revision'",
            [f.cabinets[0].storeId],
          );
          await f.admin.query('ROLLBACK');
          assert.equal((await raw()).parsed.versions, before);
          await f.admin.query(
            "UPDATE cartoteca_cabinet.meta SET value=value WHERE _store_id=$1 AND key='revision'",
            [f.cabinets[0].storeId],
          );
          const committed = (await raw()).parsed.versions;
          assert.notEqual(committed, before);
          await f.admin.query(
            'UPDATE cartoteca_platform.organizations SET value=value WHERE _store_id=$1 AND id=$2',
            [f.platform.storeId, f.organizations[1]],
          );
          assert.equal(
            (await raw()).parsed.versions,
            committed,
            'unrelated org clock is outside target proof',
          );
        },
      );
      await t.test(
        'busy maintenance fence is a successful technical row, with no session lock leak',
        async () => {
          const at = f.trace.length;
          await f.admin.query('BEGIN');
          try {
            await f.admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
            const q = plan(),
              result = await f.app.query(q.text, q.values);
            assert.equal(result.rows.length, 1);
            assert.equal(result.rows[0].fence_locked, false);
            assert.throws(
              () => parseHotMetadata169(result.rows, q.expected),
              (e) => e.status === 503,
            );
            assert.equal(f.trace.length - at, 1);
          } finally {
            await f.admin.query('ROLLBACK');
          }
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
          assert.equal((await raw()).parsed.eligible, true);
        },
      );
      await t.test('RR caller declines without changing session default isolation', async () => {
        await f.app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          assert.equal((await raw()).parsed.unsupported, 'isolation');
        } finally {
          await f.app.query('ROLLBACK');
        }
        assert.equal(
          (await f.app.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
          'read committed',
        );
      });
      await t.test(
        'missing clock declines; invalid catalog and scope component fail closed',
        async () => {
          await f.admin.query('BEGIN');
          try {
            await f.admin.query(
              "DELETE FROM cartoteca_catalog.read_scope_versions163 WHERE kind='cabinet' AND store_id=$1 AND scope_id='*'",
              [f.cabinets[0].storeId],
            );
            assert.equal((await raw({}, f.admin)).parsed.unsupported, 'clock-missing');
          } finally {
            await f.admin.query('ROLLBACK');
          }
          await f.admin.query('BEGIN');
          try {
            await f.admin.query(
              "UPDATE cartoteca_catalog.stores SET metadata='{}'::jsonb WHERE kind='cabinet' AND store_id=$1",
              [f.cabinets[0].storeId],
            );
            await assertUnavailable(() => raw({}, f.admin));
          } finally {
            await f.admin.query('ROLLBACK');
          }
          await f.admin.query('BEGIN');
          try {
            await f.admin.query(
              'UPDATE cartoteca_catalog.read_scope_component163 SET epoch=$1::uuid WHERE version=1',
              [randomUUID()],
            );
            await assertUnavailable(() => raw({}, f.admin));
          } finally {
            await f.admin.query('ROLLBACK');
          }
          assert.equal((await raw()).parsed.eligible, true);
        },
      );

      capability = await integrityCases169(t, {
        f,
        actor,
        plan,
        raw,
        current,
        role,
        functionIdentity,
        marker,
        assertUnavailable,
      });
      await snapshotCase169(t, { f, actor, plan, raw, role });
      await t.test(
        'inverse preserves business/asset fingerprints and only removes optional169',
        async () => {
          const before = await f.fingerprints(),
            assets = f.assetStats();
          await transition(true);
          assert.equal(await verifyHotMetadata169(f.app, role, { marker }), null);
          assert.deepEqual(await f.fingerprints(), before);
          assert.deepEqual(f.assetStats(), assets);
          assert.equal(
            Number(
              (
                await f.admin.query(
                  'SELECT count(*) n FROM cartoteca_catalog.read_scope_component163',
                )
              ).rows[0].n,
            ),
            1,
          );
        },
      );
    } finally {
      try {
        if (prepared) await transition(true);
      } finally {
        await f.close();
      }
    }
  },
);
