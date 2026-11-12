const { createHash } = require('node:crypto');
const { identifier: q } = require('./catalog-sqlite.cjs');
const { qualify } = require('./schema-plan.cjs');
function feed(hash, value, type) {
  let code, bytes;
  if (value === null) {
    code = 'null';
    bytes = Buffer.alloc(0);
  } else if (type === 'BLOB') {
    code = 'blob';
    bytes = Buffer.from(value);
  } else if (type === 'INTEGER') {
    code = 'integer';
    bytes = Buffer.from(BigInt(value).toString());
  } else if (type === 'REAL') {
    if (!Number.isFinite(Number(value))) throw Error('Unsupported nonfinite source number.');
    code = 'real';
    bytes = Buffer.from(Number(value).toString());
  } else {
    code = 'text';
    bytes = Buffer.from(String(value), 'utf8');
  }
  hash.update(code + ':' + bytes.length + ':');
  hash.update(bytes);
  hash.update(';');
}
function rowDigest(hash, row, table) {
  for (const column of table.columns) feed(hash, row[column.name], column.type.toUpperCase());
  feed(hash, row.__ordinal, 'INTEGER');
}
function sourceRows(sqlite, table) {
  const ordinal = table.integerPrimaryKey || (table.rowid ? 'rowid' : null);
  const statement = sqlite.prepare(
    'SELECT ' +
      table.columns.map((c) => q(c.name)).join(',') +
      (ordinal ? ',' + q(ordinal) + ' AS __ordinal' : '') +
      ' FROM ' +
      q(table.name) +
      ' ORDER BY ' +
      (ordinal ? q(ordinal) : table.primary.map(q).join(',')),
  );
  statement.setReadBigInts(true);
  let sequence = 0n;
  return (function* () {
    for (const row of statement.iterate())
      yield { ...row, __ordinal: ordinal ? row.__ordinal : ++sequence };
  })();
}
async function copyStoreRows(client, { sqlite, kind, storeId, source, readers = {} }) {
  const reports = [];
  await client.query(
    "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
    [kind, storeId],
  );
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  // Triggers are disabled only inside this offline administrative transaction.
  // Exact dirty projections and immutable financial history are imported as-is.
  for (const table of Object.values(source.tables))
    await client.query('ALTER TABLE ' + qualify(kind, table.name) + ' DISABLE TRIGGER USER');
  try {
    for (const table of Object.values(source.tables)) {
      const target = qualify(kind, table.name),
        ordinal = table.integerPrimaryKey || '_rowid';
      if (
        (await client.query('SELECT 1 FROM ' + target + ' WHERE _store_id=$1 LIMIT 1', [storeId]))
          .rows.length
      )
        throw Error('Import target store is not empty.');
      const columns = table.columns.map((c) => c.name),
        inserted = table.integerPrimaryKey ? columns : [...columns, '_rowid'];
      const names = ['_store_id', ...inserted];
      const hash = createHash('sha256');
      let count = 0,
        maxOrdinal = 0n;
      for (const row of sourceRows(readers[table.name] || sqlite, table)) {
        rowDigest(hash, row, table);
        count++;
        maxOrdinal = maxOrdinal > BigInt(row.__ordinal) ? maxOrdinal : BigInt(row.__ordinal);
        const values = [
          storeId,
          ...inserted.map((name) => (name === '_rowid' ? row.__ordinal : row[name])),
        ];
        await client.query(
          'INSERT INTO ' +
            target +
            '(' +
            names.map(q).join(',') +
            ') VALUES(' +
            values.map((_, i) => '$' + (i + 1)).join(',') +
            ')',
          values,
        );
      }
      const expected = hash.digest('hex'),
        actual = createHash('sha256');
      let copied = 0,
        last = null;
      for (;;) {
        const rows = (
          await client.query(
            'SELECT ' +
              columns.map(q).join(',') +
              ',' +
              q(ordinal) +
              ' AS __ordinal FROM ' +
              target +
              ' WHERE _store_id=$1' +
              (last === null ? '' : ' AND ' + q(ordinal) + '>$2') +
              ' ORDER BY ' +
              q(ordinal) +
              ' LIMIT 200',
            last === null ? [storeId] : [storeId, last],
          )
        ).rows;
        for (const row of rows) {
          rowDigest(actual, row, table);
          copied++;
          last = row.__ordinal;
        }
        if (rows.length < 200) break;
      }
      if (copied !== count || actual.digest('hex') !== expected)
        throw Error('Imported typed data/ordinal verification failed: ' + table.name);
      const serial = (
        await client.query('SELECT pg_get_serial_sequence($1,$2) AS name', [target, ordinal])
      ).rows[0].name;
      if (serial) {
        // Never rewind a shared physical identity sequence when another store exists.
        const parts = serial
          .split('.')
          .map((part) => q(part.replaceAll('"', '')))
          .join('.');
        await client.query(
          'SELECT setval($1::regclass,GREATEST((SELECT last_value FROM ' +
            parts +
            '),$2::bigint,1),true)',
          [serial, maxOrdinal.toString()],
        );
      }
      reports.push({ table: table.name, rows: count, sha256: expected });
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    // A failed SQL statement aborts its transaction; ROLLBACK also restores every
    // DISABLE TRIGGER. Do not mask that failure with another aborted statement.
    for (const table of Object.values(source.tables)) {
      try {
        await client.query('ALTER TABLE ' + qualify(kind, table.name) + ' ENABLE TRIGGER USER');
      } catch (error) {
        if (error.code !== '25P02') throw error;
      }
    }
  }
  return reports;
}
module.exports = { copyStoreRows, sourceRows, feed };
