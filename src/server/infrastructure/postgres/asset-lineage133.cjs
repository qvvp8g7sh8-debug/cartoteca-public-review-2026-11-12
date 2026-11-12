'use strict';
const { validateRuntimeProfile } = require('./runtime.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const denied = () =>
  Object.assign(Error('PostgreSQL cabinet asset lineage does not match.'), {
    code: 'POSTGRES_ASSET_LINEAGE_MISMATCH',
    status: 503,
  });
function assetLineage(marker, { platformStoreId, migrationId, markerHash }) {
  try {
    validateRuntimeProfile(marker);
  } catch {
    throw denied();
  }
  if (
    marker.platformStoreId !== platformStoreId ||
    marker.migrationId !== migrationId ||
    digest(marker) !== markerHash
  )
    throw denied();
  const scopes = new Map(
    marker.stores.map((row) => [
      row.kind + ':' + row.storeId,
      Object.freeze({ kind: row.kind, storeId: row.storeId, organizationId: row.organizationId }),
    ]),
  );
  return Object.freeze({ platformStoreId, migrationId, markerHash, scopes });
}
function assertKnownScope(scope, expected) {
  if (
    scope.kind !== expected.kind ||
    scope.storeId !== expected.storeId ||
    (scope.organizationId || null) !== expected.organizationId
  )
    throw denied();
}
module.exports = { assetLineage, assertKnownScope, denied };
