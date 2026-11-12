const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createV2Backup, recoverUpgradeCopy, verifyV2Backup } = require('./service.cjs');
const { organizationContext } = require('./organization-policy.cjs');
const { mergeOrganization } = require('./organization-merge.cjs');
const {
  disjoint,
  dataInventory,
  inventoryFingerprint,
  componentFingerprint,
  quote,
  tables,
  columns,
} = require('./organization-inventory.cjs');
const { DatabaseSync } = require('node:sqlite');
const { atomicJson, syncDirectory } = require('./durable.cjs');
const { safeTree, plainFile, readKey } = require('./snapshot.cjs');
const { assertOrganizationsPreserved } = require('./organization-personal-calendar.cjs');
const { signDocument, readDocument } = require('./organization-signature.cjs');
const { digest } = require('./archive.cjs');
const { assertNoOrganizationSwitch, switchMarker } = require('./organization-guard.cjs');
const { checkCapacity, sourceBytes } = require('./capacity.cjs');
const assistantRows = require('../../modules/assistant/access/row-schema.cjs');

// This is an offline operator tool, never an HTTP endpoint or a global-admin clinical reader.
function assertOtherOrganizationsPreserved(before, candidate, org, root) {
  const inventory = dataInventory(before),
    after = new Map(dataInventory(candidate).map((entry) => [entry.name, entry.sha256]));
  for (const entry of inventory) {
    if (entry.name === 'platform/platform.sqlite' || entry.name.startsWith(root + '/')) continue;
    if (after.get(entry.name) !== entry.sha256) throw Error('Unrelated cabinet or key changed.');
  }
  const source = new DatabaseSync(path.join(before, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  const result = new DatabaseSync(path.join(candidate, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    for (const { name } of tables(source)) {
      const names = columns(source, name),
        list = names.map(quote).join(',');
      let where = '',
        args = [];
      if (assistantRows.tables.includes(name) || name === 'assistant_state_schema') {
        // Assistant permissions/debt remain CURRENT even for the restored tenant.
        // Do not permit this target's rows to escape the exact preservation check.
      } else if (names.includes('organization_id')) {
        where = ' WHERE organization_id IS NULL OR organization_id<>?';
        args = [org];
      } else if (name === 'organizations') {
        where = ' WHERE id<>?';
        args = [org];
      }
      // The only global addition is an audit row; every existing audit row is retained.
      const original = source
        .prepare(`SELECT ${list} FROM ${quote(name)}${where} ORDER BY ${list}`)
        .all(...args);
      const actual = result
        .prepare(`SELECT ${list} FROM ${quote(name)}${where} ORDER BY ${list}`)
        .all(...args);
      let expected = original;
      if (name === 'telegram_runtime') {
        const { organizationInterestPolicy } = require('./organization-runtime-policy.cjs');
        const belongsToOrganization = organizationInterestPolicy(source, org);
        const invalidated = new Set(
          original.filter((row) => belongsToOrganization(row.key)).map((row) => row.key),
        );
        const currentKeys = new Set(actual.map((row) => row.key));
        // Only deletion of this organization's known derived interest hints is allowed.
        // New keys, value changes and every unrelated/global key remain exact.
        expected = original.filter((row) => !invalidated.has(row.key) || currentKeys.has(row.key));
      }
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        throw Error('Unrelated platform data changed: ' + name);
    }
    for (const table of ['organizations', 'memberships', 'subscriptions', 'accounts']) {
      const list = columns(source, table).map(quote).join(',');
      const original = source.prepare(`SELECT ${list} FROM ${table} ORDER BY ${list}`).all();
      const actual = result.prepare(`SELECT ${list} FROM ${table} ORDER BY ${list}`).all();
      if (table === 'organizations')
        assertOrganizationsPreserved(
          original,
          actual,
          org,
          readKey(path.join(before, 'platform', 'platform.key')),
        );
      else if (JSON.stringify(original) !== JSON.stringify(actual))
        throw Error('Current identity, access or subscription changed.');
    }
  } finally {
    source.close();
    result.close();
  }
}
async function prepareOrganizationRestore({
  source,
  archive,
  keyFile,
  jobDirectory,
  organizationId,
}) {
  source = path.resolve(source);
  jobDirectory = path.resolve(jobDirectory);
  disjoint(source, jobDirectory);
  assertNoOrganizationSwitch(source);
  if (fs.existsSync(path.join(source, '.restore-in-progress')))
    throw Error('Source recovery is incomplete.');
  safeTree(path.dirname(path.resolve(archive)));
  plainFile(path.resolve(archive));
  if (fs.existsSync(jobDirectory)) throw Error('Restore job directory must not exist.');
  // No in-place overwrite, and no implicit default to runtime/production directories.
  fs.mkdirSync(jobDirectory, { mode: 0o700 });
  const candidate = path.join(jobDirectory, 'candidate'),
    historical = path.join(jobDirectory, 'historical');
  const id = crypto.randomUUID(),
    planFile = path.join(jobDirectory, 'plan.json');
  atomicJson(planFile, { format: 1, id, state: 'preparing' });
  try {
    checkCapacity({
      source,
      directory: jobDirectory,
      workDirectory: jobDirectory,
      reserveBytes: 128 * 1024 ** 2 + sourceBytes(source) * 4 + fs.statSync(archive).size * 4,
    });
    const before = await createV2Backup({
      source,
      directory: path.join(jobDirectory, 'archives'),
      keyFile,
    });
    await recoverUpgradeCopy(before.file, keyFile, candidate);
    fs.writeFileSync(path.join(candidate, '.restore-in-progress'), 'organization-recovery', {
      flag: 'wx',
      mode: 0o600,
    });
    await recoverUpgradeCopy(archive, keyFile, historical);
    fs.writeFileSync(path.join(historical, '.restore-in-progress'), 'historical-read-only', {
      flag: 'wx',
      mode: 0o600,
    });
    const context = organizationContext(candidate, historical, organizationId);
    const baseline = dataInventory(candidate),
      sourceFingerprint = inventoryFingerprint(baseline);
    fs.renameSync(path.join(candidate, context.root), path.join(jobDirectory, 'replaced-cabinet'));
    fs.cpSync(path.join(historical, context.root), path.join(candidate, context.root), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    mergeOrganization(candidate, historical, organizationId, context);
    // Compare against the untouched fresh snapshot, not the old historical platform.
    const reference = path.join(jobDirectory, 'reference');
    await recoverUpgradeCopy(before.file, keyFile, reference);
    fs.writeFileSync(path.join(reference, '.restore-in-progress'), 'reference-read-only', {
      flag: 'wx',
      mode: 0o600,
    });
    assertOtherOrganizationsPreserved(reference, candidate, organizationId, context.root);
    const after = await createV2Backup({
      source: candidate,
      directory: path.join(jobDirectory, 'archives'),
      keyFile,
    });
    const candidateFingerprint = inventoryFingerprint(dataInventory(candidate));
    const plan = {
      format: 1,
      id,
      state: 'prepared',
      source,
      organizationId,
      root: context.root,
      schema: context.version,
      sourceFingerprint,
      candidateFingerprint,
      beforeArchive: path.basename(before.file),
      afterArchive: path.basename(after.file),
      beforeDigest: await digest(before.file),
      afterDigest: await digest(after.file),
      components: ['platform', 'cabinet'].map((kind) => ({
        kind,
        before: componentFingerprint(
          path.join(reference, kind === 'platform' ? 'platform' : context.root),
          kind,
        ),
        after: componentFingerprint(
          path.join(candidate, kind === 'platform' ? 'platform' : context.root),
          kind,
        ),
      })),
      createdAt: new Date().toISOString(),
      notificationsPaused: true,
      accessPreserved: true,
      policy:
        'current-identity-access-and-bindings;historical-cabinet-schedule-and-booking;expired-reserves',
    };
    atomicJson(planFile, signDocument(plan, keyFile));
    syncDirectory(jobDirectory);
    return {
      id,
      state: plan.state,
      schema: plan.schema,
      notificationsPaused: true,
      accessPreserved: true,
    };
  } catch (error) {
    atomicJson(planFile, { format: 1, id, state: 'failed' });
    throw error; // Private staging is retained for investigation, never auto-activated.
  }
}
function readRestorePlan(jobDirectory, keyFile) {
  jobDirectory = path.resolve(jobDirectory);
  safeTree(jobDirectory);
  const filename = path.join(jobDirectory, 'plan.json');
  plainFile(filename);
  const plan = readDocument(filename, keyFile);
  if (
    plan.format !== 1 ||
    !/^[a-f0-9-]{36}$/.test(plan.id || '') ||
    plan.state !== 'prepared' ||
    ![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(plan.schema) ||
    !/^[a-f0-9]{64}$/.test(plan.sourceFingerprint || '') ||
    !/^[a-f0-9]{64}$/.test(plan.candidateFingerprint || '') ||
    plan.root !== 'tenants/' + plan.organizationId ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(plan.organizationId || '') ||
    !path.isAbsolute(plan.source || '')
  )
    throw Error('Invalid or incomplete restore plan.');
  if (
    !Array.isArray(plan.components) ||
    plan.components.length !== 2 ||
    plan.components[0].kind !== 'platform' ||
    plan.components[1].kind !== 'cabinet' ||
    plan.components.some(
      (item) =>
        !/^[a-f0-9]{64}$/.test(item.before || '') || !/^[a-f0-9]{64}$/.test(item.after || ''),
    )
  )
    throw Error('Invalid component restore plan.');
  for (const name of [plan.beforeArchive, plan.afterArchive])
    if (!/^cartoteca-v2-[A-Za-z0-9-]+\.enc$/.test(name || ''))
      throw Error('Unsafe restore archive name.');
  disjoint(plan.source, jobDirectory);
  return plan;
}
async function verifyOrganizationRestore({ jobDirectory, keyFile }) {
  const plan = readRestorePlan(jobDirectory, keyFile),
    candidate = path.join(jobDirectory, 'candidate');
  if (inventoryFingerprint(dataInventory(candidate)) !== plan.candidateFingerprint)
    throw Error('Prepared data changed.');
  for (const [name, expected] of [
    [plan.beforeArchive, plan.beforeDigest],
    [plan.afterArchive, plan.afterDigest],
  ]) {
    if ((await digest(path.join(jobDirectory, 'archives', name))) !== expected)
      throw Error('Restore archive changed.');
    await verifyV2Backup(path.join(jobDirectory, 'archives', name), keyFile, {
      workDirectory: jobDirectory,
    });
  }
  return {
    id: plan.id,
    state: plan.state,
    schema: plan.schema,
    notificationsPaused: true,
    accessPreserved: true,
  };
}
function organizationRestoreStatus({ jobDirectory, keyFile }) {
  const plan = readRestorePlan(jobDirectory, keyFile),
    marker = switchMarker(plan.source);
  const receipt = path.join(jobDirectory, 'switch.json');
  const file = fs.existsSync(marker) ? marker : fs.existsSync(receipt) ? receipt : null;
  const document = file ? readDocument(file, keyFile) : null;
  if (document && (document.id !== plan.id || document.source !== plan.source))
    throw Error('Restore status does not match this plan.');
  return {
    id: plan.id,
    state: fs.existsSync(marker) ? 'interrupted' : document?.phase || 'prepared',
  };
}
module.exports = {
  prepareOrganizationRestore,
  readRestorePlan,
  verifyOrganizationRestore,
  organizationRestoreStatus,
};
