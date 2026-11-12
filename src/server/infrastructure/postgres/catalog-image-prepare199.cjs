const { randomUUID } = require('node:crypto');
const { digest, identifier } = require('./catalog-sqlite.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { validatePostgresSchema } = require('./catalog-postgres.cjs');
const { readRevisionProfile } = require('./revision-profile132.cjs');
const { META, variants199, createCatalogImageSQL199 } = require('./catalog-image-sql199.cjs');
const { invalid199, readCatalogImageAnchors199 } = require('./catalog-image-anchors199.cjs');
const {
  MAX_SIGNATURE_BYTES199,
  normalizeParents199,
  signatureCatalogImage199,
  assertCatalogImageSignature199,
  verifyCatalogImage199,
} = require('./catalog-image-schema199.cjs');

// Caller owns the outer transaction, maintenance evidence and COMMIT ACK.
// Only this component row/table and its enabled aliases change. No parent DDL changes.
async function prepareCatalogImage199(
  client,
  role,
  { marker, parents, offline = false, rollback = false } = {},
) {
  if (offline !== true || typeof rollback !== 'boolean') throw invalid199();
  if (!rollback && parents?.hotMetadata169?.eligibleMarker === false) throw invalid199();
  const authority = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (!authority || (!authority.rolsuper && !authority.rolbypassrls)) throw invalid199();
  const held = (
    await client.query('SELECT pg_try_advisory_xact_lock($1::bigint) held', [KEYS.maintenance])
  ).rows[0];
  if (
    !held?.held ||
    (
      await client.query(
        'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE expires_at>clock_timestamp() LIMIT 1',
      )
    ).rows.length
  ) {
    throw Object.assign(invalid199(), { code: 'POSTGRES_CATALOG_IMAGE_PREPARE_BUSY199' });
  }
  await client.query('SAVEPOINT ct_catalog_image199');
  try {
    if ((await readRevisionProfile(client, role)) !== 3) throw invalid199();
    for (const kind of ['platform', 'cabinet'])
      await validatePostgresSchema(client, { kind, applicationRole: role });
    const before = await verifyCatalogImage199(client, role, { marker, parents });
    let created = false;
    if (rollback) {
      if (before) {
        const drops = Object.keys(variants199)
          .filter((k) => before.variants[k])
          .map((k) => `DROP FUNCTION ${variants199[k].functionName}(${variants199[k].argTypes});`);
        await client.query(drops.join('\n') + ` DROP TABLE ${META};`);
      }
    } else if (!before) {
      const anchors = await readCatalogImageAnchors199(client),
        { enabled } = normalizeParents199(parents),
        app = identifier(role);
      await client.query(`CREATE TABLE ${META}(version bigint PRIMARY KEY CHECK(version=1),
        epoch uuid NOT NULL,signature jsonb NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'));
        ALTER TABLE ${META} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${META} FORCE ROW LEVEL SECURITY;
        REVOKE ALL ON ${META} FROM PUBLIC,${app}; GRANT SELECT ON ${META} TO ${app};
        CREATE POLICY read_catalog_image199 ON ${META} FOR SELECT TO ${app} USING(true);
        CREATE POLICY owner_catalog_image199 ON ${META} FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true);`);
      await client.query(createCatalogImageSQL199(role, anchors, enabled));
      const observed = await signatureCatalogImage199(client, role, { anchors, marker, parents });
      assertCatalogImageSignature199(observed, role);
      if (Buffer.byteLength(JSON.stringify(observed)) > MAX_SIGNATURE_BYTES199) throw invalid199();
      await client.query(`INSERT INTO ${META}(version,epoch,signature,digest) VALUES(1,$1,$2,$3)`, [
        randomUUID(),
        observed,
        digest(observed),
      ]);
      created = true;
    }
    const after = await verifyCatalogImage199(client, role, { marker, parents });
    if (rollback ? after !== null : !after) throw invalid199();
    await client.query('RELEASE SAVEPOINT ct_catalog_image199');
    return {
      prepared: !rollback,
      changed: rollback ? !!before : created,
      capability: 'catalog-image199',
      preparedStores: 0,
      clinicalRewrite: false,
      clinicalRowsChanged: 0,
      dataCopiesCreated: 0,
      keyFilesChanged: 0,
      ...(after || {}),
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ct_catalog_image199');
      await client.query('RELEASE SAVEPOINT ct_catalog_image199');
    } catch {
      error.outcomeUnknown = true;
    }
    throw error;
  }
}
module.exports = { prepareCatalogImage199 };
