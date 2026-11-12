'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { readRuntime, validateRuntimeProfile } = require('./runtime.cjs');
const { digest, identifier: q } = require('./catalog-sqlite.cjs');
const { canonicalSqliteSchema } = require('./catalog-canonical.cjs');
const { preparePostgresSchema, registerCanonicalTemplate } = require('./schema-prepare.cjs');
const { safeTree, readKey, plainFile } = require('../backup/snapshot.cjs');
const { codec } = require('../../migrations/prepare-cabinet-records.cjs');
const { patientProfile } = require('../cabinet-records.cjs');
const { validateState } = require('../../modules/cabinet/validation.cjs');
const { MARKER } = require('./assistant-prepare145.cjs');
const MAX_ROW_BYTES = 64 * 1024 * 1024;
const BATCH_BYTES = 1024 * 1024;
const scopeSQL =
  "SELECT set_config('cartoteca.kind','cabinet',true),set_config('cartoteca.store_id',$1,true)";
const metadataTables = ['objects', 'columns', 'indexes', 'index_columns'];
async function replaceCatalogs(client, ids, before, after) {
  const oldHash = digest(before),
    hash = digest(after);
  const result = await client.query(
    "UPDATE cartoteca_catalog.stores SET version=$1,catalog_hash=$2,metadata=$3,revision=revision+1 WHERE kind='cabinet' AND store_id=ANY($4::text[]) AND catalog_hash=$5 RETURNING store_id",
    [after.version, hash, after, ids, oldHash],
  );
  if (result.rows.length !== ids.length) throw Error('Cabinet preparation catalog CAS failed');
  for (const table of metadataTables)
    await client.query(
      'DELETE FROM cartoteca_catalog.' +
        q(table) +
        " WHERE kind='cabinet' AND store_id=ANY($1::text[])",
      [ids],
    );
  await client.query(
    `INSERT INTO cartoteca_catalog.objects SELECT 'cabinet',s,x.type,x.name,x.tbl_name,x.sql FROM unnest($1::text[]) s CROSS JOIN jsonb_to_recordset($2::jsonb->'objects') x(type text,name text,tbl_name text,sql text)`,
    [ids, after],
  );
  await client.query(
    `INSERT INTO cartoteca_catalog.columns SELECT 'cabinet',s,t.key,c.cid,c.name,c.type,c."notnull",c.dflt_value,c.pk FROM unnest($1::text[]) s CROSS JOIN jsonb_each($2::jsonb->'tables') t CROSS JOIN LATERAL jsonb_to_recordset(t.value->'columns') c(cid bigint,name text,type text,"notnull" bigint,dflt_value text,pk bigint)`,
    [ids, after],
  );
  await client.query(
    `INSERT INTO cartoteca_catalog.indexes SELECT 'cabinet',s,t.key,i.seq,i.name,i."unique",i.origin,i.partial FROM unnest($1::text[]) s CROSS JOIN jsonb_each($2::jsonb->'tables') t CROSS JOIN LATERAL jsonb_to_recordset(t.value->'indexes') i(seq bigint,name text,"unique" bigint,origin text,partial bigint)`,
    [ids, after],
  );
  await client.query(
    `INSERT INTO cartoteca_catalog.index_columns SELECT 'cabinet',s,i->>'name',c.seqno,c.cid,c.name,c."desc",c.coll,c."key" FROM unnest($1::text[]) s CROSS JOIN jsonb_each($2::jsonb->'tables') t CROSS JOIN LATERAL jsonb_array_elements(t.value->'indexes') i CROSS JOIN LATERAL jsonb_to_recordset(i->'columns') c(seqno bigint,cid bigint,name text,"desc" bigint,coll text,"key" bigint)`,
    [ids, after],
  );
}
function assertPatient(patient, id) {
  if (
    !patient ||
    patient.id !== id ||
    !Array.isArray(patient.visits) ||
    !Array.isArray(patient.appointments)
  )
    throw Error('Invalid canonical patient during cabinet preparation');
  validateState({ revision: 0, patients: [patient], services: [] });
}
async function recordsFor(client, storeId, patientId) {
  const probe = (
    await client.query(
      'SELECT count(*)::text AS n,coalesce(sum(octet_length(value)),0)::text AS bytes FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1 AND patient_id=$2',
      [storeId, patientId],
    )
  ).rows[0];
  if (Number(probe.bytes) > MAX_ROW_BYTES)
    throw Error('Cabinet preparation record bytes exceed its bounded operator window');
  const rows = (
    await client.query(
      'SELECT kind,id,patient_id,position,value FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1 AND patient_id=$2 ORDER BY kind,position',
      [storeId, patientId],
    )
  ).rows;
  if (rows.length !== Number(probe.n)) throw Error('Cabinet preparation record selection changed');
  return rows;
}
function hydrate(profile, rows, decode) {
  const patient = { ...profile, visits: [], appointments: [] };
  if ('visits' in profile || 'appointments' in profile)
    throw Error('Cabinet profile is not normalized');
  for (const row of rows) {
    const list =
      row.kind === 'visit'
        ? patient.visits
        : row.kind === 'appointment'
          ? patient.appointments
          : null;
    const value = decode(row.value);
    if (!list || Number(row.position) !== list.length || value?.id !== row.id)
      throw Error('Cabinet preparation record identity/order mismatch');
    list.push(value);
  }
  return patient;
}
async function migratePatient(client, storeId, row, crypto, rollback, totals) {
  let patient;
  if (rollback) {
    patient = hydrate(
      crypto.decode(row.value),
      await recordsFor(client, storeId, row.id),
      crypto.decode,
    );
    assertPatient(patient, row.id);
    const value = crypto.encode(patient);
    if (value.length > MAX_ROW_BYTES)
      throw Error('Current patient cannot fit the bounded schema1 inverse');
    const changed = await client.query(
      'UPDATE cartoteca_cabinet.patients SET value=$1 WHERE _store_id=$2 AND id=$3 AND value=$4',
      [value, storeId, row.id, row.value],
    );
    if (changed.rowCount !== 1) throw Error('Cabinet inverse patient CAS failed');
    await client.query(
      'DELETE FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1 AND patient_id=$2',
      [storeId, row.id],
    );
    const readback = (
      await client.query(
        'SELECT value FROM cartoteca_cabinet.patients WHERE _store_id=$1 AND id=$2',
        [storeId, row.id],
      )
    ).rows;
    if (readback.length !== 1 || !isDeepStrictEqual(crypto.decode(readback[0].value), patient))
      throw Error('Cabinet inverse content verification failed');
  } else {
    patient = crypto.decode(row.value);
    assertPatient(patient, row.id);
    const existing = (
      await client.query(
        'SELECT 1 FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1 AND patient_id=$2 LIMIT 1',
        [storeId, row.id],
      )
    ).rows;
    if (existing.length) throw Error('Unexpected normalized rows before cabinet preparation');
    let batch = [],
      bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      const inserted = await client.query(
        `INSERT INTO cartoteca_cabinet.cabinet_patient_records(_store_id,kind,id,patient_id,position,value) SELECT $1,x.kind,x.id,x.patient_id,x.position,decode(x.value,'base64') FROM jsonb_to_recordset($2::jsonb) x(kind text,id text,patient_id text,position bigint,value text)`,
        [storeId, JSON.stringify(batch)],
      );
      if (inserted.rowCount !== batch.length)
        throw Error('Cabinet record insertion count mismatch');
      batch = [];
      bytes = 0;
    };
    for (const [kind, collection] of [
      ['visit', 'visits'],
      ['appointment', 'appointments'],
    ])
      for (let position = 0; position < patient[collection].length; position++) {
        const value = crypto.encode(patient[collection][position]);
        if (value.length > MAX_ROW_BYTES)
          throw Error('Cabinet record exceeds bounded preparation window');
        if (bytes + value.length > BATCH_BYTES) await flush();
        batch.push({
          kind,
          id: patient[collection][position].id,
          patient_id: row.id,
          position,
          value: value.toString('base64'),
        });
        bytes += value.length;
        if (bytes >= BATCH_BYTES || batch.length >= 200) await flush();
      }
    await flush();
    const encoded = crypto.encode(patientProfile(patient));
    const changed = await client.query(
      'UPDATE cartoteca_cabinet.patients SET value=$1 WHERE _store_id=$2 AND id=$3 AND value=$4',
      [encoded, storeId, row.id, row.value],
    );
    if (changed.rowCount !== 1) throw Error('Cabinet preparation patient CAS failed');
    const readback = (
      await client.query(
        'SELECT value FROM cartoteca_cabinet.patients WHERE _store_id=$1 AND id=$2',
        [storeId, row.id],
      )
    ).rows;
    if (readback.length !== 1) throw Error('Cabinet preparation profile readback is missing');
    const restored = hydrate(
      crypto.decode(readback[0].value),
      await recordsFor(client, storeId, row.id),
      crypto.decode,
    );
    if (!isDeepStrictEqual(restored, patient))
      throw Error('Cabinet preparation content verification failed');
  }
  totals.patients++;
  totals.visits += patient.visits.length;
  totals.appointments += patient.appointments.length;
}
// Component only: the common offline145 operator owns maintenance guard, BEGIN,
// COMMIT and publication of its one runtime marker. No DATA copies or startup DDL.
async function preparePostgresCabinetRecords({
  client,
  directory,
  applicationRole,
  rollback = false,
  runtime: preparedRuntime,
} = {}) {
  directory = path.resolve(directory);
  safeTree(directory);
  const gate = path.join(directory, '.restore-in-progress');
  plainFile(gate);
  if (fs.readFileSync(gate, 'utf8') !== MARKER)
    throw Error('Cabinet preparation requires its explicit offline marker');
  const actualRuntime = readRuntime(directory),
    runtime = preparedRuntime ? validateRuntimeProfile(preparedRuntime) : actualRuntime,
    previous = rollback ? 2 : 1,
    target = rollback ? 1 : 2;
  if (
    preparedRuntime &&
    !isDeepStrictEqual(
      { ...runtime, cabinetTemplates: actualRuntime.cabinetTemplates },
      actualRuntime,
    )
  )
    throw Error('Cabinet preparation intermediate lineage differs');
  const authority = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  if (!(authority?.rolsuper || authority?.rolbypassrls))
    throw Error('Offline cabinet preparation requires operator authority');
  const { KEYS } = require('./lock-intents.cjs');
  const lock = BigInt.asUintN(64, BigInt(KEYS.maintenance));
  const held = (
    await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS owned",
      [String(lock >> 32n), String(lock & 0xffffffffn)],
    )
  ).rows[0]?.owned;
  if (!held) throw Error('Cabinet preparation requires the owning maintenance guard');
  const live = await client.query(
    'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE platform_store_id=$1 AND expires_at>clock_timestamp() LIMIT 1',
    [runtime.platformStoreId],
  );
  if (live.rows.length) throw Error('Cabinet preparation requires stopped process owners');
  await client.query('SAVEPOINT ct_cabinet_prepare145');
  try {
    const from = canonicalSqliteSchema({ kind: 'cabinet', version: previous });
    const to = canonicalSqliteSchema({ kind: 'cabinet', version: target });
    if (runtime.cabinetSchema !== previous && !(runtime.cabinetSchema === 0 && !rollback))
      throw Error('Cabinet preparation asset profile mismatch');
    const known = new Map(
      runtime.stores
        .filter((store) => store.kind === 'cabinet')
        .map((store) => [store.storeId, store.relativeDirectory]),
    );
    const organizations = (
      await client.query(
        'SELECT id FROM cartoteca_platform.organizations WHERE _store_id=$1 ORDER BY id',
        [runtime.platformStoreId],
      )
    ).rows;
    for (const { id } of organizations) if (!known.has(id)) known.set(id, 'tenants/' + id);
    const ids = [...known.keys()].sort();
    if (ids.length > 100000)
      throw Error('Cabinet preparation store count exceeds runtime lineage bound');
    // Auto0 is an asset selection mode, not proof of a physical schema0 store.
    // Validate every selected catalog before creating tables or changing any data.
    for (let offset = 0; offset < ids.length; offset += 200) {
      const scopes = (
        await client.query(
          "SELECT version,catalog_hash,metadata FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=ANY($1::text[]) FOR UPDATE",
          [ids.slice(offset, offset + 200)],
        )
      ).rows;
      for (const scope of scopes) {
        if (Number(scope.version) === 0)
          throw Object.assign(Error('Physical cabinet schema0 requires a separate preparation'), {
            code: 'CABINET_PREPARATION_SCHEMA0_UNSUPPORTED',
          });
        if (
          ![
            [previous, from],
            [target, to],
          ].some(
            ([version, catalog]) =>
              Number(scope.version) === version &&
              scope.catalog_hash === digest(catalog) &&
              isDeepStrictEqual(scope.metadata, catalog),
          )
        )
          throw Error('Cabinet preparation canonical catalog mismatch');
      }
    }
    if (!rollback)
      await preparePostgresSchema(client, {
        kind: 'cabinet',
        source: to,
        applicationRole,
        register: false,
      });
    else await registerCanonicalTemplate(client, { kind: 'cabinet', source: to });
    const totals = { stores: 0, patients: 0, visits: 0, appointments: 0, alreadyPreparedStores: 0 };
    for (let offset = 0; offset < ids.length; offset += 200) {
      const group = ids.slice(offset, offset + 200);
      const scopes = (
        await client.query(
          "SELECT store_id,version,catalog_hash,metadata FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=ANY($1::text[]) ORDER BY store_id FOR UPDATE",
          [group],
        )
      ).rows;
      const changedScopes = [];
      for (const scope of scopes) {
        if (
          Number(scope.version) === target &&
          scope.catalog_hash === digest(to) &&
          isDeepStrictEqual(scope.metadata, to)
        ) {
          totals.alreadyPreparedStores++;
          continue;
        }
        if (
          Number(scope.version) !== previous ||
          scope.catalog_hash !== digest(from) ||
          !isDeepStrictEqual(scope.metadata, from)
        )
          throw Error('Cabinet preparation canonical catalog mismatch');
        const folder = path.resolve(directory, known.get(scope.store_id));
        if (!folder.startsWith(directory + path.sep) && folder !== directory)
          throw Error('Cabinet preparation directory escapes root');
        safeTree(folder);
        const crypto = codec(readKey(path.join(folder, 'encryption.key')));
        await client.query(scopeSQL, [scope.store_id]);
        let cursor = null;
        for (;;) {
          const selected = (
            await client.query(
              'SELECT id,octet_length(value)::text AS bytes FROM cartoteca_cabinet.patients WHERE _store_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 1',
              [scope.store_id, cursor],
            )
          ).rows;
          if (!selected.length) break;
          if (Number(selected[0].bytes) > MAX_ROW_BYTES)
            throw Error('Cabinet patient exceeds bounded preparation window');
          const row = (
            await client.query(
              'SELECT id,value FROM cartoteca_cabinet.patients WHERE _store_id=$1 AND id=$2 FOR UPDATE',
              [scope.store_id, selected[0].id],
            )
          ).rows[0];
          if (!row) throw Error('Cabinet patient disappeared during offline preparation');
          await migratePatient(client, scope.store_id, row, crypto, rollback, totals);
          cursor = row.id;
        }
        totals.stores++;
        changedScopes.push(scope.store_id);
      }
      if (changedScopes.length) await replaceCatalogs(client, changedScopes, from, to);
    }
    const nextRuntime = {
      ...runtime,
      cabinetSchema: target,
      cabinetTemplates: { ...runtime.cabinetTemplates, [String(target)]: digest(to) },
      stores: runtime.stores.map((store) =>
        store.kind === 'cabinet' ? { ...store, schemaVersion: target } : store,
      ),
    };
    await client.query('RELEASE SAVEPOINT ct_cabinet_prepare145');
    return {
      runtime: nextRuntime,
      proof: {
        component: 'cabinet-records145',
        previous,
        target,
        ...totals,
        typedReadbackVerified: true,
        photosKeysAndRowsPreserved: true,
        currentDataInverse: rollback,
        dataCopiesCreated: 0,
        runtimePublicationRequired: true,
      },
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ct_cabinet_prepare145');
      await client.query('RELEASE SAVEPOINT ct_cabinet_prepare145');
    } catch {
      error.outcomeUnknown = true;
      error.channelPoisoned = true;
    }
    throw error;
  }
}
module.exports = { preparePostgresCabinetRecords, replaceCatalogs, MAX_ROW_BYTES };
