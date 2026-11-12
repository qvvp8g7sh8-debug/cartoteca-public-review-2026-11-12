const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { identifier: q } = require('./catalog-sqlite.cjs');
const { qualify } = require('./schema-plan.cjs');
const { feed } = require('./migration-rows.cjs');
const maximumLine = 64 * 1024 * 1024;
function validPostgresArchiveName(name) {
  return /^(?:manifest\.json|postgresql-runtime\.json|postgres\/(?:templates|native-manifests)\.json|postgres\/catalog\/[a-f0-9-]{36}\.json|postgres\/(?:platform|cabinet|budget)\/[a-f0-9-]{36}\/[a-z_][a-z0-9_]{0,119}\.jsonl|platform\/(?:platform\.key|assistant-state\.enc)|(?:tenants\/[a-f0-9-]{36}\/)?(?:encryption\.key|photos\/[a-f0-9]{32}\.enc))$/.test(
    name,
  );
}
function encode(value, type) {
  if (value === null) return null;
  if (type === 'BLOB') return Buffer.from(value).toString('base64');
  if (type === 'INTEGER') return BigInt(value).toString();
  if (type === 'REAL') {
    if (!Number.isFinite(Number(value))) throw Error('Unsupported backup number.');
    return Number(value);
  }
  if (typeof value !== 'string' || value.includes('\u0000'))
    throw Error('Invalid backup plain text.');
  return value;
}
function decode(value, type) {
  if (value === null) return null;
  if (type === 'BLOB') {
    if (typeof value !== 'string') throw Error('Invalid backup ciphertext.');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw Error('Invalid backup ciphertext.');
    return bytes;
  }
  if (type === 'INTEGER') {
    if (typeof value !== 'string' || !/^\-?(?:0|[1-9][0-9]*)$/.test(value))
      throw Error('Invalid backup integer.');
    const integer = BigInt(value);
    if (integer < -(1n << 63n) || integer >= 1n << 63n)
      throw Error('Backup integer is out of range.');
    return integer;
  }
  if (type === 'REAL') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw Error('Invalid backup number.');
    return value;
  }
  if (typeof value !== 'string' || value.includes('\u0000')) throw Error('Invalid backup text.');
  return value;
}
function hashRow(hash, row, table) {
  for (const c of table.columns) feed(hash, row[c.name], c.type.toUpperCase());
  feed(hash, row.__ordinal, 'INTEGER');
}
async function writeTypedRows(file, table, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const stream = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const hash = createHash('sha256');
  let count = 0,
    error;
  stream.on('error', (value) => {
    error = value;
  });
  try {
    for await (const row of rows) {
      hashRow(hash, row, table);
      count++;
      const line =
        JSON.stringify([
          BigInt(row.__ordinal).toString(),
          ...table.columns.map((c) => encode(row[c.name], c.type.toUpperCase())),
        ]) + '\n';
      if (Buffer.byteLength(line) > maximumLine) throw Error('Backup row exceeds its bound.');
      if (error) throw error;
      if (!stream.write(line)) await once(stream, 'drain');
    }
    stream.end();
    await once(stream, 'close');
    if (error) throw error;
    return { rows: count, sha256: hash.digest('hex') };
  } catch (failure) {
    stream.destroy();
    throw failure;
  }
}
async function* readTypedRows(file, table) {
  let pending = Buffer.alloc(0),
    last = null;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 128 * 1024 })) {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      const bytes = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      if (bytes.length > maximumLine) throw Error('Backup row exceeds its bound.');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw Error('Invalid backup UTF-8.');
      const values = JSON.parse(text);
      if (!Array.isArray(values) || values.length !== table.columns.length + 1)
        throw Error('Invalid typed backup row.');
      const ordinal = decode(values[0], 'INTEGER');
      if (last !== null && ordinal <= last) throw Error('Backup ordinal order is invalid.');
      last = ordinal;
      const row = { __ordinal: ordinal };
      table.columns.forEach((c, i) => {
        row[c.name] = decode(values[i + 1], c.type.toUpperCase());
      });
      if (table.integerPrimaryKey && row[table.integerPrimaryKey] !== ordinal)
        throw Error('Backup integer primary ordinal differs.');
      yield row;
    }
    if (pending.length > maximumLine) throw Error('Backup row exceeds its bound.');
  }
  if (pending.length) throw Error('Backup row stream is incomplete.');
}
async function* nativeRows(client, { kind, storeId }, table) {
  const ordinal = table.integerPrimaryKey || '_rowid',
    columns = table.columns.map((c) => q(c.name)).join(',');
  let last = null;
  for (;;) {
    const rows = (
      await client.query(
        'SELECT ' +
          columns +
          ',' +
          q(ordinal) +
          ' AS __ordinal FROM ' +
          qualify(kind, table.name) +
          ' WHERE _store_id=$1' +
          (last === null ? '' : ' AND ' + q(ordinal) + '>$2') +
          ' ORDER BY ' +
          q(ordinal) +
          ' LIMIT 200',
        last === null ? [storeId] : [storeId, last],
      )
    ).rows;
    for (const row of rows) {
      last = row.__ordinal;
      yield row;
    }
    if (rows.length < 200) break;
  }
}
async function importTypedStore(client, { directory, store }) {
  const { kind, storeId, metadata } = store,
    reports = [];
  await client.query(
    "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
    [kind, storeId],
  );
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  for (const table of Object.values(metadata.tables))
    await client.query('ALTER TABLE ' + qualify(kind, table.name) + ' DISABLE TRIGGER USER');
  try {
    for (const report of store.tables) {
      const table = metadata.tables[report.name];
      if (!table || !validPostgresArchiveName(report.file))
        throw Error('Invalid backup table inventory.');
      const target = qualify(kind, table.name),
        ordinal = table.integerPrimaryKey || '_rowid';
      if (
        (await client.query('SELECT 1 FROM ' + target + ' WHERE _store_id=$1 LIMIT 1', [storeId]))
          .rows.length
      )
        throw Error('Restore target store is not empty.');
      const columns = table.columns.map((c) => c.name),
        inserted = table.integerPrimaryKey ? columns : [...columns, '_rowid'];
      const hash = createHash('sha256');
      let count = 0,
        max = 0n;
      for await (const row of readTypedRows(path.join(directory, report.file), table)) {
        hashRow(hash, row, table);
        count++;
        max = max > row.__ordinal ? max : row.__ordinal;
        const values = [
          storeId,
          ...inserted.map((name) => (name === '_rowid' ? row.__ordinal : row[name])),
        ];
        await client.query(
          'INSERT INTO ' +
            target +
            '(' +
            ['_store_id', ...inserted].map(q).join(',') +
            ') VALUES(' +
            values.map((_, i) => '$' + (i + 1)).join(',') +
            ')',
          values,
        );
      }
      if (count !== report.rows || hash.digest('hex') !== report.sha256)
        throw Error('Restored typed rows differ.');
      const verify = createHash('sha256');
      let actual = 0;
      for await (const row of nativeRows(client, { kind, storeId }, table)) {
        hashRow(verify, row, table);
        actual++;
      }
      if (actual !== count || verify.digest('hex') !== report.sha256)
        throw Error('Native restored rows differ from backup.');
      const serial = (
        await client.query('SELECT pg_get_serial_sequence($1,$2) AS name', [target, ordinal])
      ).rows[0].name;
      if (serial) {
        const sequence = serial
          .split('.')
          .map((part) => q(part.replaceAll('"', '')))
          .join('.');
        await client.query(
          'SELECT setval($1::regclass,GREATEST((SELECT last_value FROM ' +
            sequence +
            '),$2::bigint,1),true)',
          [serial, max.toString()],
        );
      }
      reports.push({ name: table.name, rows: count, sha256: report.sha256 });
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    for (const table of Object.values(metadata.tables))
      try {
        await client.query('ALTER TABLE ' + qualify(kind, table.name) + ' ENABLE TRIGGER USER');
      } catch (error) {
        if (error.code !== '25P02') throw error;
      }
  }
  return reports;
}
module.exports = {
  validPostgresArchiveName,
  writeTypedRows,
  readTypedRows,
  nativeRows,
  hashRow,
  importTypedStore,
};
