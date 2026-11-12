const { randomUUID } = require('node:crypto');
const { digest, identifier } = require('./catalog-sqlite.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { validatePostgresSchema } = require('./catalog-postgres.cjs');
const { readRevisionProfile } = require('./revision-profile132.cjs');
const { verifyHotMetadata169 } = require('./hot-metadata-component169.cjs');
const {
  META,
  FUNCTION,
  ARG_TYPES,
  createPatientCapsuleSQL197,
} = require('./patient-capsule-sql197.cjs');
const {
  invalid197,
  signaturePatientCapsule197,
  assertPatientCapsuleSignature197,
  verifyPatientCapsule197,
} = require('./patient-capsule-schema197.cjs');
// Caller owns BEGIN/COMMIT, maintenance evidence, and unknown-ACK reconciliation.
// Only this adjunct's metadata row/table and function change; no head, clinical
// ciphertext, core catalog version, key, asset profile or existing component edit.
async function preparePatientCapsule197(client, role, { rollback = false } = {}) {
  if (typeof rollback !== 'boolean') throw invalid197();
  const authority = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (!authority || (!authority.rolsuper && !authority.rolbypassrls)) throw invalid197();
  const held = (
    await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) held', [KEYS.maintenance])
  ).rows[0];
  if (!held?.held)
    throw Object.assign(invalid197(), { code: 'POSTGRES_PATIENT_CAPSULE_PREPARE_BUSY197' });
  if (
    (
      await client.query(
        'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE expires_at>clock_timestamp() LIMIT 1',
      )
    ).rows.length
  )
    throw Object.assign(invalid197(), { code: 'POSTGRES_PATIENT_CAPSULE_PREPARE_BUSY197' });
  await client.query('SAVEPOINT ct_patient_capsule197');
  try {
    if ((await readRevisionProfile(client, role)) !== 3) throw invalid197();
    for (const kind of ['platform', 'cabinet'])
      await validatePostgresSchema(client, { kind, applicationRole: role });
    const before = await verifyPatientCapsule197(client, role);
    let created = false;
    if (rollback) {
      if (before)
        await client.query(`DROP FUNCTION ${FUNCTION}(${ARG_TYPES}); DROP TABLE ${META};`);
    } else if (!before) {
      if (!(await verifyHotMetadata169(client, role))) throw invalid197();
      const app = identifier(role);
      await client.query(`CREATE TABLE ${META}(version bigint PRIMARY KEY CHECK(version=1),
 epoch uuid NOT NULL,signature jsonb NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'));
 ALTER TABLE ${META} ENABLE ROW LEVEL SECURITY;
 ALTER TABLE ${META} FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON ${META} FROM PUBLIC,${app}; GRANT SELECT ON ${META} TO ${app};
 CREATE POLICY read_patient_component197 ON ${META} FOR SELECT TO ${app} USING(true);
 CREATE POLICY owner_patient_component197 ON ${META} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);`);
      await client.query(createPatientCapsuleSQL197(role));
      const observed = await signaturePatientCapsule197(client, role);
      assertPatientCapsuleSignature197(observed, role);
      await client.query(`INSERT INTO ${META}(version,epoch,signature,digest) VALUES(1,$1,$2,$3)`, [
        randomUUID(),
        observed,
        digest(observed),
      ]);
      created = true;
    }
    const after = await verifyPatientCapsule197(client, role);
    if (rollback ? after !== null : !after) throw invalid197();
    await client.query('RELEASE SAVEPOINT ct_patient_capsule197');
    return {
      prepared: !rollback,
      changed: rollback ? !!before : created,
      capability: 'patient-read-capsule197',
      clinicalRowsChanged: 0,
      dataCopiesCreated: 0,
      ...(after || {}),
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ct_patient_capsule197');
      await client.query('RELEASE SAVEPOINT ct_patient_capsule197');
    } catch {
      error.outcomeUnknown = true;
    }
    throw error;
  }
}
module.exports = { preparePatientCapsule197 };
