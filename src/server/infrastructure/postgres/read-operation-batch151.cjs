// Pack attested, simple row lookups without JSON conversion of encrypted BLOBs.
// Descriptors are created from server SQL and the owning catalog, never HTTP.
const { identifier } = require('./catalog-sqlite.cjs');
const types = {
  TEXT: { slot: 0, oid: 25 },
  INTEGER: { slot: 1, oid: 20 },
  BLOB: { slot: 2, oid: 17 },
};
const invalid = () =>
  Object.assign(Error('Invalid typed PostgreSQL read batch'), {
    code: 'POSTGRES_TYPED_READ_BATCH',
    status: 503,
  });
function describeReadBatch(catalog, sql) {
  const match = /^SELECT ([a-z_]+(?:,[a-z_]+)*) FROM ([a-z_]+) WHERE ([a-z_]+)=\?$/i.exec(sql);
  if (!match) return null;
  const table = catalog.tables[match[2]],
    counters = [0, 0, 0];
  if (!table || !table.columns.some((c) => c.name === match[3])) return null;
  const names = match[1].split(',');
  if (names.length > 8 || new Set(names).size !== names.length) return null;
  const columns = [];
  for (const name of names) {
    const column = table.columns.find((c) => c.name === name),
      type = types[column?.type?.toUpperCase()];
    if (!type) return null;
    columns.push({ name, slot: type.slot, offset: counters[type.slot]++, oid: type.oid });
  }
  return { columns, counts: counters };
}
function typedReadBatch(reads) {
  if (reads.length < 2 || reads.length > 16 || reads.some((r) => !r.batch)) throw invalid();
  const scope = reads[0].scope;
  if (reads.some((r) => r.scope.kind !== scope.kind || r.scope.storeId !== scope.storeId))
    throw invalid();
  const values = [];
  const branches = reads.map((read, index) => {
    const offset = values.length;
    values.push(...read.plan.values);
    // Only simple identifier/equality source SQL can receive this descriptor;
    // generated SQL contains bind parameters, with no user/literal dollar text.
    const text = read.plan.text.replace(/\$(\d+)/g, (_, n) => '$' + (Number(n) + offset));
    const arrays = ['text', 'bigint', 'bytea'].map(
      (type, slot) =>
        'ARRAY[' +
        read.batch.columns
          .filter((c) => c.slot === slot)
          .map((c) => 'q.' + identifier(c.name))
          .join(',') +
        ']::' +
        type +
        '[]',
    );
    return 'SELECT ' + index + '::integer AS source,' + arrays.join(',') + ' FROM (' + text + ') q';
  });
  return { text: branches.join(' UNION ALL '), values };
}
function createTypedReadResults(reads) {
  const results = reads.map((read) => ({
    rows: [],
    fields: read.batch.columns.map((c) => ({ name: c.name, dataTypeID: c.oid })),
  }));
  return {
    results,
    row(raw) {
      const index = raw[0],
        read = reads[index];
      if (!Number.isSafeInteger(index) || !read || raw.length !== 4) throw invalid();
      const arrays = raw.slice(1);
      if (arrays.some((a, slot) => !Array.isArray(a) || a.length !== read.batch.counts[slot]))
        throw invalid();
      const value = read.batch.columns.map((c) => {
        const item = arrays[c.slot][c.offset];
        if (
          item != null &&
          (c.slot === 0
            ? typeof item !== 'string'
            : c.slot === 2
              ? !Buffer.isBuffer(item)
              : !/^-?\d+$/.test(String(item)))
        )
          throw invalid();
        return item;
      });
      return { index, value };
    },
  };
}
module.exports = { describeReadBatch, typedReadBatch, createTypedReadResults };
