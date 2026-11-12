const bad = () => Object.assign(Error('Invalid directory164 read'), { status: 503 });
const key = (id, audience) =>
  `('directory164:'||encode(sha256(convert_to(${id},'UTF8')),'hex')||':'||${audience})`;
function directoryQuery164(scope, kind, selection) {
  const { audience } = selection;
  if (scope.kind !== 'cabinet' || !(audience === '*' || /^[a-f0-9]{64}$/.test(audience)))
    throw bad();
  const values = [scope.storeId, audience];
  if (kind === 'ready')
    return {
      text: "SELECT key,value FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key IN('directory164-ready','revision','initialized')",
      values: [scope.storeId],
      maximumRows: 3,
    };
  if (kind === 'index')
    return {
      text: `SELECT s.patient_id AS id,s.audience,CASE WHEN m.key IS NULL THEN 'raw' ELSE 'projection' END kind,COALESCE(m.value,s.value) AS value FROM cartoteca_cabinet.cabinet_summaries s LEFT JOIN LATERAL (SELECT m.key,m.value FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key=${key('s.patient_id', 's.audience')} LIMIT 1) m ON true WHERE s._store_id=$1 AND s.audience=$2 AND EXISTS(SELECT 1 FROM cartoteca_cabinet.meta ready WHERE ready._store_id=$1 AND ready.key='directory164-ready')
 UNION ALL SELECT m.key,NULL::text,'meta',m.value FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key IN('directory164-ready','revision','initialized')`,
      values,
      maximumRows: 2000000,
    };
  if (kind === 'full') {
    if (
      !Array.isArray(selection.ids) ||
      selection.ids.length > 100 ||
      selection.ids.some((id) => typeof id !== 'string' || !id || id.length > 120)
    )
      throw bad();
    return {
      text: 'SELECT patient_id AS id,value FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND audience=$2 AND patient_id=ANY($3::text[])',
      values: [...values, selection.ids],
      maximumRows: 100,
    };
  }
  throw bad();
}
function directorySources164(operation, audience) {
  const scope = operation.scope,
    catalog = operation.cabinetCatalog;
  return [
    {
      scope,
      catalog,
      table: 'meta',
      where:
        "s.key LIKE 'directory164:%' AND right(s.key,length($2)+1)=':'||$2 AND EXISTS(SELECT 1 FROM cartoteca_cabinet.meta ready WHERE ready._store_id=$1 AND ready.key='directory164-ready')",
      values: [audience],
    },
    {
      scope,
      catalog,
      table: 'cabinet_summaries',
      where: `s.audience=$2 AND EXISTS(SELECT 1 FROM cartoteca_cabinet.meta ready WHERE ready._store_id=$1 AND ready.key='directory164-ready') AND (SELECT 1 FROM cartoteca_cabinet.meta m WHERE m._store_id=$1 AND m.key=${key('s.patient_id', 's.audience')} LIMIT 1) IS NULL`,
      values: [audience],
    },
  ];
}
// Optional complete snapshots can read the two bounded cohorts independently.
// Keep the original scalar/LATERAL plans unchanged for every legacy fallback.
const { createHash } = require('node:crypto');
const { sourceProbe } = require('./read-source-probe152.cjs');
const COHORT_ROWS189 = 2048;
const COHORT_CIPHER189 = 2 * 1024 * 1024;
const COHORT_DECODE189 = 352 * 1024 * 1024;
function directoryCohortSources189(operation, audience) {
  // Reuse the closed audience validation; no caller SQL enters either plan.
  directoryQuery164(operation.scope, 'ready', { audience });
  const scope = operation.scope,
    catalog = operation.cabinetCatalog,
    ready =
      "EXISTS(SELECT 1 FROM cartoteca_cabinet.meta ready WHERE ready._store_id=$1 AND ready.key='directory164-ready')";
  return [
    {
      scope,
      catalog,
      table: 'cabinet_summaries',
      where: 's.audience=$2 AND ' + ready,
      values: [audience],
    },
    {
      scope,
      catalog,
      table: 'meta',
      where: "s.key LIKE 'directory164:%' AND right(s.key,length($2)+1)=':'||$2 AND " + ready,
      values: [audience],
    },
  ];
}
function directoryCohortPreview189(scope, catalog, audience) {
  const sources = directoryCohortSources189({ scope, cabinetCatalog: catalog }, audience);
  const branches = sources.map((source, index) =>
    sourceProbe(source, index, 0).replace(
      ',NULL::text AS witness',
      ',COALESCE(sum(octet_length(s.value)),0)::bigint AS cipher_bytes,NULL::text AS witness',
    ),
  );
  return {
    text: `SELECT p.*,EXISTS(SELECT 1 FROM cartoteca_cabinet.meta ready WHERE ready._store_id=$1 AND ready.key='directory164-ready') AS ready FROM (${branches.join(' UNION ALL ')}) p`,
    values: [scope.storeId, audience],
  };
}
function directoryCohortBound189(rows) {
  if (!Array.isArray(rows) || rows.length !== 2) throw bad();
  const values = new Map();
  for (const row of rows) {
    const number = (value) =>
      typeof value === 'number' || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
        ? Number(value)
        : NaN;
    const index = number(row.source),
      count = number(row.rows),
      bytes = number(row.bytes),
      cipherBytes = number(row.cipher_bytes);
    if (
      ![0, 1].includes(index) ||
      values.has(index) ||
      typeof row.ready !== 'boolean' ||
      ![count, bytes, cipherBytes].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      cipherBytes > bytes
    )
      throw bad();
    values.set(index, { rows: count, bytes, cipherBytes, ready: row.ready });
  }
  const summary = values.get(0),
    projection = values.get(1);
  if (summary.ready !== projection.ready) throw bad();
  if (!summary.ready) return null;
  const totalRows = summary.rows + projection.rows,
    totalBytes = summary.bytes + projection.bytes,
    cipherBytes = summary.cipherBytes + projection.cipherBytes;
  if (
    summary.rows > COHORT_ROWS189 ||
    projection.rows > COHORT_ROWS189 ||
    cipherBytes > COHORT_CIPHER189 ||
    totalBytes * 144 + totalRows * 1536 > COHORT_DECODE189
  )
    return null;
  return Object.freeze({ summary: Object.freeze(summary), projection: Object.freeze(projection) });
}
function directoryCohortQuery189(scope, audience) {
  directoryQuery164(scope, 'ready', { audience });
  return {
    text: `SELECT patient_id AS id,audience,'summary'::text AS kind,value FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND audience=$2
 UNION ALL SELECT key,NULL::text,'projection-key',value FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key LIKE 'directory164:%' AND right(key,length($2)+1)=':'||$2
 UNION ALL SELECT key,NULL::text,'meta',value FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key IN('directory164-ready','revision','initialized')`,
    values: [scope.storeId, audience],
    maximumRows: 2 * COHORT_ROWS189 + 3,
  };
}
function directoryCohortRows189(rows, bound, audience) {
  const summaries = new Map(),
    projections = new Map(),
    meta = new Map();
  if (!bound || !Array.isArray(rows) || rows.length > 2 * COHORT_ROWS189 + 3) throw bad();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !Buffer.isBuffer(row.value)) throw bad();
    if (row.kind === 'summary') {
      if (!row.id || row.id.length > 120 || row.audience !== audience || summaries.has(row.id))
        throw bad();
      summaries.set(row.id, row);
    } else if (row.kind === 'projection-key') {
      if (
        row.audience !== null ||
        !row.id.startsWith('directory164:') ||
        !row.id.endsWith(':' + audience) ||
        projections.has(row.id)
      )
        throw bad();
      projections.set(row.id, row);
    } else if (row.kind === 'meta') {
      if (
        row.audience !== null ||
        !['directory164-ready', 'revision', 'initialized'].includes(row.id) ||
        meta.has(row.id)
      )
        throw bad();
      meta.set(row.id, row);
    } else throw bad();
  }
  if (
    summaries.size !== bound.summary.rows ||
    projections.size !== bound.projection.rows ||
    !meta.has('directory164-ready')
  )
    throw bad();
  const index = [...meta.values()],
    full = [];
  for (const [id, row] of summaries) {
    const projectionKey =
        'directory164:' + createHash('sha256').update(id, 'utf8').digest('hex') + ':' + audience,
      projection = projections.get(projectionKey);
    index.push({
      id,
      audience,
      kind: projection ? 'projection' : 'raw',
      value: projection ? projection.value : row.value,
    });
    full.push(Object.freeze({ id, bucket: 'summary', value: row.value }));
  }
  // Unmatched projection keys (including malformed orphan ciphertext) have
  // already been charged and bounded; legacy164 never decodes those rows.
  return { rows: Object.freeze(index.map(Object.freeze)), full: Object.freeze(full) };
}
module.exports = {
  directoryQuery164,
  directorySources164,
  directoryCohortSources189,
  directoryCohortPreview189,
  directoryCohortBound189,
  directoryCohortQuery189,
  directoryCohortRows189,
};
