const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { createHash, randomBytes } = require('node:crypto');
const { patientCapsulePGFixture197 } = require('./helpers/postgres-patient-capsule197-fixture.cjs');
const {
  preparePatientCapsule197,
} = require('../src/server/infrastructure/postgres/patient-capsule-prepare197.cjs');
const {
  verifyPatientCapsule197,
} = require('../src/server/infrastructure/postgres/patient-capsule-schema197.cjs');
const {
  createPatientCapsuleQuery197,
  parsePatientCapsule197,
} = require('../src/server/infrastructure/postgres/patient-capsule-query197.cjs');
const {
  META,
  FUNCTION,
  ARG_TYPES,
} = require('../src/server/infrastructure/postgres/patient-capsule-sql197.cjs');
const { identifier } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');

test(
  '197 prepared point capsule is reversible, role-bound and owns the pre-BEGIN fence',
  { timeout: 120000 },
  async (t) => {
    const f = await patientCapsulePGFixture197(t),
      role = f.runtime.application.user,
      app = new Client(f.runtime.application);
    let transaction = false,
      sessionFence = false;
    const invalid = (error) =>
      error?.status === 503 && error.code === 'POSTGRES_PATIENT_CAPSULE_INVALID';
    const componentInvalid = (error) =>
      error?.status === 503 && error.code === 'POSTGRES_PATIENT_CAPSULE_COMPONENT_INVALID197';
    async function transition(options) {
      await f.admin.query('BEGIN');
      try {
        const value = await preparePatientCapsule197(f.admin, role, options);
        await f.admin.query('COMMIT');
        return value;
      } catch (e) {
        await f.admin.query('ROLLBACK');
        throw e;
      }
    }
    async function fingerprint() {
      return (
        await f.admin
          .query(`SELECT count(*)::text n,md5(COALESCE(string_agg(md5(row_to_json(x)::text),'' ORDER BY md5(row_to_json(x)::text)),'')) hash FROM (
 SELECT _store_id,id,value FROM cartoteca_cabinet.patients UNION ALL
 SELECT _store_id,key,value FROM cartoteca_cabinet.meta UNION ALL
 SELECT _store_id,id,value FROM cartoteca_cabinet.cabinet_patient_records) x`)
      ).rows[0];
    }
    async function queryPlan() {
      const actor = f.actors[0],
        platform = f.platform.storeId;
      const row = (
        await f.admin.query(
          'SELECT id FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND token_hash=$2',
          [platform, createHash('sha256').update(actor.token).digest('hex')],
        )
      ).rows[0];
      const cap = await verifyPatientCapsule197(app, role);
      const p = (
        await f.admin.query(
          "SELECT version,catalog_hash FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
          [platform],
        )
      ).rows[0];
      return createPatientCapsuleQuery197({
        marker: f.identity.lineage,
        capability: cap,
        platformTemplate: { version: Number(p.version), hash: p.catalog_hash },
      })({
        scope: {
          kind: 'cabinet',
          storeId: f.cabinets[0].storeId,
          organizationId: actor.organizationId,
        },
        current: { ...actor, sessionId: row.id, role: 'owner', globalAdmin: false },
        token: actor.token,
        selection: {
          kind: 'card',
          id: 'empty',
          audience: '*',
          cursor: { visit: 0, outcome: 0, upcoming: 0 },
        },
      });
    }
    async function begin({ fence = true } = {}) {
      await app.query(
        "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
        [f.platform.storeId],
      );
      if (fence) {
        assert.equal(
          (
            await app.query('SELECT pg_try_advisory_lock_shared($1::bigint) held', [
              KEYS.maintenance,
            ])
          ).rows[0].held,
          true,
        );
        sessionFence = true;
      }
      await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transaction = true;
    }
    async function rollback() {
      if (transaction) {
        await app.query('ROLLBACK');
        transaction = false;
      }
      if (sessionFence) {
        await app.query('SELECT pg_advisory_unlock_shared($1::bigint)', [KEYS.maintenance]);
        sessionFence = false;
      }
    }
    try {
      await app.connect();
      await f.prepare({ capsule: false });
      const before = await fingerprint();
      await t.test(
        'outer rollback, install and idempotence change no existing ciphertext',
        async () => {
          assert.equal(await verifyPatientCapsule197(app, role), null);
          await f.admin.query('BEGIN');
          try {
            assert.equal((await preparePatientCapsule197(f.admin, role)).prepared, true);
          } finally {
            await f.admin.query('ROLLBACK');
          }
          assert.equal(await verifyPatientCapsule197(app, role), null);
          const installed = await transition();
          assert.equal(installed.prepared, true);
          assert.equal(installed.clinicalRowsChanged, 0);
          assert.equal(installed.dataCopiesCreated, 0);
          const again = await transition();
          assert.equal(again.changed, false);
          assert.equal(again.epoch, installed.epoch);
          assert.equal(again.digest, installed.digest);
          assert.deepEqual(await fingerprint(), before);
        },
      );
      await t.test(
        'application can inspect the component but cannot alter its authority row',
        async () => {
          assert.equal((await app.query(`SELECT version FROM ${META}`)).rows.length, 1);
          await assert.rejects(
            app.query(`UPDATE ${META} SET digest=digest`),
            (e) => e.code === '42501',
          );
          await assert.rejects(app.query(`DELETE FROM ${META}`), (e) => e.code === '42501');
        },
      );
      await t.test(
        'partial install, function owner and unexpected PUBLIC EXECUTE never attest',
        async () => {
          await f.admin.query('BEGIN');
          try {
            await f.admin.query(`DROP FUNCTION ${FUNCTION}(${ARG_TYPES})`);
            await assert.rejects(verifyPatientCapsule197(f.admin, role), componentInvalid);
          } finally {
            await f.admin.query('ROLLBACK');
          }
          const owner = (await f.admin.query('SELECT current_user owner')).rows[0].owner;
          const temp = 'ct_capsule197_' + randomBytes(6).toString('hex');
          await f.admin.query(`CREATE ROLE ${identifier(temp)} NOLOGIN`);
          try {
            await f.admin.query(
              `ALTER FUNCTION ${FUNCTION}(${ARG_TYPES}) OWNER TO ${identifier(temp)}`,
            );
            await assert.rejects(verifyPatientCapsule197(app, role), componentInvalid);
          } finally {
            await f.admin.query(
              `ALTER FUNCTION ${FUNCTION}(${ARG_TYPES}) OWNER TO ${identifier(owner)}`,
            );
            await f.admin.query(`DROP ROLE ${identifier(temp)}`);
          }
          await f.admin.query(`GRANT EXECUTE ON FUNCTION ${FUNCTION}(${ARG_TYPES}) TO PUBLIC`);
          try {
            await assert.rejects(verifyPatientCapsule197(app, role), componentInvalid);
          } finally {
            await f.admin.query(`REVOKE EXECUTE ON FUNCTION ${FUNCTION}(${ARG_TYPES}) FROM PUBLIC`);
          }
          assert.equal((await verifyPatientCapsule197(app, role)).version, 1);
        },
      );
      await t.test(
        'held session fence prevents maintenance before BEGIN then transfers to this RR',
        async () => {
          const plan = await queryPlan();
          await app.query(
            "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
            [f.platform.storeId],
          );
          assert.equal(
            (
              await app.query('SELECT pg_try_advisory_lock_shared($1::bigint) held', [
                KEYS.maintenance,
              ])
            ).rows[0].held,
            true,
          );
          sessionFence = true;
          assert.equal(
            (
              await f.admin.query('SELECT pg_try_advisory_lock($1::bigint) held', [
                KEYS.maintenance,
              ])
            ).rows[0].held,
            false,
          );
          await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          transaction = true;
          try {
            const result = await app.query(plan.text, plan.values);
            sessionFence = false;
            const packet = parsePatientCapsule197(result.rows, plan.expected);
            assert.equal(packet.supported, true);
            assert.deepEqual(packet.released, [true]);
            assert.equal(
              (
                await f.admin.query('SELECT pg_try_advisory_lock($1::bigint) held', [
                  KEYS.maintenance,
                ])
              ).rows[0].held,
              false,
            );
            assert.equal(
              (
                await app.query(
                  "SELECT current_setting('cartoteca.kind') kind,current_setting('cartoteca.store_id') id",
                )
              ).rows[0].kind,
              'platform',
            );
          } finally {
            await rollback();
          }
          assert.equal(
            (
              await f.admin.query('SELECT pg_try_advisory_lock($1::bigint) held', [
                KEYS.maintenance,
              ])
            ).rows[0].held,
            true,
          );
          await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.maintenance]);
        },
      );
      await t.test(
        'missing fence or fresh membership mismatch yields no cipher/body or patient hint',
        async () => {
          let plan = await queryPlan();
          await begin({ fence: false });
          try {
            const result = await app.query(plan.text, plan.values);
            assert.ok(result.rows.every((r) => r.cipher197 === null));
            assert.throws(() => parsePatientCapsule197(result.rows, plan.expected), invalid);
          } finally {
            await rollback();
          }
          plan = await queryPlan();
          await f.admin.query(
            "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
            [f.platform.storeId],
          );
          await f.admin.query(
            "UPDATE cartoteca_platform.memberships SET status='revoked' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
            [f.platform.storeId, f.actors[0].organizationId, f.actors[0].accountId],
          );
          await begin();
          try {
            const result = await app.query(plan.text, plan.values);
            sessionFence = false;
            assert.equal(result.rows.length, 1);
            assert.equal(result.rows[0].payload197.patientPageEmpty165, true);
            assert.ok(
              result.rows.every(
                (r) => r.cipher197 === null && r.account197 === null && r.session197 === null,
              ),
            );
            assert.throws(
              () => parsePatientCapsule197(result.rows, plan.expected),
              (e) => [403, 503].includes(e.status),
            );
          } finally {
            await rollback();
            await f.admin.query(
              "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
              [f.platform.storeId],
            );
            await f.admin.query(
              "UPDATE cartoteca_platform.memberships SET status='active' WHERE _store_id=$1 AND organization_id=$2 AND account_id=$3",
              [f.platform.storeId, f.actors[0].organizationId, f.actors[0].accountId],
            );
          }
        },
      );
      await t.test(
        'current-data inverse and fresh install leave sources exact and rotate component identity',
        async () => {
          const old = await verifyPatientCapsule197(app, role);
          const removed = await transition({ rollback: true });
          assert.equal(removed.prepared, false);
          assert.equal(await verifyPatientCapsule197(app, role), null);
          assert.deepEqual(await fingerprint(), before);
          const next = await transition();
          assert.notEqual(next.epoch, old.epoch);
          assert.deepEqual(await fingerprint(), before);
        },
      );
    } finally {
      await rollback();
      await app.end();
      await f.close();
    }
  },
);
