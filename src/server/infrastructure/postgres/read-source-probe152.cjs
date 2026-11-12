const { createHash } = require('node:crypto');
const { identifier, namespace } = require('./catalog-sqlite.cjs');
const MAX_WITNESS_ROWS = 4096;
function sourceProbe(source, index, offset, { witness = false } = {}) {
  const table = source.catalog.tables[source.table];
  if (!table) throw Error('Unattested PostgreSQL probe table');
  const where = source.where.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + offset));
  const sizes = table.columns.map((column) => {
    const name = 's.' + identifier(column.name),
      type = column.type.toUpperCase();
    return type === 'BLOB'
      ? 'COALESCE(octet_length(' + name + '),0)'
      : type === 'TEXT'
        ? '2*COALESCE(octet_length(' + name + '),0)'
        : '16';
  });
  const from = `${identifier(namespace(source.scope.kind))}.${identifier(source.table)} s WHERE s._store_id=$${offset + 1} AND (${where})`;
  const columns = `${index}::integer source,count(*)::bigint rows,COALESCE(sum(64+${sizes.join('+')}),0)::bigint bytes`;
  if (!witness) return `SELECT ${columns},NULL::text AS witness FROM ${from}`;
  // ctid+xmin identifies the actual visible row version, including direct SQL,
  // deletion, reinsertion, notification/index updates and rollback. Only 4096
  // short physical identifiers enter the aggregate, even for an enormous source.
  // The hash is a coherence witness, never an authorization token.
  return `SELECT ${columns},CASE WHEN count(*)<=${MAX_WITNESS_ROWS} THEN encode(sha256(convert_to(COALESCE(string_agg(s.row_version,',' ORDER BY s.row_version COLLATE "C") FILTER(WHERE s.row_number<=${MAX_WITNESS_ROWS}),''),'UTF8')),'hex') END AS witness FROM (SELECT s.*,s.ctid::text||':'||s.xmin::text AS row_version,row_number() OVER () AS row_number FROM ${from}) s`;
}
function sourceWitness(sources, values) {
  if (
    !sources.length ||
    values.length !== sources.length ||
    values.some((value) => !/^[a-f0-9]{64}$/.test(value || ''))
  )
    return null;
  return createHash('sha256')
    .update(
      JSON.stringify(
        sources.map((source, index) => [
          source.scope.kind,
          source.scope.storeId,
          source.catalog.version,
          source.table,
          source.where,
          source.values || [],
          values[index],
        ]),
      ),
    )
    .digest('hex');
}
module.exports = { sourceProbe, sourceWitness, MAX_WITNESS_ROWS };
