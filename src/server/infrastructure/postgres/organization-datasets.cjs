const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  nativeRows,
  writeTypedRows,
  readTypedRows,
  hashRow,
  validPostgresArchiveName,
} = require('./backup-rows.cjs');
const { feed } = require('./migration-rows.cjs');
const { digest, identifier: q } = require('./catalog-sqlite.cjs');
const { qualify } = require('./schema-plan.cjs');
const { modifiedTable, tablePolicy, interestPolicy } = require('./organization-policy.cjs');
const { plainFile, safeTree } = require('../backup/snapshot.cjs');
const { digest: fileDigest } = require('../backup/archive.cjs');
const { syncFile, syncDirectory, atomicJson } = require('../backup/durable.cjs');
function logical(hash, row, table) {
  for (const column of table.columns) feed(hash, row[column.name], column.type.toUpperCase());
}
function names(store) {
  return Object.keys(store.metadata.tables).sort();
}
function ownAudit(row, id) {
  return (
    ['organization_backup_restored_postgres', 'organization_backup_rollback_postgres'].includes(
      row.event,
    ) &&
    row.actor_id === null &&
    row.detail ===
      JSON.stringify({ format: 2, jobId: id, notificationsPaused: true, accessPreserved: true })
  );
}
function selected(name, row, org, interest) {
  if (name === 'organizations') return row.id === org;
  if (name === 'telegram_runtime') return interest(row.key);
  return row.organization_id === org;
}
async function liveInterest(client, store, org) {
  const ids = new Set();
  for (const [channel, name] of [
    ['telegram', 'staff_notification_jobs'],
    ['max', 'staff_max_jobs'],
  ])
    if (store.metadata.tables[name]) {
      const result = await client.query(
        'SELECT id FROM ' +
          qualify('platform', name) +
          ' WHERE _store_id=$1 AND organization_id=$2',
        [store.storeId, org],
      );
      for (const row of result.rows) ids.add('staff-selftest-v1:' + channel + ':' + row.id);
    }
  return interestPolicy(org, ids);
}
async function inspectStore(client, kind, storeId) {
  const row = (
    await client.query(
      'SELECT metadata,catalog_hash,version FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2',
      [kind, storeId],
    )
  ).rows[0];
  if (
    !row ||
    digest(row.metadata) !== row.catalog_hash ||
    BigInt(row.version) !== BigInt(row.metadata.version)
  )
    throw Error('PostgreSQL store catalog is invalid.');
  return { kind, storeId, metadata: row.metadata, tables: [] };
}
async function capture(client, { platform, cabinet, organizationId, directory, jobId }) {
  const full = crypto.createHash('sha256'),
    protectedRows = crypto.createHash('sha256'),
    target = crypto.createHash('sha256');
  const policy = tablePolicy(platform.metadata),
    interest = await liveInterest(client, platform, organizationId);
  const output = {
    format: 1,
    platform: { ...platform, tables: [] },
    cabinet: { ...cabinet, tables: [] },
  };
  for (const name of names(platform)) {
    const table = platform.metadata.tables[name],
      header = name + ':' + digest(table) + ':';
    full.update(header);
    protectedRows.update(header);
    target.update(header);
    const file = 'postgres/platform/' + platform.storeId + '/' + name + '.jsonl';
    async function* collect() {
      for await (const row of nativeRows(client, platform, table)) {
        if (name === 'platform_audit' && ownAudit(row, jobId)) continue;
        hashRow(full, row, table);
        const belongs = selected(name, row, organizationId, interest);
        if (!(belongs && modifiedTable(name, policy))) hashRow(protectedRows, row, table);
        if (belongs) {
          logical(target, row, table);
          yield row;
        }
      }
    }
    if (directory)
      output.platform.tables.push({
        name,
        file,
        ...(await writeTypedRows(path.join(directory, file), table, collect())),
      });
    else for await (const row of collect()) void row;
  }
  for (const name of names(cabinet)) {
    const table = cabinet.metadata.tables[name],
      header = name + ':' + digest(table) + ':';
    full.update(header);
    target.update(header);
    const file = 'postgres/cabinet/' + cabinet.storeId + '/' + name + '.jsonl';
    async function* collect() {
      for await (const row of nativeRows(client, cabinet, table)) {
        hashRow(full, row, table);
        hashRow(target, row, table);
        yield row;
      }
    }
    if (directory)
      output.cabinet.tables.push({
        name,
        file,
        ...(await writeTypedRows(path.join(directory, file), table, collect())),
      });
    else for await (const row of collect()) void row;
  }
  if (directory) {
    atomicJson(path.join(directory, 'inventory.json'), output);
    syncDirectory(directory);
  }
  return {
    inventory: output,
    full: full.digest('hex'),
    protected: protectedRows.digest('hex'),
    target: target.digest('hex'),
  };
}
function readInventory(directory) {
  safeTree(directory);
  const file = path.join(directory, 'inventory.json');
  plainFile(file);
  if (fs.statSync(file).size > 16 * 1024 * 1024) throw Error('Excessive recovery inventory.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value.format !== 1 ||
    value.platform?.kind !== 'platform' ||
    value.cabinet?.kind !== 'cabinet'
  )
    throw Error('Invalid recovery inventory.');
  for (const store of [value.platform, value.cabinet]) {
    if (
      !/^[a-f0-9-]{36}$/i.test(store.storeId) ||
      !store.metadata?.tables ||
      !Array.isArray(store.tables) ||
      store.tables.length !== names(store).length
    )
      throw Error('Invalid recovery store.');
    const seen = new Set();
    for (const report of store.tables) {
      if (
        !store.metadata.tables[report.name] ||
        seen.has(report.name) ||
        report.file !==
          'postgres/' + store.kind + '/' + store.storeId + '/' + report.name + '.jsonl' ||
        !validPostgresArchiveName(report.file) ||
        !Number.isSafeInteger(report.rows) ||
        report.rows < 0 ||
        !/^[a-f0-9]{64}$/.test(report.sha256)
      )
        throw Error('Invalid recovery table report.');
      seen.add(report.name);
      safeTree(path.dirname(path.join(directory, report.file)));
      plainFile(path.join(directory, report.file));
    }
  }
  return value;
}
async function verifyInventory(directory) {
  const inventory = readInventory(directory),
    target = crypto.createHash('sha256');
  for (const store of [inventory.platform, inventory.cabinet])
    for (const name of names(store)) {
      const table = store.metadata.tables[name],
        report = store.tables.find((row) => row.name === name),
        hash = crypto.createHash('sha256');
      let count = 0;
      target.update(name + ':' + digest(table) + ':');
      for await (const row of readTypedRows(path.join(directory, report.file), table)) {
        hashRow(hash, row, table);
        count++;
        if (store.kind === 'platform') logical(target, row, table);
        else hashRow(target, row, table);
      }
      if (count !== report.rows || hash.digest('hex') !== report.sha256)
        throw Error('Prepared recovery rows changed.');
    }
  return { inventory, target: target.digest('hex') };
}
async function photoIds(directory, store) {
  const table = store.metadata.tables.photos,
    report = store.tables.find((row) => row.name === 'photos'),
    result = [];
  if (!table || !report) throw Error('Cabinet photograph inventory missing.');
  for await (const row of readTypedRows(path.join(directory, report.file), table))
    if (Number(row.active) === 1) {
      if (!/^[a-f0-9]{32}$/.test(row.id)) throw Error('Invalid photograph identifier.');
      result.push(row.id);
    }
  return result.sort();
}
async function assetFingerprint(directory, ids) {
  safeTree(directory);
  const result = [];
  for (const name of ['encryption.key', ...ids.map((id) => 'photos/' + id + '.enc')]) {
    const file = path.join(directory, name);
    safeTree(path.dirname(file));
    plainFile(file);
    result.push({ name, sha256: await fileDigest(file) });
  }
  return digest(result);
}
async function copyAssets(source, destination, ids) {
  safeTree(source);
  if (fs.existsSync(destination)) throw Error('Recovery asset staging exists.');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ['encryption.key', ...ids.map((id) => 'photos/' + id + '.enc')]) {
    const from = path.join(source, name),
      to = path.join(destination, name);
    safeTree(path.dirname(from));
    plainFile(from);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, 0o600);
    syncFile(to);
  }
  syncDirectory(destination);
}
async function replaceRows(client, { directory, store, organizationId, policy, whole = false }) {
  await client.query(
    "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
    [store.kind, store.storeId],
  );
  const modified = Object.values(store.metadata.tables).filter(
    (table) => whole || modifiedTable(table.name, policy),
  );
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  for (const table of modified)
    await client.query('ALTER TABLE ' + qualify(store.kind, table.name) + ' DISABLE TRIGGER USER');
  try {
    for (const table of modified) {
      const target = qualify(store.kind, table.name),
        columns = table.columns.map((column) => column.name);
      let where = '';
      const values = [store.storeId];
      if (!whole) {
        if (table.name === 'organizations') {
          where = ' AND id=$2';
          values.push(organizationId);
        } else if (table.name === 'telegram_runtime') continue;
        else {
          where = ' AND organization_id=$2';
          values.push(organizationId);
        }
      }
      const report = store.tables.find((row) => row.name === table.name);
      if (!report) throw Error('Recovery table report missing.');
      if (
        !whole &&
        policy.find((item) => item.name === table.name)?.mode !== 'restore' &&
        policy.find((item) => item.name === table.name)?.mode !== 'revoke'
      ) {
        const keys = table.primary.length ? table.primary : ['_rowid'];
        const keyOf = (row) =>
            JSON.stringify(
              keys.map((name) => String(name === '_rowid' ? row.__ordinal : row[name])),
            ),
          retained = new Set();
        for await (const row of readTypedRows(path.join(directory, report.file), table)) {
          retained.add(keyOf(row));
          const nonKeys = columns.filter((name) => !keys.includes(name)),
            params = [
              store.storeId,
              ...keys.map((name) => (name === '_rowid' ? row.__ordinal : row[name])),
            ];
          const identity =
            ' WHERE _store_id=$1 AND ' +
            keys.map((name, index) => q(name) + '=$' + (index + 2)).join(' AND ');
          let updated = { rowCount: 0 };
          if (nonKeys.length)
            updated = await client.query(
              'UPDATE ' +
                target +
                ' SET ' +
                nonKeys
                  .map((name, index) => q(name) + '=$' + (params.length + index + 1))
                  .join(',') +
                identity,
              [...params, ...nonKeys.map((name) => row[name])],
            );
          if (!updated.rowCount) {
            const inserted = [store.storeId, ...columns.map((name) => row[name])];
            await client.query(
              'INSERT INTO ' +
                target +
                '(' +
                ['_store_id', ...columns].map(q).join(',') +
                ') VALUES(' +
                inserted.map((_, index) => '$' + (index + 1)).join(',') +
                ')',
              inserted,
            );
          }
        }
        for await (const row of nativeRows(client, store, table))
          if (selected(table.name, row, organizationId, () => false) && !retained.has(keyOf(row))) {
            const params = [
              store.storeId,
              ...keys.map((name) => (name === '_rowid' ? row.__ordinal : row[name])),
            ];
            await client.query(
              'DELETE FROM ' +
                target +
                ' WHERE _store_id=$1 AND ' +
                keys.map((name, index) => q(name) + '=$' + (index + 2)).join(' AND '),
              params,
            );
          }
        continue;
      }
      await client.query('DELETE FROM ' + target + ' WHERE _store_id=$1' + where, values);
      const inserted = whole && !table.integerPrimaryKey ? [...columns, '_rowid'] : columns;
      let maxOrdinal = 0n;
      for await (const row of readTypedRows(path.join(directory, report.file), table)) {
        if (row.__ordinal > maxOrdinal) maxOrdinal = row.__ordinal;
        const params = [
          store.storeId,
          ...inserted.map((name) => (name === '_rowid' ? row.__ordinal : row[name])),
        ];
        await client.query(
          'INSERT INTO ' +
            target +
            '(' +
            ['_store_id', ...inserted].map(q).join(',') +
            ') VALUES(' +
            params.map((_, index) => '$' + (index + 1)).join(',') +
            ')',
          params,
        );
      }
      if (whole || table.integerPrimaryKey) {
        const ordinal = table.integerPrimaryKey || '_rowid',
          serial = (
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
            [serial, maxOrdinal.toString()],
          );
        }
      }
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    for (const table of modified)
      try {
        await client.query(
          'ALTER TABLE ' + qualify(store.kind, table.name) + ' ENABLE TRIGGER USER',
        );
      } catch (error) {
        if (error.code !== '25P02') throw error;
      }
  }
}
module.exports = {
  capture,
  inspectStore,
  readInventory,
  verifyInventory,
  photoIds,
  assetFingerprint,
  copyAssets,
  replaceRows,
  liveInterest,
  selected,
  names,
};
