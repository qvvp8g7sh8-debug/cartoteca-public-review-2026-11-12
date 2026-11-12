const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { operatorServerConnection } = require('./connection.cjs');
const { readRuntime } = require('./runtime.cjs');
const { validatePostgresSchema, verifyAssetProfile } = require('./catalog-postgres.cjs');
const { advisory } = require('./backup-snapshot.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const {
  capture,
  inspectStore,
  verifyInventory,
  photoIds,
  assetFingerprint,
  copyAssets,
} = require('./organization-datasets.cjs');
const { context } = require('./organization-policy.cjs');
const { buildCandidate } = require('./organization-merge.cjs');
const { signDocument, readDocument } = require('../backup/organization-signature.cjs');
const { assertNoOrganizationSwitch, switchMarker } = require('../backup/organization-guard.cjs');
const { disjoint } = require('../backup/organization-inventory.cjs');
const { plainFile, safeTree } = require('../backup/snapshot.cjs');
const { atomicJson, syncDirectory } = require('../backup/durable.cjs');
const { digest: fileDigest } = require('../backup/archive.cjs');
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
async function withFence(connection, callback) {
  const client = new Client(await operatorServerConnection(connection));
  await client.connect();
  let held = false;
  try {
    await client.query(
      "SET statement_timeout='30000'; SET lock_timeout='5000'; SET idle_in_transaction_session_timeout='120000'",
    );
    held =
      (
        await client.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [
          advisory('cartoteca:platform-write-fence:v1'),
        ])
      ).rows[0]?.held === true;
    if (!held) throw Error('Stop active writers or retry recovery preparation.');
    return await callback(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (held)
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [
          advisory('cartoteca:platform-write-fence:v1'),
        ]);
      } catch {}
    await client.end();
  }
}
function readRestorePlan(jobDirectory, keyFile) {
  jobDirectory = path.resolve(jobDirectory);
  safeTree(jobDirectory);
  const plan = readDocument(path.join(jobDirectory, 'plan.json'), keyFile);
  if (
    plan.format !== 2 ||
    plan.backend !== 'postgres' ||
    plan.state !== 'prepared' ||
    !uuid(plan.id) ||
    !uuid(plan.organizationId) ||
    !uuid(plan.platformStoreId) ||
    !uuid(plan.cabinetStoreId) ||
    !path.isAbsolute(plan.source || '') ||
    plan.root !== 'tenants/' + plan.organizationId ||
    ![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(plan.schema)
  )
    throw Error('Invalid PostgreSQL organization recovery plan.');
  for (const name of [
    'sourceFingerprint',
    'protectedFingerprint',
    'beforeFingerprint',
    'afterFingerprint',
    'beforeManifest',
    'afterManifest',
    'beforeAssets',
    'afterAssets',
    'profileHash',
    'platformKeyHash',
    'archiveDigest',
  ])
    if (!/^[a-f0-9]{64}$/.test(plan[name] || '')) throw Error('Invalid recovery proof.');
  disjoint(plan.source, jobDirectory);
  return plan;
}
async function verifyOrganizationRestore({ jobDirectory, keyFile }) {
  jobDirectory = path.resolve(jobDirectory);
  const plan = readRestorePlan(jobDirectory, keyFile);
  const before = path.join(jobDirectory, 'before'),
    candidate = path.join(jobDirectory, 'candidate');
  for (const [directory, expected] of [
    [before, plan.beforeManifest],
    [candidate, plan.afterManifest],
  ])
    if ((await fileDigest(path.join(directory, 'inventory.json'))) !== expected)
      throw Error('Prepared recovery manifest changed.');
  const old = await verifyInventory(before),
    next = await verifyInventory(candidate);
  if (
    digest({ database: old.target, assets: plan.beforeAssets }) !== plan.beforeFingerprint ||
    digest({ database: next.target, assets: plan.afterAssets }) !== plan.afterFingerprint
  )
    throw Error('Prepared recovery data changed.');
  const assets = path.join(jobDirectory, 'candidate-assets');
  if (
    !fs.existsSync(assets) ||
    (await assetFingerprint(assets, await photoIds(candidate, next.inventory.cabinet))) !==
      plan.afterAssets
  )
    throw Error('Prepared recovery photographs changed.');
  return {
    id: plan.id,
    state: 'prepared',
    backend: 'postgres',
    schema: plan.schema,
    notificationsPaused: true,
    accessPreserved: true,
  };
}
async function prepareOrganizationRestore({
  source,
  archive,
  keyFile,
  jobDirectory,
  organizationId,
  connection,
  applicationRole = 'cartoteca_app',
}) {
  source = path.resolve(source);
  archive = path.resolve(archive);
  jobDirectory = path.resolve(jobDirectory);
  if (!uuid(organizationId)) throw Error('Invalid organization identifier.');
  disjoint(source, jobDirectory);
  safeTree(source);
  assertNoOrganizationSwitch(source);
  plainFile(archive);
  if (fs.existsSync(path.join(source, '.restore-in-progress')) || fs.existsSync(jobDirectory))
    throw Error('Recovery source or job is unavailable.');
  const profile = readRuntime(source),
    mapping = profile.stores.find(
      (row) => row.kind === 'cabinet' && row.organizationId === organizationId,
    );
  const cabinetStoreId = mapping?.storeId || organizationId;
  fs.mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  atomicJson(path.join(jobDirectory, 'plan.json'), {
    format: 2,
    backend: 'postgres',
    id,
    state: 'preparing',
  });
  try {
    const result = await require('./backup-service.cjs').withVerifiedPostgresArchive(
      archive,
      keyFile,
      { workDirectory: jobDirectory },
      async ({ recovered, manifest }) => {
        if (
          manifest.profile.platformStoreId !== profile.platformStoreId ||
          manifest.profile.migrationId !== profile.migrationId
        )
          throw Error('Historical PostgreSQL backup has different data lineage.');
        const historicalPlatform = manifest.stores.find(
          (row) => row.kind === 'platform' && row.storeId === profile.platformStoreId,
        );
        const historicalCabinet = manifest.stores.find(
          (row) => row.kind === 'cabinet' && row.storeId === cabinetStoreId,
        );
        if (!historicalPlatform || !historicalCabinet)
          throw Error('Historical organization cabinet is missing.');
        return withFence(connection, async (client) => {
          safeTree(source);
          assertNoOrganizationSwitch(source);
          if (fs.existsSync(path.join(source, '.restore-in-progress')))
            throw Error('Recovery source is unavailable.');
          if (digest(readRuntime(source)) !== digest(profile))
            throw Error('PostgreSQL asset lineage changed before recovery preparation.');
          await verifyAssetProfile(client, profile);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
          for (const kind of ['platform', 'cabinet'])
            await validatePostgresSchema(client, { kind, applicationRole });
          const currentPlatform = await inspectStore(client, 'platform', profile.platformStoreId),
            currentCabinet = await inspectStore(client, 'cabinet', cabinetStoreId);
          const before = path.join(jobDirectory, 'before'),
            candidate = path.join(jobDirectory, 'candidate');
          const baseline = await capture(client, {
            platform: currentPlatform,
            cabinet: currentCabinet,
            organizationId,
            directory: before,
            jobId: id,
          });
          const currentAssets = path.join(source, 'tenants', organizationId),
            beforeAssets = await assetFingerprint(
              currentAssets,
              await photoIds(before, baseline.inventory.cabinet),
            );
          const policy = await context({
            source,
            recovered,
            before,
            historical: recovered,
            currentPlatform: baseline.inventory.platform,
            currentCabinet: baseline.inventory.cabinet,
            historicalPlatform,
            historicalCabinet,
            organizationId,
            client,
          });
          const built = await buildCandidate({
            before,
            historical: recovered,
            directory: candidate,
            currentPlatform: baseline.inventory.platform,
            currentCabinet: baseline.inventory.cabinet,
            historicalPlatform,
            historicalCabinet,
            organizationId,
            context: policy,
          });
          const ids = await photoIds(candidate, built.cabinet),
            assetStage = path.join(jobDirectory, 'candidate-assets');
          await copyAssets(path.join(recovered, 'tenants', organizationId), assetStage, ids);
          const afterAssets = await assetFingerprint(assetStage, ids),
            candidateProof = await verifyInventory(candidate);
          if (digest(readRuntime(source)) !== digest(profile))
            throw Error('PostgreSQL asset lineage changed during recovery preparation.');
          await client.query('ROLLBACK');
          return {
            format: 2,
            backend: 'postgres',
            id,
            state: 'prepared',
            source,
            organizationId,
            root: 'tenants/' + organizationId,
            platformStoreId: profile.platformStoreId,
            cabinetStoreId,
            schema: profile.notificationSchema,
            profileHash: digest(profile),
            platformKeyHash: await fileDigest(path.join(source, 'platform/platform.key')),
            sourceFingerprint: digest({
              database: baseline.full,
              assets: beforeAssets,
              profile: digest(profile),
            }),
            protectedFingerprint: baseline.protected,
            beforeFingerprint: digest({ database: baseline.target, assets: beforeAssets }),
            afterFingerprint: digest({ database: candidateProof.target, assets: afterAssets }),
            beforeManifest: await fileDigest(path.join(before, 'inventory.json')),
            afterManifest: await fileDigest(path.join(candidate, 'inventory.json')),
            beforeAssets,
            afterAssets,
            archiveDigest: await fileDigest(archive),
            createdAt: new Date().toISOString(),
            notificationsPaused: true,
            accessPreserved: true,
          };
        });
      },
    );
    atomicJson(path.join(jobDirectory, 'plan.json'), signDocument(result, keyFile));
    syncDirectory(jobDirectory);
    await verifyOrganizationRestore({ jobDirectory, keyFile });
    return {
      id,
      state: 'prepared',
      backend: 'postgres',
      schema: result.schema,
      notificationsPaused: true,
      accessPreserved: true,
    };
  } catch (error) {
    atomicJson(path.join(jobDirectory, 'plan.json'), {
      format: 2,
      backend: 'postgres',
      id,
      state: 'failed',
    });
    throw error;
  }
}
function organizationRestoreStatus({ jobDirectory, keyFile }) {
  jobDirectory = path.resolve(jobDirectory);
  const plan = readRestorePlan(jobDirectory, keyFile),
    marker = switchMarker(plan.source),
    receipt = path.join(jobDirectory, 'switch.json');
  const status = fs.existsSync(marker)
    ? readDocument(marker, keyFile)
    : fs.existsSync(receipt)
      ? readDocument(receipt, keyFile)
      : null;
  if (status && (status.id !== plan.id || status.source !== plan.source))
    throw Error('Recovery status belongs to another plan.');
  return {
    id: plan.id,
    backend: 'postgres',
    state: fs.existsSync(marker) ? 'interrupted' : status?.phase || 'prepared',
  };
}
module.exports = {
  withFence,
  prepareOrganizationRestore,
  verifyOrganizationRestore,
  readRestorePlan,
  organizationRestoreStatus,
};
