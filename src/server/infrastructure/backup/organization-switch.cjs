const fs = require('node:fs');
const path = require('node:path');
const { readRestorePlan, verifyOrganizationRestore } = require('./organization-restore.cjs');
const {
  dataInventory,
  inventoryFingerprint,
  componentFingerprint,
  disjoint,
  flushTree,
} = require('./organization-inventory.cjs');
const { switchMarker } = require('./organization-guard.cjs');
const { signDocument, readDocument } = require('./organization-signature.cjs');
const { safeTree, plainFile } = require('./snapshot.cjs');
const { atomicJson, syncFile, syncDirectory } = require('./durable.cjs');

function parameters({ source, jobDirectory, keyFile, confirmation, stopped }) {
  if (stopped !== true)
    throw Error('Stop ALL application/bot/backup writers before offline switching.');
  source = path.resolve(source);
  jobDirectory = path.resolve(jobDirectory);
  const plan = readRestorePlan(jobDirectory, keyFile);
  if (source !== plan.source || confirmation !== plan.id)
    throw Error('Explicit source and plan confirmation are required.');
  if (source === path.parse(source).root || path.dirname(source) === path.parse(source).root)
    throw Error('Broad filesystem roots cannot be switched.');
  for (const name of ['.git', 'AGENTS.md', 'package.json'])
    if (fs.existsSync(path.join(source, name)))
      throw Error('A project/workspace root cannot be switched.');
  const previous = source + '.before-restore-' + plan.id;
  disjoint(source, jobDirectory, previous);
  const components = plan.components.map((item) => ({
    ...item,
    current: path.join(source, item.kind === 'platform' ? 'platform' : plan.root),
    previous: path.join(previous, item.kind),
    install:
      item.kind === 'platform'
        ? path.join(jobDirectory, 'platform-install')
        : path.join(jobDirectory, 'candidate', plan.root),
  }));
  return {
    source,
    jobDirectory,
    keyFile,
    plan,
    previous,
    components,
    marker: switchMarker(source),
    receipt: path.join(jobDirectory, 'switch.json'),
  };
}
function journal(p, phase) {
  return signDocument(
    {
      format: 1,
      id: p.plan.id,
      source: p.source,
      jobDirectory: p.jobDirectory,
      previous: p.previous,
      phase,
    },
    p.keyFile,
  );
}
function validateJournal(p, file) {
  const value = readDocument(file, p.keyFile);
  for (const [name, expected] of Object.entries({
    format: 1,
    id: p.plan.id,
    source: p.source,
    jobDirectory: p.jobDirectory,
    previous: p.previous,
  }))
    if (value[name] !== expected) throw Error('Switch journal does not match the restore job.');
  return value;
}
function record(p, phase) {
  atomicJson(p.marker, journal(p, phase));
}
function gate(p, phase) {
  fs.writeFileSync(p.marker, JSON.stringify(journal(p, phase)), { flag: 'wx', mode: 0o600 });
  syncFile(p.marker);
  syncDirectory(path.dirname(p.marker));
}
function rename(from, to) {
  safeTree(from);
  safeTree(path.dirname(to));
  if (fs.existsSync(to)) throw Error('Switch destination already exists.');
  fs.renameSync(from, to);
  syncDirectory(path.dirname(from));
  syncDirectory(path.dirname(to));
}
function finish(p, phase) {
  atomicJson(p.receipt, journal(p, phase));
  fs.unlinkSync(p.marker);
  syncDirectory(path.dirname(p.marker));
}
function preparePlatformInstall(p) {
  const component = p.components[0];
  if (fs.existsSync(component.install)) throw Error('Platform install staging already exists.');
  // Preserve migration receipts/snapshots and other platform files not covered by the archive.
  // Other tenant directories and their orphan/inactive photos are NEVER moved or copied here.
  fs.cpSync(component.current, component.install, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = path.join(component.install, 'platform.sqlite' + suffix);
    if (fs.existsSync(sidecar)) {
      plainFile(sidecar);
      fs.unlinkSync(sidecar);
    }
  }
  const database = path.join(component.install, 'platform.sqlite');
  plainFile(database);
  fs.copyFileSync(path.join(p.jobDirectory, 'candidate', 'platform', 'platform.sqlite'), database);
  syncFile(database);
  syncDirectory(component.install);
  if (componentFingerprint(component.install, 'platform') !== component.after)
    throw Error('Platform install staging does not match the prepared snapshot.');
}
async function applyOrganizationRestore(options) {
  const p = parameters(options);
  if (fs.existsSync(p.marker) || fs.existsSync(p.previous) || fs.existsSync(p.receipt))
    throw Error('An existing switch must be recovered, not repeated.');
  await verifyOrganizationRestore(p);
  if (inventoryFingerprint(dataInventory(p.source)) !== p.plan.sourceFingerprint)
    throw Error('Source changed since preparation; prepare a fresh recovery job.');
  if (fs.statSync(p.source).dev !== fs.statSync(p.jobDirectory).dev)
    throw Error('Offline switch requires one filesystem.');
  preparePlatformInstall(p);
  p.components.forEach((component) => flushTree(component.install));
  gate(p, 'intent');
  fs.mkdirSync(p.previous, { mode: 0o700 });
  syncDirectory(path.dirname(p.previous));
  for (const component of p.components) {
    if (componentFingerprint(component.current, component.kind) !== component.before)
      throw Error('Source component changed before switching.');
    rename(component.current, component.previous);
    record(p, component.kind + '-saved');
    rename(component.install, component.current);
    record(p, component.kind + '-installed');
  }
  if (inventoryFingerprint(dataInventory(p.source)) !== p.plan.candidateFingerprint)
    throw Error('Installed recovery does not match the prepared data.');
  finish(p, 'activated');
  return { id: p.plan.id, state: 'activated', notificationsPaused: true, previousRetained: true };
}
function rollbackOrganizationRestore(options) {
  const p = parameters(options),
    interrupted = fs.existsSync(p.marker);
  if (interrupted) validateJournal(p, p.marker);
  else if (!fs.existsSync(p.receipt) || validateJournal(p, p.receipt).phase !== 'activated')
    throw Error('No matching activated restore to roll back.');
  // Validate ALL pieces before changing any. Refuse loss of writes after activation.
  for (const component of p.components) {
    const previousExists = fs.existsSync(component.previous),
      currentExists = fs.existsSync(component.current);
    if (
      previousExists &&
      componentFingerprint(component.previous, component.kind) !== component.before
    )
      throw Error('Retained source component changed.');
    if (currentExists) {
      const actual = componentFingerprint(component.current, component.kind);
      if (actual !== (previousExists ? component.after : component.before))
        throw Error('New data exists after restoration; rollback would lose it.');
    } else if (!previousExists) throw Error('Both current and previous component are missing.');
    if (previousExists && currentExists && fs.existsSync(component.install))
      throw Error('Recovery staging is occupied; do not overwrite it.');
  }
  if (!interrupted) gate(p, 'rollback-intent');
  for (const component of [...p.components].reverse()) {
    if (!fs.existsSync(component.previous)) continue;
    if (fs.existsSync(component.current)) {
      rename(component.current, component.install);
      record(p, component.kind + '-parked');
    }
    rename(component.previous, component.current);
    record(p, component.kind + '-returned');
  }
  // Untouched organizations may have new cabinet-only data; it must not be rolled back.
  for (const component of p.components)
    if (componentFingerprint(component.current, component.kind) !== component.before)
      throw Error('Original component was not recovered.');
  finish(p, 'rolled-back');
  return { id: p.plan.id, state: 'rolled-back', restoredCandidateRetained: true };
}
module.exports = { applyOrganizationRestore, rollbackOrganizationRestore };
