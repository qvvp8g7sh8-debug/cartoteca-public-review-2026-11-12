const { digest } = require('./catalog-sqlite.cjs');
const MAX_ANCHOR_BYTES199 = 256 * 1024;
const invalid199 = () =>
  Object.assign(Error('Prepared catalog image component is invalid.'), {
    status: 503,
    code: 'POSTGRES_CATALOG_IMAGE_COMPONENT_INVALID199',
  });
function validateCatalogImageAnchors199(anchors) {
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) throw invalid199();
  const keys = Object.keys(anchors);
  if (!keys.length || keys.length > 4) throw invalid199();
  for (const key of keys) {
    const a = anchors[key];
    if (
      !/^(?:platform:(?:19|20)|cabinet:[12])$/.test(key) ||
      !a ||
      typeof a !== 'object' ||
      Array.isArray(a) ||
      JSON.stringify(Object.keys(a).sort()) !== '["hash","kind","metadata","version"]' ||
      key !== a.kind + ':' + a.version ||
      !a.metadata ||
      typeof a.metadata !== 'object' ||
      Array.isArray(a.metadata) ||
      !/^[a-f0-9]{64}$/.test(a.hash || '') ||
      digest(a.metadata) !== a.hash
    )
      throw invalid199();
    const bytes = Buffer.byteLength(JSON.stringify(a.metadata));
    if (!bytes || bytes > MAX_ANCHOR_BYTES199) throw invalid199();
  }
  return anchors;
}
async function readCatalogImageAnchors199(client) {
  const predicate =
    "(kind='platform' AND version IN(19,20)) OR(kind='cabinet' AND version IN(1,2))";
  const preview = (
    await client.query(`WITH used AS (
      SELECT kind,version,catalog_hash,count(*) n FROM cartoteca_catalog.stores
      WHERE ${predicate} GROUP BY kind,version,catalog_hash
    ), chosen AS (
      SELECT DISTINCT ON(t.kind,t.version) t.kind,t.version,t.catalog_hash
      FROM cartoteca_catalog.templates t LEFT JOIN used u
      ON u.kind=t.kind AND u.version=t.version AND u.catalog_hash=t.catalog_hash
      WHERE (t.kind='platform' AND t.version IN(19,20)) OR(t.kind='cabinet' AND t.version IN(1,2))
      ORDER BY t.kind,t.version,COALESCE(u.n,0) DESC,t.catalog_hash COLLATE "C"
    ) SELECT t.kind,t.version,t.catalog_hash,octet_length(t.metadata::text)::bigint bytes
      FROM chosen c JOIN cartoteca_catalog.templates t
      ON t.kind=c.kind AND t.version=c.version AND t.catalog_hash=c.catalog_hash
      ORDER BY t.kind,t.version`)
  ).rows;
  if (
    !preview.length ||
    preview.length > 4 ||
    preview.some(
      (r) =>
        !/^(?:platform:(?:19|20)|cabinet:[12])$/.test(r.kind + ':' + r.version) ||
        !/^[a-f0-9]{64}$/.test(r.catalog_hash || '') ||
        !Number.isSafeInteger(Number(r.bytes)) ||
        Number(r.bytes) < 1 ||
        Number(r.bytes) > MAX_ANCHOR_BYTES199,
    )
  )
    throw invalid199();
  const rows = (
    await client.query(
      `SELECT t.kind,t.version,t.catalog_hash,t.metadata FROM cartoteca_catalog.templates t
       JOIN unnest($1::text[],$2::bigint[],$3::text[]) chosen(kind,version,catalog_hash)
       ON t.kind=chosen.kind AND t.version=chosen.version AND t.catalog_hash=chosen.catalog_hash
       WHERE octet_length(t.metadata::text) BETWEEN 1 AND ${MAX_ANCHOR_BYTES199}
       ORDER BY t.kind,t.version`,
      [
        preview.map((r) => r.kind),
        preview.map((r) => Number(r.version)),
        preview.map((r) => r.catalog_hash),
      ],
    )
  ).rows;
  if (rows.length !== preview.length) throw invalid199();
  const anchors = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i],
      p = preview[i],
      version = Number(r.version),
      key = r.kind + ':' + version;
    if (
      anchors[key] ||
      p.kind !== r.kind ||
      Number(p.version) !== version ||
      p.catalog_hash !== r.catalog_hash
    )
      throw invalid199();
    anchors[key] = { kind: r.kind, version, hash: r.catalog_hash, metadata: r.metadata };
  }
  return validateCatalogImageAnchors199(anchors);
}
module.exports = {
  MAX_ANCHOR_BYTES199,
  invalid199,
  validateCatalogImageAnchors199,
  readCatalogImageAnchors199,
};
