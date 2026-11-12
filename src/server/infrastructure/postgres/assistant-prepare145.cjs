// Explicit offline PG component transition; never called during an HTTP request.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readRuntime } = require('./runtime.cjs');
const { canonicalSqliteSchema } = require('./catalog-canonical.cjs');
const { digest, identifier: q } = require('./catalog-sqlite.cjs');
const { preparePostgresSchema } = require('./schema-prepare.cjs');
const { copyStoreRows } = require('./migration-rows.cjs');
const { KEYS } = require('./lock-intents.cjs');
const { assistantContext } = require('../backup/assistant-state.cjs');
const { safeTree, plainFile, readKey } = require('../backup/snapshot.cjs');
const { syncFile, syncDirectory } = require('../backup/durable.cjs');
const rows = require('../../modules/assistant/access/row-schema.cjs');
const repository = require('../../modules/assistant/access/row-store.cjs');
const { initialState, validateState } = require('../../modules/assistant/access/defaults.cjs');
const {
  readStateBytes,
  MAX_BYTES,
  stateName,
} = require('../../modules/assistant/access/state-file.cjs');
const sentinel = require('../../modules/assistant/access/row-sentinel.cjs');
const MARKER = 'package145-offline-v1';
const names = new Set(['assistant_state_schema', ...rows.tables]);
function replaceState(directory, bytes) {
  if (bytes.length > MAX_BYTES) throw Error('Assistant state exceeds legacy boundary');
  const file = path.join(directory, stateName),
    tmp = path.join(directory, '.assistant-prepare-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
    syncFile(tmp);
    fs.renameSync(tmp, file);
    syncDirectory(directory);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
async function replaceCatalog(client, storeId, before, after) {
  const current = (
    await client.query(
      "SELECT catalog_hash FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
      [storeId],
    )
  ).rows;
  if (current.length !== 1 || current[0].catalog_hash !== digest(before))
    throw Error('Assistant preparation catalog changed');
  // Only component metadata changes. Business version, other objects and rows remain untouched.
  for (const table of ['index_columns', 'indexes', 'columns'])
    await client.query(
      'DELETE FROM cartoteca_catalog.' +
        q(table) +
        " WHERE kind='platform' AND store_id=$1 AND " +
        (table === 'index_columns' ? 'index_name' : 'table_name') +
        " LIKE 'assistant\\_%' ESCAPE '\\'",
      [storeId],
    );
  await client.query(
    "DELETE FROM cartoteca_catalog.objects WHERE kind='platform' AND store_id=$1 AND tbl_name LIKE 'assistant\\_%' ESCAPE '\\'",
    [storeId],
  );
  for (const row of after.objects.filter((x) => names.has(x.tbl_name)))
    await client.query('INSERT INTO cartoteca_catalog.objects VALUES($1,$2,$3,$4,$5,$6)', [
      'platform',
      storeId,
      row.type,
      row.name,
      row.tbl_name,
      row.sql,
    ]);
  for (const table of Object.values(after.tables).filter((x) => names.has(x.name))) {
    for (const c of table.columns)
      await client.query(
        'INSERT INTO cartoteca_catalog.columns VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        ['platform', storeId, table.name, c.cid, c.name, c.type, c.notnull, c.dflt_value, c.pk],
      );
    for (const i of table.indexes) {
      await client.query('INSERT INTO cartoteca_catalog.indexes VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [
        'platform',
        storeId,
        table.name,
        i.seq,
        i.name,
        i.unique,
        i.origin,
        i.partial,
      ]);
      for (const c of i.columns)
        await client.query(
          'INSERT INTO cartoteca_catalog.index_columns VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          ['platform', storeId, i.name, c.seqno, c.cid, c.name, c.desc, c.coll, c.key],
        );
    }
  }
  await client.query(
    "UPDATE cartoteca_catalog.stores SET catalog_hash=$1,metadata=$2 WHERE kind='platform' AND store_id=$3",
    [digest(after), after, storeId],
  );
}
function legacyMemory(key, directory, source) {
  const db = new DatabaseSync(':memory:');
  // This memory-only codec staging contains no business tables; authoritative
  // foreign keys remain enforced by PostgreSQL when copied below.
  db.exec(
    'PRAGMA user_version=19;PRAGMA foreign_keys=OFF;CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE accounts(id TEXT PRIMARY KEY);' +
      rows.schema,
  );
  const context = assistantContext(db, key, directory);
  if (source) {
    db.exec('BEGIN IMMEDIATE');
    repository.importRows(context, source.state, { sourceHash: source.hash });
    db.exec('COMMIT');
  }
  return { db, context };
}
async function acquireOfflinePreparation145({ client, directory }) {
  directory = path.resolve(directory);
  safeTree(directory);
  const gate = path.join(directory, '.restore-in-progress');
  plainFile(gate);
  if (fs.readFileSync(gate, 'utf8') !== MARKER)
    throw Error('Assistant preparation requires its explicit offline marker');
  const runtime = readRuntime(directory);
  const owned = (
    await client.query('SELECT pg_try_advisory_lock($1::bigint) AS owned', [KEYS.maintenance])
  ).rows[0]?.owned;
  if (!owned) throw Error('Assistant preparation requires stopped database work');
  try {
    const live = await client.query(
      'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE platform_store_id=$1 AND expires_at>clock_timestamp() LIMIT 1',
      [runtime.platformStoreId],
    );
    if (live.rows.length) throw Error('Assistant preparation requires closed process owners');
    return {
      runtime,
      release: () => client.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.maintenance]),
    };
  } catch (error) {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.maintenance]);
    throw error;
  }
}
async function preparePostgresAssistantRows({
  client,
  directory,
  applicationRole,
  rollback = false,
  transactionOwned = false,
} = {}) {
  directory = path.resolve(directory);
  safeTree(directory);
  const gate = path.join(directory, '.restore-in-progress');
  plainFile(gate);
  if (fs.readFileSync(gate, 'utf8') !== MARKER)
    throw Error('Assistant preparation requires its explicit offline marker');
  const runtime = readRuntime(directory),
    platform = path.join(directory, 'platform');
  safeTree(platform);
  const key = readKey(path.join(platform, 'platform.key'));
  const bytes = readStateBytes(platform),
    hash = createHash('sha256')
      .update(bytes || Buffer.alloc(0))
      .digest('hex');
  const offline = transactionOwned
    ? null
    : await acquireOfflinePreparation145({ client, directory });
  const lock = BigInt.asUintN(64, BigInt(KEYS.maintenance));
  const owned = (
    await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS owned",
      [String(lock >> 32n), String(lock & 0xffffffffn)],
    )
  ).rows[0]?.owned;
  if (!owned) throw Error('Caller does not own the offline maintenance guard');
  let transaction = false,
    savepoint = false,
    memory;
  try {
    if (!transactionOwned) {
      await client.query('BEGIN');
      transaction = true;
    } else {
      await client.query('SAVEPOINT assistant_component145');
      savepoint = true;
    }
    const live = await client.query(
      'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE platform_store_id=$1 AND expires_at>clock_timestamp() LIMIT 1',
      [runtime.platformStoreId],
    );
    if (live.rows.length) throw Error('Assistant preparation requires closed process owners');
    const result = (
      await client.query(
        "SELECT metadata,catalog_hash FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1 FOR UPDATE",
        [runtime.platformStoreId],
      )
    ).rows;
    if (result.length !== 1 || digest(result[0].metadata) !== result[0].catalog_hash)
      throw Error('Assistant preparation catalog is invalid');
    const before = result[0].metadata;
    await client.query(
      "SELECT set_config('cartoteca.kind','platform',true),set_config('cartoteca.store_id',$1,true)",
      [runtime.platformStoreId],
    );
    let output, receipt;
    if (rollback) {
      if (!before.tables.assistant_state_schema) throw Error('Assistant rows are not prepared');
      memory = legacyMemory(key, platform);
      for (const name of names) {
        const cols = before.tables[name].columns;
        const values = (
          await client.query(
            'SELECT ' +
              cols.map((c) => q(c.name)).join(',') +
              ' FROM cartoteca_platform.' +
              q(name) +
              ' WHERE _store_id=$1',
            [runtime.platformStoreId],
          )
        ).rows;
        const insert = memory.db.prepare(
          'INSERT INTO ' + q(name) + ' VALUES(' + cols.map(() => '?').join(',') + ')',
        );
        for (const row of values)
          insert.run(
            ...cols.map((c) => (c.type === 'INTEGER' ? Number(row[c.name]) : row[c.name])),
          );
      }
      const state = repository
        .createAssistantRowStore(memory.context, { directory: platform })
        .exportLegacyState();
      output = memory.context.seal(validateState(state));
      if (output.length > MAX_BYTES)
        throw Error('Current assistant rows cannot fit legacy file; rollback denied');
      const after = structuredClone(before);
      after.objects = after.objects.filter((x) => !names.has(x.tbl_name));
      for (const n of names) delete after.tables[n];
      // Per-store inverse only: physical union tables may belong to another prepared store.
      for (const name of [...names].reverse())
        await client.query('DELETE FROM cartoteca_platform.' + q(name) + ' WHERE _store_id=$1', [
          runtime.platformStoreId,
        ]);
      await replaceCatalog(client, runtime.platformStoreId, before, after);
      receipt = { backend: 'file', exportedRevision: state.revision, currentStateInverse: true };
    } else if (before.tables.assistant_state_schema) {
      // An operator may reconcile an unknown COMMIT; never blindly import or repeat provider work.
      const registration = (
        await client.query(
          'SELECT * FROM cartoteca_platform.assistant_state_schema WHERE _store_id=$1',
          [runtime.platformStoreId],
        )
      ).rows;
      if (registration.length !== 1) throw Error('Assistant preparation registration is invalid');
      memory = legacyMemory(key, platform);
      const r = registration[0];
      const expected = sentinel.createSentinel(r);
      if (
        r.import_sha256 !== hash &&
        (!bytes || JSON.stringify(memory.context.open(bytes)) !== JSON.stringify(expected))
      )
        throw Error('Assistant preparation source differs after committed import');
      output = memory.context.seal(expected);
      receipt = { backend: 'rows-v1', reconciledExisting: true };
    } else {
      memory = legacyMemory(key, platform);
      const state = bytes ? validateState(memory.context.open(bytes)) : initialState();
      memory.db.close();
      memory = null;
      memory = legacyMemory(key, platform, { state, hash });
      const canonical = canonicalSqliteSchema({
        kind: 'platform',
        version: before.version,
        components: { assistantRows: true },
      });
      const after = structuredClone(before);
      after.objects.push(...canonical.objects.filter((x) => names.has(x.tbl_name)));
      for (const n of names) after.tables[n] = canonical.tables[n];
      await preparePostgresSchema(client, {
        kind: 'platform',
        storeId: runtime.platformStoreId,
        source: after,
        applicationRole,
        register: false,
      });
      await replaceCatalog(client, runtime.platformStoreId, before, after);
      const subset = {
        ...after,
        tables: Object.fromEntries([...names].map((n) => [n, after.tables[n]])),
      };
      const copied = await copyStoreRows(client, {
        sqlite: memory.db,
        kind: 'platform',
        storeId: runtime.platformStoreId,
        source: subset,
      });
      const registration = rows.validate(memory.db, { required: true });
      repository.validateSnapshot(memory.context, registration);
      output = sentinel.sealSentinel(memory.context, registration);
      receipt = {
        backend: 'rows-v1',
        sourceSha256: hash,
        importedRevision: state.revision,
        componentVersion: 1,
        rows: copied,
      };
    }
    // The operator-owned durable marker remains across COMMIT/file replacement, failures and reconciliation.
    const unchanged = () => {
      const current = readStateBytes(platform);
      return (
        createHash('sha256')
          .update(current || Buffer.alloc(0))
          .digest('hex') === hash
      );
    };
    if (!unchanged()) throw Error('Assistant source changed during preparation');
    const proof = {
      ...receipt,
      platformStoreId: runtime.platformStoreId,
      markerRetained: true,
      businessSchema: before.version,
    };
    let published = false;
    const publishFile = () => {
      if (published) return;
      const current = readStateBytes(platform);
      if (!unchanged() && !(current && current.equals(output)))
        throw Error('Assistant source changed before publication');
      replaceState(platform, output);
      published = true;
    };
    if (transactionOwned) {
      await client.query('RELEASE SAVEPOINT assistant_component145');
      savepoint = false;
      return { proof, publishFile };
    }
    await client.query('COMMIT');
    transaction = false;
    publishFile();
    return proof;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    else if (savepoint) {
      await client.query('ROLLBACK TO SAVEPOINT assistant_component145').catch(() => {});
      await client.query('RELEASE SAVEPOINT assistant_component145').catch(() => {});
    }
    throw error;
  } finally {
    if (memory?.db.isOpen) memory.db.close();
    if (offline) await offline.release();
  }
}
module.exports = { preparePostgresAssistantRows, acquireOfflinePreparation145, MARKER };
