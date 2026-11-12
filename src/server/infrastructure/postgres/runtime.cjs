const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const markerName = 'postgresql-runtime.json';
const ownerProfiles = new WeakMap();
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function readRuntime(root) {
  const filename = path.join(root, markerName),
    info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
    throw Error('Invalid PostgreSQL asset marker.');
  return validateRuntimeProfile(JSON.parse(fs.readFileSync(filename, 'utf8')));
}
function validateRuntimeProfile(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    value.backend !== 'postgres' ||
    !uuid(value.migrationId) ||
    !uuid(value.platformStoreId) ||
    !uuid(value.rootCabinetStoreId) ||
    !value.cabinetTemplates ||
    Object.keys(value.cabinetTemplates).length !== 2 ||
    !['1', '2'].every((version) => /^[a-f0-9]{64}$/.test(value.cabinetTemplates[version] || '')) ||
    !(value.budgetStoreId === null || uuid(value.budgetStoreId)) ||
    ![11, 12, 13, 14, 15, 16, 17, 18, 19, 20].includes(value.notificationSchema) ||
    ![0, 1, 2].includes(value.cabinetSchema) ||
    !Array.isArray(value.stores) ||
    value.stores.length > 100000
  )
    throw Error('Invalid PostgreSQL asset marker.');
  const paths = new Set(),
    ids = new Set();
  for (const row of value.stores) {
    if (
      !uuid(row.storeId) ||
      ids.has(row.storeId) ||
      paths.has(row.relativeDirectory) ||
      !['platform', 'cabinet', 'budget'].includes(row.kind) ||
      !(row.organizationId === null || uuid(row.organizationId)) ||
      !Number.isSafeInteger(row.schemaVersion) ||
      !(
        /^(?:\.|platform|tenants\/[a-f0-9-]{36})$/i.test(row.relativeDirectory) ||
        (row.kind === 'budget' && row.relativeDirectory === 'platform/booking-read-budget')
      )
    )
      throw Error('Invalid PostgreSQL store mapping.');
    ids.add(row.storeId);
    paths.add(row.relativeDirectory);
  }
  const platform = value.stores.find((row) => row.kind === 'platform');
  const rootCabinet = value.stores.find(
    (row) => row.kind === 'cabinet' && row.relativeDirectory === '.',
  );
  const budget = value.stores.find((row) => row.kind === 'budget');
  if (
    !platform ||
    platform.storeId !== value.platformStoreId ||
    platform.relativeDirectory !== 'platform' ||
    platform.schemaVersion !== value.notificationSchema ||
    !rootCabinet ||
    rootCabinet.storeId !== value.rootCabinetStoreId ||
    (budget?.storeId || null) !== value.budgetStoreId ||
    value.stores.some((row) =>
      row.kind === 'platform'
        ? row.relativeDirectory !== 'platform' || row.organizationId !== null
        : row.kind === 'budget'
          ? row.relativeDirectory !== 'platform/booking-read-budget' ||
            row.schemaVersion !== 1 ||
            row.organizationId !== null
          : ![0, 1, 2].includes(row.schemaVersion) ||
            (row.relativeDirectory !== '.' &&
              row.relativeDirectory !== 'tenants/' + row.organizationId),
    )
  )
    throw Error('Inconsistent PostgreSQL asset lineage.');
  return value;
}
function ownerProfile(owner, root) {
  root = path.resolve(root);
  const info = fs.lstatSync(path.join(root, markerName), { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid PostgreSQL asset marker.');
  const stamp = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  let entry = ownerProfiles.get(owner);
  if (entry) {
    if (entry.root !== root || entry.stamp !== stamp)
      throw Error('PostgreSQL assets changed while their executor was active.');
    return entry;
  }
  const profile = readRuntime(root);
  const markerHash = require('./catalog-sqlite.cjs').digest(profile);
  owner.verifyProfile({
    platformStoreId: profile.platformStoreId,
    migrationId: profile.migrationId,
    markerHash,
    lineage: profile,
  });
  entry = {
    root,
    stamp,
    profile,
    index: new Map(profile.stores.map((row) => [row.kind + ':' + row.relativeDirectory, row])),
  };
  ownerProfiles.set(owner, entry);
  return entry;
}
function openRuntimeStore(
  owner,
  root,
  directory,
  kind,
  { organizationId, schemaVersion = 0, allowCreate: permitCreate = true } = {},
) {
  if (owner?.dialect !== 'postgres') throw Error('PostgreSQL execution owner required.');
  const entry = ownerProfile(owner, root),
    marker = entry.profile,
    relative =
      path.relative(path.resolve(root), path.resolve(directory)).split(path.sep).join('/') || '.';
  const known = entry.index.get(kind + ':' + relative);
  let storeId = known?.storeId,
    allowCreate = false;
  if (
    !known &&
    kind === 'cabinet' &&
    uuid(organizationId) &&
    relative === 'tenants/' + organizationId
  ) {
    storeId = organizationId;
    allowCreate = permitCreate;
  }
  if (!storeId) throw Error('PostgreSQL store is not registered in the offline asset lineage.');
  if (
    known?.organizationId &&
    known.organizationId !== organizationId &&
    !(kind === 'cabinet' && relative === '.' && organizationId == null)
  )
    throw Error('PostgreSQL cabinet scope mismatch.');
  const db = owner.open({
    kind,
    storeId,
    organizationId: organizationId || known?.organizationId || null,
    schemaVersion: schemaVersion || known?.schemaVersion || marker.cabinetSchema,
    allowCreate,
    ...(allowCreate
      ? { catalogHash: marker.cabinetTemplates[String(schemaVersion || marker.cabinetSchema || 1)] }
      : {}),
    platformStoreId: marker.platformStoreId,
  });
  if (db?.dialect !== 'postgres')
    throw Error('PostgreSQL store unavailable; SQLite fallback is forbidden.');
  const expectedVersion = schemaVersion || known?.schemaVersion || marker.cabinetSchema || 1;
  if (db.catalog?.version !== expectedVersion) {
    db.close();
    throw Error('PostgreSQL store schema differs from its asset lineage.');
  }
  return db;
}
function storeKey(directory, name, db) {
  const filename = path.join(directory, name);
  if (!fs.existsSync(filename)) {
    if (!db.newStore)
      throw Error('PostgreSQL encryption key missing; restore the complete assets.');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 32 || info.nlink !== 1)
    throw Error('Invalid PostgreSQL encryption key asset.');
  return fs.readFileSync(filename);
}
function rejectSqliteOnPostgresAssets(directory) {
  let current = path.resolve(directory);
  for (;;) {
    if (fs.existsSync(path.join(current, markerName)))
      throw Error('PostgreSQL assets cannot be opened with the SQLite backend.');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
module.exports = {
  markerName,
  readRuntime,
  validateRuntimeProfile,
  openRuntimeStore,
  storeKey,
  rejectSqliteOnPostgresAssets,
};
