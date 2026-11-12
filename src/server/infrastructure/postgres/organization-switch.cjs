const fs = require('node:fs');
const path = require('node:path');
const {
  withFence,
  readRestorePlan,
  verifyOrganizationRestore,
} = require('./organization-restore.cjs');
const {
  capture,
  inspectStore,
  verifyInventory,
  photoIds,
  assetFingerprint,
  replaceRows,
} = require('./organization-datasets.cjs');
const { tablePolicy, rows } = require('./organization-policy.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const { validatePostgresSchema, verifyAssetProfile } = require('./catalog-postgres.cjs');
const { readRuntime } = require('./runtime.cjs');
const { signDocument, readDocument } = require('../backup/organization-signature.cjs');
const { switchMarker } = require('../backup/organization-guard.cjs');
const { plainFile, safeTree } = require('../backup/snapshot.cjs');
const { atomicJson, syncFile, syncDirectory } = require('../backup/durable.cjs');
const { digest: fileDigest } = require('../backup/archive.cjs');
async function parameters(options) {
  if (options.stopped !== true)
    throw Error(
      'Stop ALL application, notification, backup and asset writers before selective recovery.',
    );
  const jobDirectory = path.resolve(options.jobDirectory),
    plan = readRestorePlan(jobDirectory, options.keyFile);
  safeTree(plan.source);
  if (path.resolve(options.source) !== plan.source || options.confirmation !== plan.id)
    throw Error('Explicit source and exact plan confirmation are required.');
  if (fs.statSync(plan.source).dev !== fs.statSync(jobDirectory).dev)
    throw Error('Recovery assets must remain on one filesystem.');
  if (
    digest(readRuntime(plan.source)) !== plan.profileHash ||
    (await fileDigest(path.join(plan.source, 'platform/platform.key'))) !== plan.platformKeyHash
  )
    throw Error('Recovery source lineage or platform key changed.');
  const before = path.join(jobDirectory, 'before'),
    candidate = path.join(jobDirectory, 'candidate');
  if (
    (await fileDigest(path.join(before, 'inventory.json'))) !== plan.beforeManifest ||
    (await fileDigest(path.join(candidate, 'inventory.json'))) !== plan.afterManifest
  )
    throw Error('Recovery inventory changed.');
  const old = await verifyInventory(before),
    next = await verifyInventory(candidate);
  if (
    digest({ database: old.target, assets: plan.beforeAssets }) !== plan.beforeFingerprint ||
    digest({ database: next.target, assets: plan.afterAssets }) !== plan.afterFingerprint
  )
    throw Error('Recovery rows changed.');
  return {
    options,
    plan,
    jobDirectory,
    before,
    candidate,
    old: old.inventory,
    next: next.inventory,
    oldIds: await photoIds(before, old.inventory.cabinet),
    nextIds: await photoIds(candidate, next.inventory.cabinet),
    current: path.join(plan.source, plan.root),
    previous: path.join(jobDirectory, 'previous-assets'),
    install: path.join(jobDirectory, 'candidate-assets'),
    parked: path.join(jobDirectory, 'after-assets'),
    marker: switchMarker(plan.source),
    receipt: path.join(jobDirectory, 'switch.json'),
  };
}
function journal(p, phase, action) {
  return signDocument(
    {
      format: 2,
      backend: 'postgres',
      id: p.plan.id,
      source: p.plan.source,
      jobDirectory: p.jobDirectory,
      phase,
      action,
    },
    p.options.keyFile,
  );
}
function validateJournal(p, file) {
  const value = readDocument(file, p.options.keyFile);
  if (
    value.format !== 2 ||
    value.backend !== 'postgres' ||
    value.id !== p.plan.id ||
    value.source !== p.plan.source ||
    value.jobDirectory !== p.jobDirectory
  )
    throw Error('Recovery journal does not match this plan.');
  return value;
}
function record(p, phase, action) {
  atomicJson(p.marker, journal(p, phase, action));
}
function gate(p, action) {
  fs.writeFileSync(p.marker, JSON.stringify(journal(p, 'intent', action)), {
    flag: 'wx',
    mode: 0o600,
  });
  syncFile(p.marker);
  syncDirectory(path.dirname(p.marker));
}
function finish(p, phase, action) {
  atomicJson(p.receipt, journal(p, phase, action));
  fs.unlinkSync(p.marker);
  syncDirectory(path.dirname(p.marker));
}
function rename(from, to) {
  safeTree(from);
  safeTree(path.dirname(to));
  if (fs.existsSync(to)) throw Error('Recovery asset destination exists.');
  fs.renameSync(from, to);
  syncDirectory(path.dirname(from));
  syncDirectory(path.dirname(to));
}
async function proof(client, p, expected) {
  const platform = await inspectStore(client, 'platform', p.plan.platformStoreId),
    cabinet = await inspectStore(client, 'cabinet', p.plan.cabinetStoreId);
  if (
    digest(platform.metadata) !== digest(p.old.platform.metadata) ||
    digest(cabinet.metadata) !== digest(p.old.cabinet.metadata)
  )
    throw Error('Prepared PostgreSQL catalog changed.');
  const state = await capture(client, {
    platform,
    cabinet,
    organizationId: p.plan.organizationId,
    jobId: p.plan.id,
  });
  if (state.protected !== p.plan.protectedFingerprint)
    throw Error('Current identities, permissions, money or unrelated organization data changed.');
  const assetHash = expected === 'before' ? p.plan.beforeAssets : p.plan.afterAssets;
  if (
    digest({ database: state.target, assets: assetHash }) !==
    (expected === 'before' ? p.plan.beforeFingerprint : p.plan.afterFingerprint)
  )
    throw Error('New target data exists or the recovery rows differ.');
  return state;
}
async function receipt(client, p) {
  const value = (
    await client.query('SELECT * FROM cartoteca_catalog.restore_jobs WHERE id=$1', [p.plan.id])
  ).rows[0];
  if (
    value &&
    (value.platform_store_id !== p.plan.platformStoreId ||
      value.organization_id !== p.plan.organizationId ||
      value.before_fingerprint !== p.plan.beforeFingerprint ||
      value.after_fingerprint !== p.plan.afterFingerprint ||
      !['committed', 'rolled-back'].includes(value.phase))
  )
    throw Error('Native recovery receipt does not match its signed plan.');
  return value;
}
async function applyRows(client, p, which) {
  const inventory = which === 'before' ? p.old : p.next,
    directory = which === 'before' ? p.before : p.candidate,
    policy = tablePolicy(inventory.platform.metadata);
  await replaceRows(client, {
    directory,
    store: inventory.platform,
    organizationId: p.plan.organizationId,
    policy,
  });
  // Only exact derived keys identified against the original source may change.
  const keys = new Set();
  for (const base of [p.before, p.candidate])
    for await (const row of rows(
      base,
      base === p.before ? p.old.platform : p.next.platform,
      'telegram_runtime',
    ))
      keys.add(row.key);
  for (const key of keys)
    await client.query(
      'DELETE FROM cartoteca_platform.telegram_runtime WHERE _store_id=$1 AND key=$2',
      [p.plan.platformStoreId, key],
    );
  for await (const row of rows(directory, inventory.platform, 'telegram_runtime'))
    await client.query(
      'INSERT INTO cartoteca_platform.telegram_runtime(_store_id,key,value) VALUES($1,$2,$3)',
      [p.plan.platformStoreId, row.key, row.value],
    );
  await replaceRows(client, {
    directory,
    store: inventory.cabinet,
    organizationId: p.plan.organizationId,
    policy,
    whole: true,
  });
  await client.query(
    "SELECT set_config('cartoteca.kind','platform',true),set_config('cartoteca.store_id',$1,true)",
    [p.plan.platformStoreId],
  );
  await client.query(
    'INSERT INTO cartoteca_platform.platform_audit(_store_id,time,actor_id,organization_id,event,detail) VALUES($1,$2,NULL,$3,$4,$5)',
    [
      p.plan.platformStoreId,
      Date.now(),
      p.plan.organizationId,
      which === 'before'
        ? 'organization_backup_rollback_postgres'
        : 'organization_backup_restored_postgres',
      JSON.stringify({
        format: 2,
        jobId: p.plan.id,
        notificationsPaused: true,
        accessPreserved: true,
      }),
    ],
  );
  await client.query(
    "UPDATE cartoteca_catalog.stores SET revision=revision+1 WHERE (kind='platform' AND store_id=$1) OR (kind='cabinet' AND store_id=$2)",
    [p.plan.platformStoreId, p.plan.cabinetStoreId],
  );
}
async function validateNative(client, p) {
  safeTree(p.plan.source);
  if (
    digest(readRuntime(p.plan.source)) !== p.plan.profileHash ||
    (await fileDigest(path.join(p.plan.source, 'platform/platform.key'))) !==
      p.plan.platformKeyHash ||
    fs.existsSync(path.join(p.plan.source, '.restore-in-progress'))
  )
    throw Error('Recovery source lineage, key or whole recovery state changed.');
  await verifyAssetProfile(client, readRuntime(p.plan.source));
  for (const kind of ['platform', 'cabinet'])
    await validatePostgresSchema(client, {
      kind,
      applicationRole: p.options.applicationRole || 'cartoteca_app',
    });
}
async function applyOrganizationRestore(options) {
  const p = await parameters(options);
  await verifyOrganizationRestore(options);
  if (fs.existsSync(p.marker) || fs.existsSync(p.previous) || fs.existsSync(p.parked))
    throw Error('An interrupted or activated recovery must be recovered or rolled back first.');
  if (fs.existsSync(p.receipt) && validateJournal(p, p.receipt).phase !== 'prepared')
    throw Error('Recovery job was already activated.');
  return withFence(options.connection, async (client) => {
    await validateNative(client, p);
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    if (await receipt(client, p)) throw Error('Recovery transaction was already committed.');
    const current = await proof(client, p, 'before');
    const assets = await assetFingerprint(p.current, p.oldIds);
    if (
      assets !== p.plan.beforeAssets ||
      digest({ database: current.full, assets, profile: p.plan.profileHash }) !==
        p.plan.sourceFingerprint
    )
      throw Error('Source changed since preparation.');
    gate(p, 'apply');
    await applyRows(client, p, 'after');
    await proof(client, p, 'after');
    record(p, 'rows-prepared', 'apply');
    rename(p.current, p.previous);
    record(p, 'before-assets-retained', 'apply');
    rename(p.install, p.current);
    record(p, 'after-assets-installed', 'apply');
    if ((await assetFingerprint(p.current, p.nextIds)) !== p.plan.afterAssets)
      throw Error('Installed recovery assets changed.');
    await client.query(
      "INSERT INTO cartoteca_catalog.restore_jobs(id,platform_store_id,organization_id,before_fingerprint,after_fingerprint,phase,created_at) VALUES($1,$2,$3,$4,$5,'committed',$6)",
      [
        p.plan.id,
        p.plan.platformStoreId,
        p.plan.organizationId,
        p.plan.beforeFingerprint,
        p.plan.afterFingerprint,
        Date.now(),
      ],
    );
    await client.query('COMMIT');
    record(p, 'database-committed', 'apply');
    finish(p, 'activated', 'apply');
    return {
      id: p.plan.id,
      state: 'activated',
      backend: 'postgres',
      notificationsPaused: true,
      accessPreserved: true,
      previousRetained: true,
    };
  });
}
async function assetMatches(directory, ids, expected) {
  if (!fs.existsSync(directory)) return false;
  try {
    return (await assetFingerprint(directory, ids)) === expected;
  } catch {
    return false;
  }
}
async function reconcileAssets(p, wanted) {
  const ids = wanted === 'before' ? p.oldIds : p.nextIds,
    expected = wanted === 'before' ? p.plan.beforeAssets : p.plan.afterAssets;
  if (await assetMatches(p.current, ids, expected)) return;
  const choices = wanted === 'before' ? [p.previous] : [p.parked, p.install];
  let selected;
  for (const directory of choices)
    if (await assetMatches(directory, ids, expected)) {
      selected = directory;
      break;
    }
  if (!selected) throw Error('Known recovery assets are missing or changed.');
  if (fs.existsSync(p.current)) {
    const otherIds = wanted === 'before' ? p.nextIds : p.oldIds,
      other = wanted === 'before' ? p.plan.afterAssets : p.plan.beforeAssets;
    if (!(await assetMatches(p.current, otherIds, other)))
      throw Error('Current recovery assets are not recognized.');
    const park = wanted === 'after' ? p.previous : !fs.existsSync(p.install) ? p.install : p.parked;
    rename(p.current, park);
  }
  rename(selected, p.current);
  if (!(await assetMatches(p.current, ids, expected)))
    throw Error('Recovery asset reconciliation failed.');
}
async function recoverOrganizationRestore(options) {
  const p = await parameters(options);
  if (!fs.existsSync(p.marker))
    return {
      id: p.plan.id,
      state: fs.existsSync(p.receipt) ? validateJournal(p, p.receipt).phase : 'prepared',
      backend: 'postgres',
    };
  const interrupted = validateJournal(p, p.marker);
  return withFence(options.connection, async (client) => {
    await validateNative(client, p);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
    const committed = await receipt(client, p),
      wanted = committed?.phase === 'committed' ? 'after' : 'before';
    await proof(client, p, wanted);
    await reconcileAssets(p, wanted);
    await client.query('ROLLBACK');
    const state =
      wanted === 'after'
        ? 'activated'
        : committed?.phase === 'rolled-back'
          ? 'rolled-back'
          : 'prepared';
    finish(p, state, interrupted.action || 'recover');
    return { id: p.plan.id, state, backend: 'postgres', commitKnown: true, accessPreserved: true };
  });
}
async function rollbackOrganizationRestore(options) {
  let p = await parameters(options);
  if (fs.existsSync(p.marker)) {
    await recoverOrganizationRestore(options);
    p = await parameters(options);
  }
  if (!fs.existsSync(p.receipt) || validateJournal(p, p.receipt).phase !== 'activated')
    throw Error('No matching activated restore can be rolled back.');
  return withFence(options.connection, async (client) => {
    await validateNative(client, p);
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    if ((await receipt(client, p))?.phase !== 'committed')
      throw Error('No matching committed database recovery.');
    await proof(client, p, 'after');
    if (
      !(await assetMatches(p.current, p.nextIds, p.plan.afterAssets)) ||
      !(await assetMatches(p.previous, p.oldIds, p.plan.beforeAssets))
    )
      throw Error('Retained recovery assets changed.');
    if (fs.existsSync(p.parked) || fs.existsSync(p.marker))
      throw Error('Recovery staging is occupied.');
    gate(p, 'rollback');
    await applyRows(client, p, 'before');
    await proof(client, p, 'before');
    record(p, 'rollback-rows-prepared', 'rollback');
    rename(p.current, p.parked);
    record(p, 'after-assets-parked', 'rollback');
    rename(p.previous, p.current);
    record(p, 'before-assets-installed', 'rollback');
    await client.query(
      "UPDATE cartoteca_catalog.restore_jobs SET phase='rolled-back' WHERE id=$1 AND phase='committed'",
      [p.plan.id],
    );
    await client.query('COMMIT');
    record(p, 'rollback-database-committed', 'rollback');
    finish(p, 'rolled-back', 'rollback');
    return {
      id: p.plan.id,
      state: 'rolled-back',
      backend: 'postgres',
      restoredCandidateRetained: true,
      accessPreserved: true,
    };
  });
}
module.exports = {
  applyOrganizationRestore,
  recoverOrganizationRestore,
  rollbackOrganizationRestore,
};
