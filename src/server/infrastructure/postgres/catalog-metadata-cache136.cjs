const maximumEntries = 16;
const maximumSerializedBytes = 8 * 1024 * 1024; // JSON budget, not an RSS limit.
const fullQuery =
  'SELECT metadata,catalog_hash,revision,version FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2';
const matchQuery =
  'SELECT metadata=$3::jsonb AS catalog_matches,catalog_hash,revision,version FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2';

// This cache holds schema descriptions only. Every hit compares the current SQL
// metadata with the previously verified value, and reads the current revision.
// A hash alone never authorizes reusing a cached catalog.
function freezeMetadata(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}
function validReference(reference) {
  return Boolean(
    reference &&
    Object.getPrototypeOf(reference) === Object.prototype &&
    Object.keys(reference).length === 2 &&
    typeof reference.catalogHash === 'string' &&
    /^[a-f0-9]{64}$/.test(reference.catalogHash) &&
    typeof reference.version === 'string' &&
    /^(?:0|[1-9][0-9]{0,8})$/.test(reference.version),
  );
}
function createCatalogMetadataCache136() {
  const entries = new Map();
  let bytes = 0;
  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }
  function candidate(kind, version) {
    const expected = version === undefined || version === 0 ? null : String(version);
    for (const [key, entry] of [...entries].reverse())
      if (entry.kind === kind && (expected === null || entry.version === expected))
        return touch(key, entry);
    return null;
  }
  async function read(query, scope, version) {
    const values = [scope.kind, scope.storeId];
    const cached = candidate(scope.kind, version);
    if (cached) {
      const result = await query(matchQuery, [...values, cached.serialized]);
      if (!result.rows.length) return { result, metadataVerified: false };
      const row = result.rows[0];
      if (
        result.rows.length === 1 &&
        row.catalog_matches === true &&
        row.catalog_hash === cached.hash &&
        String(row.version) === cached.version
      ) {
        const { catalog_matches, ...record } = row;
        return {
          result: { ...result, rows: [{ ...record, metadata: cached.metadata }] },
          metadataVerified: true,
        };
      }
    }
    return { result: await query(fullQuery, values), metadataVerified: false };
  }
  // Called only after the caller's existing digest/version checks and any
  // provisioning COMMIT. Failed inspections and absent stores are never cached.
  function rememberValidated(scope, record) {
    const version = String(record.version);
    const key = scope.kind + ':' + version + ':' + record.catalog_hash;
    const previous = entries.get(key);
    if (previous) return touch(key, previous).metadata;
    const serialized = JSON.stringify(record.metadata);
    const size = Buffer.byteLength(serialized);
    if (size > maximumSerializedBytes) return record.metadata;
    while (entries.size >= maximumEntries || bytes + size > maximumSerializedBytes) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).bytes;
      entries.delete(oldest);
    }
    entries.set(key, {
      kind: scope.kind,
      version,
      hash: record.catalog_hash,
      metadata: freezeMetadata(record.metadata),
      serialized,
      bytes: size,
    });
    bytes += size;
    return record.metadata;
  }
  function reference(kind, version) {
    const entry = candidate(kind, version);
    return entry ? { catalogHash: entry.hash, version: entry.version } : null;
  }
  function resolve(kind, reference) {
    if (!validReference(reference)) return null;
    const key = kind + ':' + reference.version + ':' + reference.catalogHash;
    const entry = entries.get(key);
    return entry ? touch(key, entry).metadata : null;
  }
  return { read, rememberValidated, reference, resolve };
}

module.exports = { createCatalogMetadataCache136, validReference };
