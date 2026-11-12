// Optional component inside the package145 offline transaction. No COMMIT/files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { readRuntime, validateRuntimeProfile } = require('./runtime.cjs');
const { canonicalSqliteSchema } = require('./catalog-canonical.cjs');
const { digest, identifier: q } = require('./catalog-sqlite.cjs');
const { preparePostgresSchema, registerCanonicalTemplate } = require('./schema-prepare.cjs');
const { safeTree, plainFile, readKey } = require('../backup/snapshot.cjs');
const { codec } = require('../../migrations/prepare-cabinet-records.cjs');
const { validateState } = require('../../modules/cabinet/validation.cjs');
const { historyRows } = require('../cabinet-history-index145.cjs');
const { MARKER } = require('./assistant-prepare145.cjs');
const { KEYS } = require('./lock-intents.cjs');
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

async function authority(client, directory, runtime) {
  safeTree(directory);
  const gate = path.join(directory, '.restore-in-progress');
  plainFile(gate);
  if (fs.readFileSync(gate, 'utf8') !== MARKER)
    throw Error('History preparation requires its offline marker');
  const actual = readRuntime(directory);
  validateRuntimeProfile(runtime);
  if (
    runtime.migrationId !== actual.migrationId ||
    runtime.platformStoreId !== actual.platformStoreId ||
    runtime.rootCabinetStoreId !== actual.rootCabinetStoreId ||
    runtime.cabinetSchema !== 2
  )
    throw Error('History preparation lineage mismatch');
  const mapping = ({ cabinetSchema, cabinetTemplates, stores, ...rest }) => ({
    ...rest,
    stores: stores.map(({ schemaVersion, ...store }) => store),
  });
  if (
    !isDeepStrictEqual(mapping(runtime), mapping(actual)) ||
    runtime.stores.some(
      (s, i) => s.schemaVersion !== (s.kind === 'cabinet' ? 2 : actual.stores[i].schemaVersion),
    ) ||
    runtime.cabinetTemplates['1'] !== actual.cabinetTemplates['1']
  )
    throw Error('History preparation asset mapping changed');
  const role = (
    await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  const lock = BigInt.asUintN(64, BigInt(KEYS.maintenance));
  const held = (
    await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS owned",
      [String(lock >> 32n), String(lock & 0xffffffffn)],
    )
  ).rows[0]?.owned;
  if (!(role?.rolsuper || role?.rolbypassrls) || !held)
    throw Error('History preparation requires owning offline authority');
  if (
    (
      await client.query(
        'SELECT 1 FROM cartoteca_catalog.process_role_leases WHERE platform_store_id=$1 AND expires_at>clock_timestamp() LIMIT 1',
        [runtime.platformStoreId],
      )
    ).rows.length
  )
    throw Error('History preparation requires stopped process owners');
}
async function fillPatient(client, storeId, patientRow, ciphers) {
  const totals = (
    await client.query(
      'SELECT count(*)::text AS n,coalesce(sum(octet_length(value)),0)::text AS bytes FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1 AND patient_id=$2',
      [storeId, patientRow.id],
    )
  ).rows[0];
  if (Number(totals.n) > 20000 || Number(totals.bytes) + patientRow.value.length > 64 * 1024 * 1024)
    throw Error('History preparation patient exceeds the existing canonical bound');
  const rows = (
    await client.query(
      'SELECT kind,id,patient_id,position,value FROM cartoteca_cabinet.cabinet_patient_records WHERE _store_id=$1 AND patient_id=$2 ORDER BY kind,position',
      [storeId, patientRow.id],
    )
  ).rows.map((row) => ({ ...row, position: Number(row.position) }));
  const patient = { ...ciphers.decode(patientRow.value), visits: [], appointments: [] };
  if (patient.id !== patientRow.id) throw Error('History preparation profile mismatch');
  for (const row of rows) {
    const list =
      row.kind === 'visit'
        ? patient.visits
        : row.kind === 'appointment'
          ? patient.appointments
          : null;
    const value = ciphers.decode(row.value);
    if (!list || row.position !== list.length || !value || value.id !== row.id)
      throw Error('History preparation canonical order mismatch');
    list.push(value);
  }
  validateState({ revision: 0, patients: [patient], services: [] });
  const entries = [],
    manifests = [];
  const flush = async () => {
    if (entries.length)
      await client.query(
        'INSERT INTO cartoteca_cabinet.cabinet_history_entries(_store_id,patient_id,audience,stream,rank,kind,id,position,source_hash) SELECT $1,x.patient_id,x.audience,x.stream,x.rank,x.kind,x.id,x.position,x.source_hash FROM jsonb_to_recordset($2::jsonb) x(patient_id text,audience text,stream text,rank bigint,kind text,id text,position bigint,source_hash text)',
        [storeId, JSON.stringify(entries)],
      );
    if (manifests.length)
      await client.query(
        "INSERT INTO cartoteca_cabinet.cabinet_history_manifests(_store_id,patient_id,audience,stream,witness_kind,witness_id,value) SELECT $1,x.patient_id,x.audience,x.stream,x.witness_kind,x.witness_id,decode(x.value,'base64') FROM jsonb_to_recordset($2::jsonb) x(patient_id text,audience text,stream text,witness_kind text,witness_id text,value text)",
        [storeId, JSON.stringify(manifests)],
      );
    entries.length = 0;
    manifests.length = 0;
  };
  for (const row of historyRows(patient, rows, patientRow.value, ciphers)) {
    if (row.table === 'cabinet_history_entries') {
      const [patient_id, audience, stream, rank, kind, id, position, source_hash] = row.args;
      entries.push({ patient_id, audience, stream, rank, kind, id, position, source_hash });
    } else {
      const [patient_id, audience, stream, witness_kind, witness_id, value] = row.args;
      manifests.push({
        patient_id,
        audience,
        stream,
        witness_kind,
        witness_id,
        value: value.toString('base64'),
      });
    }
    if (entries.length + manifests.length === 200) await flush();
  }
  await flush();
  return { visits: patient.visits.length, appointments: patient.appointments.length };
}
async function preparePostgresPatientHistory({
  client,
  directory,
  applicationRole,
  runtime,
  rollback = false,
}) {
  directory = path.resolve(directory);
  await authority(client, directory, runtime);
  const baseline = canonicalSqliteSchema({ kind: 'cabinet', version: 2 });
  const prepared = canonicalSqliteSchema({
    kind: 'cabinet',
    version: 2,
    components: { patientHistory: true },
  });
  const from = rollback ? prepared : baseline,
    to = rollback ? baseline : prepared;
  await client.query('SAVEPOINT ct_history_prepare145');
  try {
    if (!rollback)
      await preparePostgresSchema(client, {
        kind: 'cabinet',
        source: to,
        applicationRole,
        register: false,
      });
    else await registerCanonicalTemplate(client, { kind: 'cabinet', source: to });
    const known = new Map(
      runtime.stores
        .filter((s) => s.kind === 'cabinet')
        .map((s) => [s.storeId, s.relativeDirectory]),
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
      throw Error('History preparation store count exceeds runtime lineage bound');
    const scopes = [];
    for (let offset = 0; offset < ids.length; offset += 200)
      scopes.push(
        ...(
          await client.query(
            "SELECT store_id,version,catalog_hash,metadata FROM cartoteca_catalog.stores WHERE kind='cabinet' AND store_id=ANY($1::text[]) ORDER BY store_id FOR UPDATE",
            [ids.slice(offset, offset + 200)],
          )
        ).rows,
      );
    const totals = { stores: 0, patients: 0, visits: 0, appointments: 0, alreadyPreparedStores: 0 };
    for (const scope of scopes) {
      if (scope.catalog_hash === digest(to) && isDeepStrictEqual(scope.metadata, to)) {
        totals.alreadyPreparedStores++;
        continue;
      }
      if (
        Number(scope.version) !== 2 ||
        scope.catalog_hash !== digest(from) ||
        !isDeepStrictEqual(scope.metadata, from)
      )
        throw Error('History preparation catalog mismatch');
      await client.query(
        "SELECT set_config('cartoteca.kind','cabinet',true),set_config('cartoteca.store_id',$1,true)",
        [scope.store_id],
      );
      if (rollback) {
        await client.query(
          'DELETE FROM cartoteca_cabinet.cabinet_history_entries WHERE _store_id=$1',
          [scope.store_id],
        );
        await client.query(
          'DELETE FROM cartoteca_cabinet.cabinet_history_manifests WHERE _store_id=$1',
          [scope.store_id],
        );
      } else {
        const relative = known.get(scope.store_id) || 'tenants/' + scope.store_id;
        const folder = path.resolve(directory, relative);
        if (folder !== directory && !folder.startsWith(directory + path.sep))
          throw Error('History preparation path escapes DATA');
        safeTree(folder);
        const key = readKey(path.join(folder, 'encryption.key'));
        const ciphers = {
          ...codec(key),
          hash: (v) => crypto.createHmac('sha256', key).update(v).digest('hex'),
        };
        let cursor = null;
        for (;;) {
          const rows = (
            await client.query(
              'SELECT id,value FROM cartoteca_cabinet.patients WHERE _store_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 1 FOR UPDATE',
              [scope.store_id, cursor],
            )
          ).rows;
          if (!rows.length) break;
          const counts = await fillPatient(client, scope.store_id, rows[0], ciphers);
          totals.patients++;
          totals.visits += counts.visits;
          totals.appointments += counts.appointments;
          cursor = rows[0].id;
        }
      }
      await replaceCatalogs(client, [scope.store_id], from, to);
      totals.stores++;
    }
    const next = { ...runtime, cabinetTemplates: { ...runtime.cabinetTemplates, 2: digest(to) } };
    await client.query('RELEASE SAVEPOINT ct_history_prepare145');
    return {
      runtime: next,
      proof: {
        component: 'patient-history145',
        ...totals,
        currentDataInverse: rollback,
        canonicalRowsUnchanged: true,
        noPlaintextDatesOrStaff: true,
        dataCopiesCreated: 0,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT ct_history_prepare145').catch(() => {});
    await client.query('RELEASE SAVEPOINT ct_history_prepare145').catch(() => {});
    throw error;
  }
}
module.exports = { preparePostgresPatientHistory };
