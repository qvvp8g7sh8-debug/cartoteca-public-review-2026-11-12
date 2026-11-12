const { validateRuntimeProfile } = require('./runtime.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const { FUNCTION, MAX_AUTHORITY_BYTES, RETURN_COLUMNS } = require('./hot-metadata-sql169.cjs');
const { invalid169, uuid169, hash169 } = require('./hot-metadata-component169.cjs');
const columns169 = RETURN_COLUMNS.split(',').map((c) => c.trim().split(/\s+/)[0]);
const authorityFields169 = [
  'id',
  'account_id',
  'organization_id',
  'expires_at',
  'account_value',
  'session_value',
  'global_admin',
  'account_status',
  'membership_role',
  'membership_status',
  'organization_status',
];
const eligibleReasons169 = new Set([
  'ready',
  'authority',
  'context',
  'session-selection',
  'authority-size',
  'binding-unprepared',
  'marker-generation',
  'component-generation',
  'catalog-generation',
  'clock-missing',
  'isolation',
  'busy',
  'dependency-invalid',
  'binding-invalid',
]);
const integer169 = (v) => {
  if (!(typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) throw invalid169();
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw invalid169();
  return n;
};
// Build once per verified marker/capability generation. The closed metadata
// index avoids scanning/hashing a potentially large marker for each hot request.
function createHotMetadataQuery169({ marker, capability, platformTemplate }) {
  validateRuntimeProfile(marker);
  if (
    !capability ||
    capability.version !== 1 ||
    !uuid169(capability.epoch) ||
    !hash169(capability.digest) ||
    !uuid169(capability.readScopes?.epoch) ||
    !hash169(capability.readScopes?.digest) ||
    !platformTemplate ||
    ![19, 20].includes(platformTemplate.version) ||
    !hash169(platformTemplate.hash)
  )
    throw invalid169();
  const index = new Map();
  for (const row of marker.stores)
    if (row.kind === 'cabinet' && row.organizationId)
      index.set(
        row.organizationId,
        index.has(row.organizationId)
          ? null
          : {
              storeId: row.storeId,
              version: row.schemaVersion,
              hash: marker.cabinetTemplates[String(row.schemaVersion)],
            },
      );
  const base = Object.freeze({
    platformStoreId: marker.platformStoreId,
    migrationId: marker.migrationId,
    markerHash: digest(marker),
    epoch: capability.epoch,
    componentDigest: capability.digest,
    scopeEpoch: capability.readScopes.epoch,
    scopeDigest: capability.readScopes.digest,
    pVersion: platformTemplate.version,
    pHash: platformTemplate.hash,
  });
  return function query({
    claimedAccountId,
    claimedOrganizationId,
    tokenHash,
    maxAuthorityBytes = MAX_AUTHORITY_BYTES,
  }) {
    if (
      !uuid169(claimedAccountId) ||
      !uuid169(claimedOrganizationId) ||
      !hash169(tokenHash) ||
      !Number.isSafeInteger(maxAuthorityBytes) ||
      maxAuthorityBytes < 1 ||
      maxAuthorityBytes > MAX_AUTHORITY_BYTES
    )
      throw invalid169();
    const cabinet = index.get(claimedOrganizationId);
    if (!cabinet || ![1, 2].includes(cabinet.version) || !hash169(cabinet.hash))
      return { unsupported: 'explicit-binding' };
    const expected = Object.freeze({
      ...base,
      accountId: claimedAccountId,
      organizationId: claimedOrganizationId,
      cabinetStoreId: cabinet.storeId,
      cVersion: cabinet.version,
      cHash: cabinet.hash,
      maxAuthorityBytes,
    });
    return {
      text: `SELECT * FROM ${FUNCTION}(${Array.from({ length: 14 }, (_, i) => '$' + (i + 1)).join(',')})`,
      values: [
        base.platformStoreId,
        base.migrationId,
        base.markerHash,
        claimedAccountId,
        claimedOrganizationId,
        tokenHash,
        cabinet.storeId,
        base.epoch,
        base.componentDigest,
        base.pVersion,
        base.pHash,
        cabinet.version,
        cabinet.hash,
        maxAuthorityBytes,
      ],
      expected,
    };
  };
}
function hotMetadataQuery169(options) {
  return createHotMetadataQuery169(options)(options);
}
function parseHotMetadata169(rows, expected) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !rows[0] ||
    typeof rows[0] !== 'object' ||
    JSON.stringify(Object.keys(rows[0]).sort()) !== JSON.stringify([...columns169].sort()) ||
    !expected
  )
    throw invalid169();
  const row = rows[0],
    reason = row.eligibility169;
  if (
    integer169(row.protocol169) !== 1 ||
    typeof row.isolation169 !== 'string' ||
    !eligibleReasons169.has(reason)
  )
    throw invalid169();
  if (reason === 'isolation') {
    if (row.isolation169 === 'read committed' || row.fence_locked !== null) throw invalid169();
    return {
      eligible: false,
      unsupported: 'isolation',
      authorityRows: null,
      versions: null,
      scope: null,
      metadata: row,
    };
  }
  if (row.isolation169 !== 'read committed' || typeof row.fence_locked !== 'boolean')
    throw invalid169();
  if (reason === 'busy' && row.fence_locked === false)
    throw Object.assign(Error('PostgreSQL metadata guard is busy.'), {
      status: 503,
      code: 'POSTGRES_BUSY',
    });
  if (
    row.fence_locked !== true ||
    ['busy', 'dependency-invalid', 'binding-invalid'].includes(reason)
  )
    throw invalid169();
  if (
    !uuid169(row.component_epoch169) ||
    row.component_digest169 !== expected.componentDigest ||
    !uuid169(row.lineage_migration169) ||
    !hash169(row.lineage_marker169) ||
    !hash169(row.p_catalog_hash169) ||
    row.p_catalog_matches169 !== true ||
    integer169(row.p_catalog_version169) < 1 ||
    !uuid169(row.scope_component_epoch169) ||
    row.scope_component_epoch169 !== expected.scopeEpoch ||
    row.scope_component_digest169 !== expected.scopeDigest
  )
    throw invalid169();
  if (
    row.binding_org169 !== null &&
    (!uuid169(row.binding_org169) ||
      !uuid169(row.binding_cabinet169) ||
      !uuid169(row.binding_epoch169) ||
      row.binding_proof_ok169 !== true)
  )
    throw invalid169();
  if (
    row.c_catalog_version169 !== null &&
    (integer169(row.c_catalog_version169) < 1 ||
      !hash169(row.c_catalog_hash169) ||
      row.c_catalog_matches169 !== true)
  )
    throw invalid169();
  let authorityRows;
  if (row.id === null) {
    if (
      reason !== 'authority' ||
      row.account_value !== null ||
      row.session_value !== null ||
      row.authority_bytes169 !== null
    )
      throw invalid169();
    authorityRows = [
      { fence_locked: true, ...Object.fromEntries(authorityFields169.map((k) => [k, row[k]])) },
    ];
  } else {
    if (
      !uuid169(row.id) ||
      !uuid169(row.account_id) ||
      (row.organization_id !== null && !uuid169(row.organization_id)) ||
      integer169(row.expires_at) < 1 ||
      ![0, 1].includes(integer169(row.global_admin))
    )
      throw invalid169();
    const bytes = integer169(row.authority_bytes169);
    if (reason === 'authority-size') {
      if (
        bytes <= expected.maxAuthorityBytes ||
        row.account_value !== null ||
        row.session_value !== null
      )
        throw invalid169();
      authorityRows = null;
    } else {
      if (
        bytes > expected.maxAuthorityBytes ||
        !Buffer.isBuffer(row.account_value) ||
        !Buffer.isBuffer(row.session_value) ||
        row.account_value.byteLength + row.session_value.byteLength !== bytes
      )
        throw invalid169();
      authorityRows = [
        { fence_locked: true, ...Object.fromEntries(authorityFields169.map((k) => [k, row[k]])) },
      ];
    }
  }
  const wanted = [
    ['platform', expected.platformStoreId, '*'],
    ['platform', expected.platformStoreId, expected.organizationId],
    ['cabinet', expected.cabinetStoreId, '*'],
  ];
  if (!Array.isArray(row.scope_rows169) || row.scope_rows169.length > 3) throw invalid169();
  let last = -1;
  for (const v of row.scope_rows169) {
    if (
      !Array.isArray(v) ||
      v.length !== 5 ||
      !uuid169(v[3]) ||
      typeof v[4] !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(v[4])
    )
      throw invalid169();
    const position = wanted.findIndex((w) => w.every((s, i) => s === v[i]));
    if (position <= last) throw invalid169();
    last = position;
  }
  const ready = reason === 'ready';
  if (
    ready &&
    (row.component_epoch169 !== expected.epoch ||
      row.lineage_migration169 !== expected.migrationId ||
      row.lineage_marker169 !== expected.markerHash ||
      row.binding_org169 !== expected.organizationId ||
      row.binding_cabinet169 !== expected.cabinetStoreId ||
      row.binding_epoch169 !== expected.epoch ||
      integer169(row.p_catalog_version169) !== expected.pVersion ||
      row.p_catalog_hash169 !== expected.pHash ||
      integer169(row.c_catalog_version169) !== expected.cVersion ||
      row.c_catalog_hash169 !== expected.cHash ||
      row.scope_rows169.length !== 3 ||
      row.account_id !== expected.accountId ||
      row.organization_id !== expected.organizationId ||
      !authorityRows)
  )
    throw invalid169();
  return {
    eligible: ready,
    unsupported: ready ? null : reason,
    authorityRows,
    versions: ready ? JSON.stringify([row.scope_component_epoch169, ...row.scope_rows169]) : null,
    scope: ready
      ? {
          kind: 'cabinet',
          storeId: expected.cabinetStoreId,
          organizationId: expected.organizationId,
        }
      : null,
    metadata: row,
  };
}
module.exports = { createHotMetadataQuery169, hotMetadataQuery169, parseHotMetadata169 };
