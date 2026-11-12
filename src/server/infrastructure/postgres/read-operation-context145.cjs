const path = require('node:path');
const crypto = require('node:crypto');
const { createNativeQueryPlatform } = require('../native-query-platform.cjs');
const { createReadCacheBudget } = require('../read-cache-budget.cjs');
const scopeIndices = new WeakMap();
function operationScope(marker, org) {
  let index = scopeIndices.get(marker);
  if (!index) {
    index = new Map();
    for (const row of marker.stores)
      if (row.kind === 'cabinet' && row.organizationId)
        index.set(row.organizationId, index.has(row.organizationId) ? null : row);
    if (Object.isFrozen(marker) && Object.isFrozen(marker.stores)) scopeIndices.set(marker, index);
  }
  if (index.has(org) && index.get(org) === null)
    return { unsupported: 'ambiguous-cabinet-lineage' };
  const entry = index.get(org);
  if (entry)
    return {
      scope: { kind: 'cabinet', storeId: entry.storeId, organizationId: org },
      relativeDirectory: entry.relativeDirectory,
    };
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(org))
    throw Error('Invalid PostgreSQL cabinet lineage');
  return {
    scope: { kind: 'cabinet', storeId: org, organizationId: org },
    relativeDirectory: 'tenants/' + org,
  };
}
// Reuses the existing read/domain factories. This context has neither a writer,
// a session cache, a background loop nor a provider/network operation.
async function createOperationContext(
  config,
  operation,
  current,
  relativeDirectory,
  keyCache,
  { platformOnly = false } = {},
) {
  const assertActive = operation.assertActive,
    org = current.organizationId;
  const db = operation.rows.store(operation.platform, operation.platformCatalog);
  const directory = path.resolve(config.dataDir, relativeDirectory);
  const { platform: platformCrypto, cabinet: cabinetCrypto } = platformOnly
    ? { platform: await keyCache.forPlatform(assertActive), cabinet: {} }
    : await keyCache.forOperation(directory, assertActive);
  const deny = () => {
    throw Object.assign(Error('Read-only PostgreSQL operation'), {
      status: 503,
      code: 'POSTGRES_QUERY_ONLY',
    });
  };
  const tokenHash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const database = {
    db,
    open: platformCrypto.decode,
    seal: platformCrypto.encode,
    tokenHash,
    id: crypto.randomUUID,
    audit: deny,
    emailHash: (value) => platformCrypto.hash(String(value).trim().toLowerCase()),
    limitKey: (scope, value) => scope + ':' + platformCrypto.hash(String(value || 'unknown')),
    closeWriter() {},
    transaction(callback, mode) {
      assertActive();
      if (mode !== 'READONLY') return deny();
      const result = callback();
      if (result && typeof result.then === 'function')
        throw Error('Pure projection must be synchronous');
      return result;
    },
  };
  const proof = Object.freeze({});
  const projectionSnapshot = {
    run(organizationId, callback) {
      assertActive();
      if (organizationId !== org) return deny();
      return callback();
    },
    read(callback) {
      assertActive();
      return callback();
    },
    proof() {
      assertActive();
      return proof;
    },
    contains(value, organizationId) {
      assertActive();
      return value === proof && organizationId === org;
    },
  };
  const readVersion = () => {
    assertActive();
    return [operation.epoch, operation.snapshot, 0];
  };
  let platform;
  const getPlatform = () => {
    assertActive();
    if (!platform) {
      platform = createNativeQueryPlatform(config, { database, projectionSnapshot, readVersion });
      platform.telegram.prefetchReadsAsync = db.prefetchAll;
      if (platform.notificationStore)
        platform.notificationStore.prefetchReadsAsync = db.prefetchAll;
    }
    return platform;
  };
  const readCacheBudget = createReadCacheBudget({ maxBytes: 2 * 1024 * 1024 });
  return {
    get platform() {
      return getPlatform();
    },
    db,
    directory,
    readVersion,
    readCacheBudget,
    ...cabinetCrypto,
    platformDecode197: platformCrypto.decode,
    cabinetDb: platformOnly
      ? null
      : operation.rows.store(operation.scope, operation.cabinetCatalog),
    close() {
      readCacheBudget.clear();
      platform?.close();
    },
  };
}
module.exports = { operationScope, createOperationContext };
