const { Client, Query } = require('pg');
const { randomUUID } = require('node:crypto');
const { serverConnection } = require('./connection.cjs');
const { digest, identifier, namespace } = require('./catalog-sqlite.cjs');
const { readRuntime } = require('./runtime.cjs');
const { lockPlan } = require('./lock-intents.cjs');
const { runLockBatch } = require('./transaction-locks.cjs');
const { createPreparedQueries } = require('./prepared-query141.cjs');
const { createOperationRows, operationRows } = require('./read-operation-rows145.cjs');
const { sourceProbe, sourceWitness } = require('./read-source-probe152.cjs');
const { viewQuery } = require('./read-view-queries152.cjs');
const { authorityQuery } = require('./read-session152.cjs');
const {
  platformGuard167,
  fenceRow167,
  catalogRow167,
  scopeRows167,
} = require('./read-phase-guards167.cjs');
const { finishRead167 } = require('./read-phase-tail167.cjs');
const { resultCacheKey } = require('./read-result-cache153.cjs');
const { typedReadBatch, createTypedReadResults } = require('./read-operation-batch151.cjs');
const { lexReadonly, identifier: tokenIdentifier } = require('./dialect-lexer.cjs');
const SMALL_DECODE_BYTES = 64 * 1024 * 1024;
const MAX_CIPHER_BYTES = 128 * 1024 * 1024;
const MAX_RESULT_ROWS = 2000000;
const denied = (code) => Object.assign(Error(code), { code, status: 503 });
const scopeKey = (scope) => scope.kind + ':' + scope.storeId;
// Owns one physical asynchronous connection. Fixed owner-pool leases keep all
// authority and RR state on this client; shared caches contain no client state.
async function createReadOperationClient(
  config,
  {
    createClient = (options) => new Client(options),
    resultCache = null,
    cacheEpoch166 = null,
  } = {},
) {
  if (cacheEpoch166 !== null && !/^[a-f0-9-]{36}$/.test(cacheEpoch166))
    throw denied('POSTGRES_READ_CACHE_EPOCH166');
  const marker = readRuntime(config.dataDir),
    markerHash = digest(marker);
  const connection = await serverConnection(config.postgres, {
    profile: config.postgresProfile || 'local',
    allowedHosts: config.postgresAllowedHosts,
    pin: config.postgresPin,
  });
  const client = createClient({
    ...connection,
    pipeline: true,
    connectionTimeoutMillis: 5000,
  });
  const prepared = createPreparedQueries(),
    catalogs = new Map(),
    epoch = cacheEpoch166 || randomUUID(),
    storeVersions = new Map(
      marker.stores.map((store) => [store.kind + ':' + store.storeId, store.schemaVersion]),
    );
  let platformTemplate,
    readScopes163,
    directory164,
    directoryState196,
    hotQuery169,
    hotQuery196,
    patientQuery197;
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  freeze(marker);
  let calls = 0,
    busy = false,
    closed = false,
    poisoned = false,
    currentScope = null,
    closing;
  client.on('error', () => {
    poisoned = true;
  });
  async function sql(text, values = []) {
    if (closed || poisoned) throw denied('POSTGRES_READ_OPERATION_CLOSED');
    calls++;
    return client.query(prepared(text, values));
  }
  async function setScope(scope) {
    const key = scopeKey(scope);
    if (key === currentScope) return;
    await sql(
      "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
      [scope.kind, scope.storeId],
    );
    currentScope = key;
  }
  try {
    await client.connect();
    await sql("SET statement_timeout='4750ms'; SET lock_timeout='4500ms'");
    for (const kind of ['platform', 'cabinet'])
      await require('./catalog-postgres.cjs').validatePostgresSchema(client, {
        kind,
        applicationRole: client.user,
      });
    if ((await require('./revision-profile132.cjs').readRevisionProfile(client, client.user)) !== 3)
      throw denied('POSTGRES_REVISION_PROFILE_INVALID');
    readScopes163 = await require('./read-scope-schema163.cjs').verifyReadScopes163(
      client,
      client.user,
    );
    directory164 = await require('./directory-component164.cjs').verifyDirectory164(
      client,
      client.user,
    );
    directoryState196 = await require('./directory-state-schema196.cjs').verifyDirectoryState196(
      client,
      client.user,
    );
    await setScope({ kind: 'platform', storeId: marker.platformStoreId });
    const profile = await sql(
      "SELECT migration_id,marker_hash FROM cartoteca_catalog.asset_profiles WHERE kind='platform' AND store_id=$1",
      [marker.platformStoreId],
    );
    if (
      profile.rows.length !== 1 ||
      profile.rows[0].migration_id !== marker.migrationId ||
      profile.rows[0].marker_hash !== markerHash
    )
      throw denied('POSTGRES_ASSET_LINEAGE_MISMATCH');
    const templates = await sql(
      'SELECT kind,version,metadata,catalog_hash FROM cartoteca_catalog.templates WHERE kind IN ($1,$2)',
      ['platform', 'cabinet'],
    );
    for (const row of templates.rows) {
      if (
        digest(row.metadata) !== row.catalog_hash ||
        Number(row.metadata.version) !== Number(row.version)
      )
        throw denied('POSTGRES_CATALOG_INVALID');
      catalogs.set(row.kind + ':' + Number(row.version) + ':' + row.catalog_hash, {
        metadata: freeze(row.metadata),
        hash: row.catalog_hash,
      });
    }
    const platformStore = await sql(
      "SELECT version,catalog_hash FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
      [marker.platformStoreId],
    );
    const row = platformStore.rows[0];
    platformTemplate =
      row && catalogs.get('platform:' + Number(row.version) + ':' + row.catalog_hash);
    if (!platformTemplate) throw denied('POSTGRES_CATALOG_INVALID');
    const hotCapability169 = await require('./hot-metadata-component169.cjs').verifyHotMetadata169(
      client,
      client.user,
      { marker },
    );
    if (hotCapability169?.eligibleMarker)
      hotQuery169 = require('./hot-metadata-query169.cjs').createHotMetadataQuery169({
        marker,
        capability: hotCapability169,
        platformTemplate: {
          version: platformTemplate.metadata.version,
          hash: platformTemplate.hash,
        },
      });
    if (hotCapability169?.eligibleMarker && directoryState196)
      hotQuery196 = require('./hot-directory-query196.cjs').createHotDirectoryQuery196({
        marker,
        capability: hotCapability169,
        directoryState196,
        platformTemplate: {
          version: platformTemplate.metadata.version,
          hash: platformTemplate.hash,
        },
      });
    const patientCapability197 =
      await require('./patient-capsule-schema197.cjs').verifyPatientCapsule197(client, client.user);
    if (patientCapability197)
      patientQuery197 = require('./patient-capsule-query197.cjs').createPatientCapsuleQuery197({
        marker,
        capability: patientCapability197,
        platformTemplate,
      });
    const catalogImage199 = await require('./catalog-image-schema199.cjs').verifyCatalogImage199(
      client,
      client.user,
      {
        marker,
        parents: {
          hotMetadata169: hotCapability169,
          directory196: directoryState196,
          patient197: patientCapability197,
        },
      },
    );
    const { wrapCatalogImageQuery199 } = require('./catalog-image-query199.cjs');
    if (hotQuery169)
      hotQuery169 = wrapCatalogImageQuery199(hotQuery169, catalogImage199, 'metadata169');
    if (hotQuery196)
      hotQuery196 = wrapCatalogImageQuery199(hotQuery196, catalogImage199, 'directory196');
    if (patientQuery197)
      patientQuery197 = wrapCatalogImageQuery199(patientQuery197, catalogImage199, 'patient197');
    await require('./catalog-image-prime199.cjs').primeCatalogImage199({
      sql,
      marker,
      capability: catalogImage199,
      queries: { metadata169: hotQuery169, directory196: hotQuery196, patient197: patientQuery197 },
    });
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  async function run(
    {
      scope,
      assertActive,
      requestMemoryClass,
      probeClass,
      deferCatalog = false,
      platformOnly = false,
      capturePlatformClocks167 = false,
      finish167 = null,
      patientCapsule197 = null,
    },
    callback,
  ) {
    if (busy || closed || poisoned) throw denied('POSTGRES_READ_OPERATION_UNAVAILABLE');
    if (
      typeof capturePlatformClocks167 !== 'boolean' ||
      (finish167 !== null &&
        (typeof finish167.token !== 'string' || typeof finish167.accept !== 'function'))
    )
      throw denied('POSTGRES_READ_OPERATION_CONTEXT');
    busy = true;
    const platform = { kind: 'platform', storeId: marker.platformStoreId };
    const locks = lockPlan(platform, 'READONLY', false),
      acquired = [],
      probedTables = new Set(),
      attestedScopes = new Set(),
      unsupportedStore = {},
      proofSources = new Map(),
      cacheCandidates = new Map(),
      capturedScopes163 = new Map(),
      afterCommit165 = [],
      directoryCohorts189 = new WeakMap();
    let directoryPreview189 = null;
    let patientPacket197 = null,
      patientBound197 = null;
    let patientSources197 = null,
      patientProbeReused197 = false;
    const expectedVersion = storeVersions.get(scopeKey(scope)) || marker.cabinetSchema || 1;
    const cabinetTemplate = catalogs.get(
      'cabinet:' + expectedVersion + ':' + marker.cabinetTemplates[String(expectedVersion)],
    );
    if (deferCatalog && !platformOnly && !cabinetTemplate) {
      busy = false;
      return { unsupported: 'unprepared-store' };
    }
    let transaction = false,
      active = true,
      retainedBytes = 0,
      retainedRows = 0,
      materializer,
      snapshot;
    let probeCompleted = false,
      upgraded = false,
      operationByteLimit = MAX_CIPHER_BYTES,
      operationRowLimit = MAX_RESULT_ROWS;
    function check() {
      assertActive();
      if (!active || poisoned || closed) throw denied('POSTGRES_READ_OPERATION_CLOSED');
    }
    async function guardedSql(text, values) {
      check();
      try {
        const result = await sql(text, values);
        check();
        return result;
      } catch (error) {
        active = false;
        throw error;
      }
    }
    async function selectScope(selected) {
      try {
        await setScope(selected);
      } catch (error) {
        active = false;
        throw error;
      }
    }
    async function lock(locks, purpose) {
      try {
        return await runLockBatch(
          {
            query: async (text, values) => {
              const result = await sql(
                purpose === 'transaction' && deferCatalog
                  ? 'SELECT locked,pg_current_snapshot()::text AS snapshot FROM (' +
                      text +
                      ') ct_fence'
                  : text,
                values,
              );
              if (purpose === 'transaction' && deferCatalog) snapshot = result.rows[0]?.snapshot;
              return result;
            },
          },
          locks,
          purpose,
        );
      } catch (error) {
        poisoned = true;
        throw error;
      }
    }
    async function settle(promises) {
      const results = await Promise.allSettled(promises);
      const first = results.find((result) => result.status === 'rejected');
      if (first) {
        active = false;
        throw first.reason;
      }
      return results.map((result) => result.value);
    }
    async function catalogFor(selected) {
      await selectScope(selected);
      const found = await guardedSql(
        'SELECT s.version,s.catalog_hash,s.metadata=t.metadata AS catalog_matches,pg_current_snapshot()::text AS snapshot FROM cartoteca_catalog.stores s JOIN cartoteca_catalog.templates t ON t.kind=s.kind AND t.version=s.version AND t.catalog_hash=s.catalog_hash WHERE s.kind=$1 AND s.store_id=$2',
        [selected.kind, selected.storeId],
      );
      if (found.rows.length !== 1) return null;
      const version = Number(found.rows[0].version),
        template = catalogs.get(selected.kind + ':' + version + ':' + found.rows[0].catalog_hash);
      if (
        !template ||
        found.rows[0].catalog_matches !== true ||
        template.hash !== found.rows[0].catalog_hash
      )
        throw denied('POSTGRES_CATALOG_INVALID');
      snapshot = found.rows[0].snapshot;
      attestedScopes.add(scopeKey(selected));
      return template.metadata;
    }
    async function scopedVersions163(organizationId) {
      check();
      if (!readScopes163) return null;
      if (platformOnly || organizationId !== scope.organizationId)
        throw denied('POSTGRES_READ_SCOPE_CONTEXT');
      const selectedScopes = [platform, scope],
        pending = [],
        positions = new Map();
      let queuedScope = currentScope;
      for (const selected of selectedScopes) {
        const key = scopeKey(selected);
        if (capturedScopes163.has(key)) continue;
        if (key !== queuedScope) {
          pending.push(
            sql(
              "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
              [selected.kind, selected.storeId],
            ),
          );
          queuedScope = key;
        }
        const wanted = selected.kind === 'platform' ? ['*', organizationId] : ['*'];
        positions.set(key, pending.length);
        pending.push(
          sql(
            `SELECT c.version,c.catalog_hash,c.metadata=t.metadata catalog_matches,m.epoch::text component_epoch,
          v.scope_id,v.epoch::text epoch,v.revision::text revision
          FROM cartoteca_catalog.stores c JOIN cartoteca_catalog.templates t ON t.kind=c.kind AND t.version=c.version AND t.catalog_hash=c.catalog_hash
          CROSS JOIN cartoteca_catalog.read_scope_component163 m LEFT JOIN cartoteca_catalog.read_scope_versions163 v
          ON v.kind=c.kind AND v.store_id=c.store_id AND v.scope_id=ANY($3::text[])
          WHERE c.kind=$1 AND c.store_id=$2 ORDER BY v.scope_id COLLATE "C"`,
            [selected.kind, selected.storeId, wanted],
          ),
        );
      }
      let results;
      try {
        results = await settle(pending);
        check();
        currentScope = queuedScope;
      } catch (error) {
        active = false;
        currentScope = null;
        throw error;
      }
      const versions = [readScopes163.epoch];
      for (const selected of selectedScopes) {
        const key = scopeKey(selected),
          wanted = selected.kind === 'platform' ? ['*', organizationId] : ['*'];
        let rows;
        if (positions.has(key)) {
          const result = results[positions.get(key)];
          if (!result.rows.length) throw unsupportedStore;
          const expected = selected.kind === 'platform' ? platformTemplate : cabinetTemplate;
          if (
            result.rows.some(
              (row) =>
                Number(row.version) !== expected.metadata.version ||
                row.catalog_hash !== expected.hash ||
                row.catalog_matches !== true,
            )
          )
            throw denied('POSTGRES_CATALOG_INVALID');
          if (result.rows.some((row) => row.component_epoch !== readScopes163.epoch))
            throw denied('POSTGRES_READ_SCOPE_COMPONENT_CHANGED');
          attestedScopes.add(key);
          rows = result.rows.map((row) => [row.scope_id, row.epoch, row.revision]);
          rows = scopeRows167(rows, wanted, readScopes163.epoch, readScopes163.epoch);
          capturedScopes163.set(key, rows);
        } else {
          rows = capturedScopes163.get(key);
          if (rows) rows = scopeRows167(rows, wanted, readScopes163.epoch, readScopes163.epoch);
        }
        if (!rows) return null;
        for (const row of rows) versions.push([selected.kind, selected.storeId, ...row]);
      }
      return JSON.stringify(versions);
    }
    async function probe(
      sources,
      { witness = false, captureScopes163 = false, patientPageHint165 = null } = {},
    ) {
      if (
        patientPageHint165 &&
        (typeof patientPageHint165.id !== 'string' ||
          !patientPageHint165.id ||
          patientPageHint165.id.length > 120 ||
          !(
            patientPageHint165.audience === '*' ||
            /^[a-f0-9]{64}$/.test(patientPageHint165.audience)
          ) ||
          !sources.some(
            (source) =>
              source.scope.kind === 'cabinet' && source.table === 'cabinet_history_entries',
          ))
      )
        throw denied('POSTGRES_PATIENT_PAGE_HINT');
      let patientPageEmpty165;

      check();
      const groups = new Map();
      for (const source of sources) {
        const key = scopeKey(source.scope);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(source);
      }
      let bytes = 0,
        rows = 0;
      const counts = new Map(),
        sourceBounds = new Map(),
        witnesses = new Map();
      const selectedGroups = [...groups.values()];
      const plans = selectedGroups.map((selected) => {
        const parameters = [],
          branches = selected.map((source, index) => {
            const offset = parameters.length;
            parameters.push(source.scope.storeId, ...(source.values || []));
            return sourceProbe(source, index, offset, {
              witness,
            });
          });
        let text = branches.join(' UNION ALL ');
        const selectedScope = selected[0].scope;
        if (deferCatalog) {
          const offset = parameters.length;
          const attested167 = attestedScopes.has(scopeKey(selectedScope));
          parameters.push(selectedScope.kind, selectedScope.storeId);
          const expected167 =
            selectedScope.kind === 'platform' ? platformTemplate : cabinetTemplate;
          if (attested167) parameters.push(expected167.metadata.version, expected167.hash);
          let clockColumns = '',
            clockResult = '';
          if (captureScopes163 && readScopes163) {
            parameters.push(
              selectedScope.kind === 'platform' ? ['*', scope.organizationId] : ['*'],
            );
            clockColumns = `,(SELECT COALESCE(jsonb_agg(jsonb_build_array(v.scope_id,v.epoch::text,v.revision::text) ORDER BY v.scope_id COLLATE "C"),'[]'::jsonb) FROM cartoteca_catalog.read_scope_versions163 v WHERE v.kind=s.kind AND v.store_id=s.store_id AND v.scope_id=ANY($${parameters.length}::text[])) AS read_scope_rows165,(SELECT m.epoch::text FROM cartoteca_catalog.read_scope_component163 m WHERE m.version=1) AS read_scope_epoch165`;
            clockResult = ',c.read_scope_rows165,c.read_scope_epoch165';
          }
          const catalogFrom167 = attested167
            ? `(SELECT $${offset + 1}::text AS kind,$${offset + 2}::text AS store_id,$${offset + 3}::bigint AS version,$${offset + 4}::text AS catalog_hash) s`
            : 'cartoteca_catalog.stores s JOIN cartoteca_catalog.templates t ON t.kind=s.kind AND t.version=s.version AND t.catalog_hash=s.catalog_hash';
          text = `WITH verified_catalog AS MATERIALIZED (SELECT s.version,s.catalog_hash,${attested167 ? 'true' : 's.metadata=t.metadata'} AS catalog_matches${clockColumns} FROM ${catalogFrom167} WHERE s.kind=$${offset + 1} AND s.store_id=$${offset + 2}),measured AS MATERIALIZED (${text}) SELECT m.*,c.version AS verified_version,c.catalog_hash AS verified_hash,c.catalog_matches${clockResult} FROM verified_catalog c LEFT JOIN measured m ON true`;
        }
        if (patientPageHint165 && selectedScope.kind === 'cabinet') {
          parameters.push(
            selectedScope.storeId,
            patientPageHint165.id,
            patientPageHint165.audience,
          );
          const last = parameters.length;
          text = `SELECT ct_probe165.*,NOT EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_history_entries WHERE _store_id=$${last - 2} AND patient_id=$${last - 1} AND audience=$${last} AND stream='upcoming') AS patient_page_empty165 FROM (${text}) ct_probe165`;
        }
        return { scope: selectedScope, text, values: parameters };
      });
      // PostgreSQL executes these dependent commands in order on the owning RR
      // connection. Drain every queued result before rollback on any failure.
      // Only this owning RR's capsule metadata may replace the identical probe;
      // no earlier operation's result or clinical row is borrowed or replayed.
      const pending = [],
        positions = [];
      let queuedScope = currentScope,
        results;
      const reusePatientProbe197 =
        patientPacket197 &&
        !patientPacket197.supported &&
        !patientProbeReused197 &&
        !captureScopes163 &&
        (!patientPageHint165 ||
          (patientPageHint165.id === patientCapsule197.selection.id &&
            patientPageHint165.audience === patientCapsule197.selection.audience));
      const descriptor197 = (list) =>
        digest(
          list.map((source) => [
            source.scope.kind,
            source.scope.storeId,
            source.table,
            source.where,
            source.values || [],
          ]),
        );
      try {
        for (const [planIndex, plan] of plans.entries()) {
          if (
            reusePatientProbe197 &&
            plan.scope.kind === 'cabinet' &&
            descriptor197(selectedGroups[planIndex]) === descriptor197(patientSources197)
          ) {
            patientProbeReused197 = true;
            positions.push(pending.length);
            pending.push(
              Promise.resolve({
                rows: patientPacket197.sources.map((row) => ({
                  ...row,
                  verified_version: cabinetTemplate.metadata.version,
                  verified_hash: cabinetTemplate.hash,
                  catalog_matches: true,
                  patient_page_empty165: patientPacket197.patientPageEmpty165,
                })),
              }),
            );
            continue;
          }
          const key = scopeKey(plan.scope);
          if (key !== queuedScope) {
            pending.push(
              sql(
                "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
                [plan.scope.kind, plan.scope.storeId],
              ),
            );
            queuedScope = key;
          }
          positions.push(pending.length);
          pending.push(sql(plan.text, plan.values));
        }
        results = await settle(pending);
        check();
        currentScope = queuedScope;
      } catch (error) {
        active = false;
        currentScope = null;
        throw error;
      }
      for (let index = 0; index < selectedGroups.length; index++) {
        const selected = selectedGroups[index],
          selectedScope = selected[0].scope,
          result = results[positions[index]];
        if (deferCatalog) {
          if (!result.rows.length) throw unsupportedStore;
          const expected = selectedScope.kind === 'platform' ? platformTemplate : cabinetTemplate;
          if (
            result.rows.some(
              (row) =>
                Number(row.verified_version) !== expected.metadata.version ||
                row.verified_hash !== expected.hash ||
                row.catalog_matches !== true,
            )
          )
            throw denied('POSTGRES_CATALOG_INVALID');
          attestedScopes.add(scopeKey(selectedScope));
          if (captureScopes163 && readScopes163) {
            const first = result.rows[0];
            if (
              result.rows.some(
                (row) =>
                  row.read_scope_epoch165 !== readScopes163.epoch ||
                  JSON.stringify(row.read_scope_rows165) !==
                    JSON.stringify(first.read_scope_rows165),
              )
            )
              throw denied('POSTGRES_READ_SCOPE_COMPONENT_CHANGED');
            capturedScopes163.set(scopeKey(selectedScope), first.read_scope_rows165);
          }
        }
        if (patientPageHint165 && selectedScope.kind === 'cabinet') {
          const first = result.rows[0]?.patient_page_empty165;
          if (
            typeof first !== 'boolean' ||
            result.rows.some((row) => row.patient_page_empty165 !== first)
          )
            throw denied('POSTGRES_PATIENT_PAGE_HINT');
          patientPageEmpty165 = first;
        }
        for (const row of result.rows) {
          const n = Number(row.rows),
            b = Number(row.bytes),
            source = selected[Number(row.source)];
          if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(b) || b < 0 || !source)
            throw denied('POSTGRES_READ_OPERATION_PROBE');
          witnesses.set(source, row.witness);
          const descriptor = JSON.stringify([
            source.scope.kind,
            source.scope.storeId,
            source.table,
            source.where,
            source.values || [],
          ]);
          proofSources.set(descriptor, {
            source,
            witness: row.witness,
            rows: n,
            bytes: b,
          });
          rows += n;
          bytes += b;
          const sourceKey = source.scope.kind + ':' + source.table;
          probedTables.add(sourceKey);
          counts.set(sourceKey, n);
          sourceBounds.set(sourceKey, { rows: n, bytes: b });
        }
      }
      // Six independently shaped existing reads can contain the same source row.
      // Factor24 bounds JSON text/objects; the remaining32MiB is fixed overhead.
      const cumulative = [...proofSources.values()].reduce(
        (sum, row) => ({
          bytes: sum.bytes + row.bytes,
          rows: sum.rows + row.rows,
        }),
        { bytes: 0, rows: 0 },
      );
      const decodedBound = cumulative.bytes * 6 * 24 + cumulative.rows * 6 * 256;
      if (
        probeClass &&
        !upgraded &&
        (decodedBound > SMALL_DECODE_BYTES || cumulative.rows > 20000)
      ) {
        check();
        await requestMemoryClass('query');
        check();
        upgraded = true;
      }
      operationByteLimit = Math.min(
        MAX_CIPHER_BYTES,
        Math.max(65536, cumulative.bytes * 6 + cumulative.rows * 256),
      );
      operationRowLimit = Math.min(MAX_RESULT_ROWS, Math.max(256, cumulative.rows * 6));
      probeCompleted = true;
      const clinical = sources.filter((source) => source.scope.kind === 'cabinet');
      return {
        bytes,
        rows,
        decodedBound,
        patientPageEmpty165,
        counts,
        sourceBounds,
        clinicalWitness: witness
          ? sourceWitness(
              clinical,
              clinical.map((source) => witnesses.get(source)),
            )
          : null,
      };
    }
    function batchGroups(reads) {
      const groups = [];
      for (const read of reads) {
        const prior = groups.at(-1);
        if (read.batch && prior?.[0].batch && prior.length < 16) prior.push(read);
        else groups.push([read]);
      }
      return groups;
    }
    function scopeWitness(scope) {
      const proof = [...proofSources.values()].filter(
        (item) => scopeKey(item.source.scope) === scopeKey(scope),
      );
      return sourceWitness(
        proof.map((item) => item.source),
        proof.map((item) => item.witness),
      );
    }
    function accountCached(result) {
      for (const row of result.rows) {
        let size = 64 + row.length * 32;
        for (const value of row)
          size += Buffer.isBuffer(value)
            ? value.byteLength
            : typeof value === 'string'
              ? Buffer.byteLength(value) * 2
              : 16;
        retainedBytes += size;
        retainedRows++;
        if (retainedBytes > operationByteLimit || retainedRows > operationRowLimit)
          throw denied('POSTGRES_READ_OPERATION_CAPACITY');
      }
    }
    async function execute(reads) {
      check();
      if (!probeCompleted) throw denied('POSTGRES_READ_OPERATION_PROBE_REQUIRED');
      for (const read of reads) {
        const tokens = lexReadonly(read.plan.text);
        for (let index = 0; index < tokens.length - 2; index++)
          if (
            tokenIdentifier(tokens[index]) === namespace(read.scope.kind) &&
            tokens[index + 1].value === '.'
          ) {
            const table = tokenIdentifier(tokens[index + 2]);
            if (table && !probedTables.has(read.scope.kind + ':' + table))
              throw denied('POSTGRES_READ_OPERATION_SOURCE_UNCOVERED');
          }
      }
      const ordered = new Array(reads.length),
        missing = [];
      const keys = reads.map((read) =>
        resultCache && !read.currentCipher196
          ? resultCacheKey(epoch, read, scopeWitness(read.scope))
          : null,
      );
      for (let index = 0; index < reads.length; index++) {
        const result = resultCache?.get(keys[index]);
        if (result) {
          accountCached(result);
          ordered[index] = result;
        } else missing.push({ ...reads[index], index, cacheKey: keys[index] });
      }
      const results = [];
      reads = missing;
      // Scope transitions stay ordered on this one physical RR connection.
      for (let offset = 0; offset < reads.length;) {
        const key = scopeKey(reads[offset].scope),
          group = [];
        while (offset < reads.length && scopeKey(reads[offset].scope) === key)
          group.push(reads[offset++]);
        await selectScope(group[0].scope);
        results.push(
          ...(
            await settle(
              batchGroups(group).map(
                (batch) =>
                  new Promise((resolve, reject) => {
                    check();
                    calls++;
                    const typed = batch.length > 1 ? createTypedReadResults(batch) : null;
                    const plan = typed ? typedReadBatch(batch) : batch[0].plan;
                    const request = new Query({
                      ...prepared(plan.text, plan.values),
                      rowMode: 'array',
                    });
                    const rows = [];
                    let overflow = false,
                      decodingError;
                    request.on('row', (raw) => {
                      if (decodingError) return;
                      let decoded;
                      try {
                        decoded = typed ? typed.row(raw) : { value: raw };
                      } catch (error) {
                        decodingError = error;
                        active = false;
                        return;
                      }
                      const row = decoded.value;
                      let size = 64 + row.length * 32;
                      for (const value of row)
                        size += Buffer.isBuffer(value)
                          ? value.byteLength
                          : typeof value === 'string'
                            ? Buffer.byteLength(value) * 2
                            : 16;
                      retainedBytes += size;
                      retainedRows++;
                      if (
                        overflow ||
                        retainedBytes > operationByteLimit ||
                        retainedRows > operationRowLimit
                      ) {
                        overflow = true;
                        rows.length = 0;
                      } else if (typed) typed.results[decoded.index].rows.push(row);
                      else rows.push(row);
                    });
                    request.once('error', (error) => {
                      active = false;
                      reject(error);
                    });
                    request.once('end', (result) =>
                      decodingError
                        ? reject(decodingError)
                        : overflow
                          ? reject(denied('POSTGRES_READ_OPERATION_CAPACITY'))
                          : resolve(typed ? typed.results : [{ rows, fields: result.fields }]),
                    );
                    client.query(request);
                  }),
              ),
            )
          ).flat(),
        );
      }
      check();
      results.forEach((result, index) => {
        const read = missing[index];
        ordered[read.index] = result;
        if (read.cacheKey) cacheCandidates.set(read.cacheKey, result);
      });
      return ordered;
    }
    try {
      const owned = await lock(locks, 'session');
      owned.forEach((value, index) => {
        if (value) acquired.push(locks[index]);
      });
      if (owned.some((value) => !value)) throw denied('POSTGRES_BUSY');
      transaction = true;
      if (deferCatalog) {
        const capsulePlan197 =
          patientCapsule197 && patientQuery197
            ? patientQuery197({ scope, ...patientCapsule197 })
            : null;
        const plan =
          capsulePlan197 && !capsulePlan197.unsupported
            ? capsulePlan197
            : platformGuard167({
                platform,
                locks,
                organizationId:
                  capturePlatformClocks167 && readScopes163 && !platformOnly
                    ? scope.organizationId
                    : null,
              });
        const pending = [sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')];
        if (currentScope !== scopeKey(platform))
          pending.push(
            sql(
              "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
              [platform.kind, platform.storeId],
            ),
          );
        pending.push(sql(plan.text, plan.values));
        let row;
        try {
          const results = await settle(pending);
          if (plan === capsulePlan197) {
            patientPacket197 = require('./patient-capsule-query197.cjs').parsePatientCapsule197(
              results.at(-1).rows,
              capsulePlan197.expected,
            );
            row = fenceRow167({ rows: [patientPacket197] });
          } else row = fenceRow167(results.at(-1));
        } catch (error) {
          poisoned = true;
          throw error;
        }
        if (row.released[0] !== true) {
          poisoned = true;
          throw denied('POSTGRES_FENCE_RELEASE_FAILED');
        }
        acquired.length = 0;
        currentScope = scopeKey(platform);
        snapshot = row.snapshot;
        if (row.locked[0] !== true) throw denied('POSTGRES_BUSY');
        if (!catalogRow167(row, platformTemplate)) throw unsupportedStore;
        attestedScopes.add(scopeKey(platform));
        if (patientPacket197) {
          const cabinet = patientPacket197.cabinetCatalog;
          if (
            Number(cabinet.version) !== cabinetTemplate.metadata.version ||
            cabinet.hash !== cabinetTemplate.hash ||
            cabinet.matches !== true
          )
            throw denied('POSTGRES_CATALOG_INVALID');
          attestedScopes.add(scopeKey(scope));
          const sources = require('./patient-capsule-plan197.cjs').patientCapsuleSources197({
            scope,
            cabinetCatalog: cabinetTemplate.metadata,
            ...patientCapsule197,
          });
          patientSources197 = sources;
          patientBound197 = require('./patient-capsule-bound197.cjs').patientCapsuleBound197(
            patientPacket197,
            sources,
          );
          if (patientBound197) {
            for (const proof of patientBound197.proofs) {
              const source = proof.source;
              proofSources.set(
                JSON.stringify([
                  source.scope.kind,
                  source.scope.storeId,
                  source.table,
                  source.where,
                  source.values || [],
                ]),
                proof,
              );
              probedTables.add(source.scope.kind + ':' + source.table);
            }
            operationByteLimit = patientBound197.byteLimit;
            operationRowLimit = patientBound197.rowLimit;
            retainedBytes = patientBound197.retainedBytes;
            retainedRows = patientPacket197.rows.length;
            if (retainedBytes > operationByteLimit || retainedRows > operationRowLimit)
              throw denied('POSTGRES_READ_OPERATION_CAPACITY');
            probeCompleted = true;
          }
        }
        if (capturePlatformClocks167 && readScopes163 && !platformOnly) {
          if (row.read_scope_epoch165 == null) throw unsupportedStore;
          const rows = scopeRows167(
            row.read_scope_rows165,
            ['*', scope.organizationId],
            row.read_scope_epoch165,
            readScopes163.epoch,
          );
          capturedScopes163.set(scopeKey(platform), rows);
        }
      } else {
        const [, transactionLocks, released] = await settle([
          sql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
          lock(locks, 'transaction'),
          lock([...acquired].reverse(), 'release'),
        ]);
        if (released.some((value) => !value)) {
          poisoned = true;
          throw denied('POSTGRES_FENCE_RELEASE_FAILED');
        }
        acquired.length = 0;
        if (transactionLocks.some((value) => !value)) throw denied('POSTGRES_BUSY');
      }
      const platformCatalog = deferCatalog ? platformTemplate.metadata : await catalogFor(platform),
        cabinetCatalog = platformOnly
          ? null
          : deferCatalog
            ? cabinetTemplate.metadata
            : await catalogFor(scope);
      if (!platformCatalog || (!platformOnly && !cabinetCatalog))
        return { unsupported: 'unprepared-store' };
      materializer = createOperationRows({
        execute,
        snapshot: snapshot,
        assertActive: check,
      });
      const stateReader196 = require('./directory-read-state196.cjs').createDirectoryReadState196({
        capability: directory164 && readScopes163 && !platformOnly ? directoryState196 : null,
        scope,
        sql: guardedSql,
        selectScope,
        check,
      });
      const value = await callback({
        patientCapsuleAuthority197: patientPacket197?.authorityRaw || null,
        patientCapsule197(selection) {
          check();
          if (!patientBound197) return null;
          if (digest(selection) !== digest(patientCapsule197.selection))
            throw denied('POSTGRES_PATIENT_CAPSULE_SELECTION197');
          return { rows: patientPacket197.rows, bound: patientBound197.bound };
        },
        ...stateReader196,
        async selectDirectoryRows196(audience, ids) {
          check();
          const plan = require('./directory-read-state196.cjs').directorySelectedQuery196(
            scope,
            audience,
            ids,
          );
          // Selected/changed196 integrity is bound to actual current ciphertext,
          // including when logical clocks and physical tuple witnesses match.
          const [result] = await execute([{ scope, plan, currentCipher196: true }]);
          if (result.rows.length > plan.maximumRows)
            throw denied('POSTGRES_READ_OPERATION_CAPACITY');
          return operationRows(result, plan);
        },
        platform,
        scope,
        platformCatalog,
        cabinetCatalog,
        marker,
        probe,
        scopedVersions163,
        capturedVersions165() {
          check();
          if (!readScopes163) return null;
          const versions = [readScopes163.epoch];
          for (const selected of [platform, scope]) {
            const rows = capturedScopes163.get(scopeKey(selected)),
              wanted = selected.kind === 'platform' ? ['*', scope.organizationId] : ['*'];
            if (
              !Array.isArray(rows) ||
              rows.length !== wanted.length ||
              wanted.some((id) => !rows.some((row) => Array.isArray(row) && row[0] === id))
            )
              return null;
            for (const row of rows) {
              if (
                row.length !== 3 ||
                !/^[a-f0-9-]{36}$/.test(row[1]) ||
                typeof row[2] !== 'string' ||
                !/^[1-9][0-9]{0,18}$/.test(row[2])
              )
                throw denied('POSTGRES_READ_SCOPE_VERSION');
              versions.push([selected.kind, selected.storeId, ...row]);
            }
          }
          return JSON.stringify(versions);
        },
        async requireDirectorySnapshotMemory180() {
          check();
          if (!directory164 || !readScopes163 || !probeCompleted)
            throw denied('POSTGRES_DIRECTORY_UNPREPARED');
          if (probeClass && !upgraded) {
            if (typeof requestMemoryClass !== 'function')
              throw denied('POSTGRES_READ_OPERATION_CONTEXT');
            await requestMemoryClass('query');
            check();
            upgraded = true;
          }
        },
        afterCommit165(callback) {
          check();
          if (typeof callback !== 'function') throw denied('POSTGRES_READ_OPERATION_CONTEXT');
          afterCommit165.push(callback);
        },
        directory164: !!directory164,
        async previewDirectoryCohort189(audience) {
          check();
          directoryPreview189 = null;
          if (!directory164 || !readScopes163) return null;
          const catalog = await catalogFor(scope);
          if (!catalog) return null;
          if (catalog !== cabinetCatalog) throw denied('POSTGRES_CATALOG_INVALID');
          const queries = require('./directory-queries164.cjs'),
            plan = queries.directoryCohortPreview189(scope, catalog, audience),
            result = await guardedSql(plan.text, plan.values),
            bound = queries.directoryCohortBound189(result.rows);
          // This metadata-only preview deliberately does not call probe(),
          // register source bounds, enable execute(), or retain ciphertext.
          directoryPreview189 = bound ? { audience, bound } : null;
          return bound;
        },
        async selectDirectoryCohort189(audience) {
          check();
          if (!directoryPreview189 || directoryPreview189.audience !== audience)
            throw denied('POSTGRES_DIRECTORY_COHORT_CONTEXT');
          if (probeClass && !upgraded) throw denied('POSTGRES_DIRECTORY_COHORT_MEMORY');
          const queries = require('./directory-queries164.cjs'),
            sources = queries.directoryCohortSources189({ scope, cabinetCatalog }, audience),
            bound = directoryPreview189.bound;
          for (const [index, source] of sources.entries()) {
            const descriptor = JSON.stringify([
                source.scope.kind,
                source.scope.storeId,
                source.table,
                source.where,
                source.values || [],
              ]),
              proof = proofSources.get(descriptor),
              expected = index === 0 ? bound.summary : bound.projection;
            if (!proof || proof.rows !== expected.rows || proof.bytes !== expected.bytes)
              throw denied('POSTGRES_DIRECTORY_COHORT_PROBE');
          }
          const plan = queries.directoryCohortQuery189(scope, audience),
            [result] = await execute([{ scope, plan, currentCipher196: !!directoryState196 }]);
          if (result.rows.length > plan.maximumRows)
            throw denied('POSTGRES_READ_OPERATION_CAPACITY');
          const selected = queries.directoryCohortRows189(
              operationRows(result, plan),
              bound,
              audience,
            ),
            token = Object.freeze({ rows: selected.rows });
          directoryCohorts189.set(token, selected.full);
          return token;
        },
        directoryCohortFull189(token) {
          check();
          const rows = directoryCohorts189.get(token);
          if (!rows) throw denied('POSTGRES_DIRECTORY_COHORT_CONTEXT');
          return rows;
        },
        async patientPageEmpty164({ id, audience }) {
          check();
          if (
            typeof id !== 'string' ||
            !id ||
            id.length > 120 ||
            !(audience === '*' || /^[a-f0-9]{64}$/.test(audience))
          )
            throw denied('POSTGRES_READ_OPERATION_CONTEXT');
          const catalog = await catalogFor(scope);
          if (!catalog?.tables.cabinet_history_entries) throw denied('POSTGRES_CATALOG_INVALID');
          const result = await guardedSql(
            "SELECT NOT EXISTS(SELECT 1 FROM cartoteca_cabinet.cabinet_history_entries WHERE _store_id=$1 AND patient_id=$2 AND audience=$3 AND stream='upcoming') AS empty",
            [scope.storeId, id, audience],
          );
          if (result.rows.length !== 1 || typeof result.rows[0].empty !== 'boolean')
            throw denied('POSTGRES_READ_OPERATION_CONTEXT');
          return result.rows[0].empty;
        },
        async selectDirectory164(kind, selection) {
          check();
          if (!directory164) throw denied('POSTGRES_DIRECTORY_UNPREPARED');
          const plan = require('./directory-queries164.cjs').directoryQuery164(
            scope,
            kind,
            selection,
          );
          const [result] = await execute([{ scope, plan, currentCipher196: !!directoryState196 }]);
          if (result.rows.length > plan.maximumRows)
            throw denied('POSTGRES_READ_OPERATION_CAPACITY');
          return operationRows(result, plan);
        },
        rows: materializer,
        async selectView(kind, selection) {
          check();
          const plan = viewQuery(scope, cabinetCatalog, kind, selection);
          const [result] = await execute([
            { scope, plan, currentCipher196: !!directoryState196 && kind === 'directory' },
          ]);
          if (plan.maximumRows && result.rows.length > plan.maximumRows)
            throw denied('POSTGRES_READ_OPERATION_CAPACITY');
          return operationRows(result, plan);
        },
        assertActive: check,
        snapshot: snapshot,
        epoch,
      });
      check();
      // Compatibility decisions which return before a byte probe still attest
      // both stores before their result may leave the physical operation.
      if (deferCatalog)
        for (const selected of platformOnly ? [platform] : [platform, scope]) {
          if (attestedScopes.has(scopeKey(selected))) continue;
          const found = await catalogFor(selected);
          if (!found) throw unsupportedStore;
          if (
            found !==
            (selected.kind === 'platform' ? platformTemplate.metadata : cabinetTemplate.metadata)
          )
            throw denied('POSTGRES_CATALOG_INVALID');
        }
      if (finish167 && !value?.unsupported) {
        try {
          await finishRead167({
            sql,
            platform,
            currentScope,
            token: finish167.token,
            accept: finish167.accept,
            assertActive: check,
            onCommitAck() {
              transaction = false;
            },
            onScopeAck(key) {
              currentScope = key;
            },
          });
        } catch (error) {
          currentScope = null;
          throw error;
        }
      } else {
        await sql('COMMIT');
        transaction = false;
      }
      for (const publish of afterCommit165) {
        try {
          publish();
        } catch {
          /* Cache publication cannot turn an acknowledged read into a write retry. */
        }
      }
      for (const [key, result] of cacheCandidates) resultCache.put(key, result);
      return value;
    } catch (error) {
      if (error === unsupportedStore) return { unsupported: 'unprepared-store' };
      throw error;
    } finally {
      active = false;
      materializer?.clear();
      if (transaction) {
        try {
          await sql('ROLLBACK');
        } catch {
          poisoned = true;
        }
      }
      if (acquired.length) {
        try {
          if ((await lock(acquired.reverse(), 'release')).some((value) => !value)) poisoned = true;
        } catch {
          poisoned = true;
        }
      }
      // Session scope persists after COMMIT; a rollback can undo set_config.
      if (transaction || poisoned) currentScope = null;
      busy = false;
      if (poisoned) await client.end().catch(() => {});
    }
  }
  return {
    marker,
    patientCapsuleCatalog197(scope) {
      if (!patientQuery197 || scope?.kind !== 'cabinet') return null;
      const version = storeVersions.get(scopeKey(scope));
      const catalog =
        version === 2
          ? catalogs.get('cabinet:' + version + ':' + marker.cabinetTemplates[String(version)])
              ?.metadata
          : null;
      return catalog?.tables.cabinet_history_entries && catalog.tables.cabinet_history_manifests
        ? catalog
        : null;
    },
    directory196: !!hotQuery196,
    hotMetadata169: hotQuery169
      ? async function (input, assertActive) {
          if (busy || closed || poisoned) throw denied('POSTGRES_READ_OPERATION_UNAVAILABLE');
          if (!hotQuery169) return { unsupported: 'hot-metadata-unprepared' };
          const logical196 = hotQuery196 && input.directory196 === true;
          const plan = logical196 ? hotQuery196(input) : hotQuery169(input);
          if (plan.unsupported) return plan;
          busy = true;
          try {
            assertActive();
            let result;
            try {
              // This private idle-owner API owns autocommit. A successful pg Promise
              // includes ReadyForQuery; rejected queries may still need physical end.
              result = await sql(plan.text, plan.values);
            } catch (error) {
              poisoned = true;
              currentScope = null;
              closing ||= client.end();
              await closing.catch(() => {});
              throw error;
            }
            assertActive();
            return logical196
              ? require('./hot-directory-query196.cjs').parseHotDirectory196(
                  result.rows,
                  plan.expected,
                )
              : require('./hot-metadata-query169.cjs').parseHotMetadata169(
                  result.rows,
                  plan.expected,
                );
          } finally {
            busy = false;
          }
        }
      : null,
    async authority(token, assertActive) {
      if (busy || closed || poisoned) throw denied('POSTGRES_READ_OPERATION_UNAVAILABLE');
      busy = true;
      try {
        assertActive();
        const platform = { kind: 'platform', storeId: marker.platformStoreId };
        await setScope(platform);
        const plan = authorityQuery(platform, token);
        const result = await sql(plan.text, plan.values);
        assertActive();
        return result.rows;
      } finally {
        busy = false;
      }
    },
    run,
    available166: () => !closed && !poisoned,
    sqlCalls: () => calls,
    async close() {
      if (!closing) {
        closed = true;
        closing = client.end();
      }
      await closing;
    },
  };
}
module.exports = {
  createReadOperationClient,
  SMALL_DECODE_BYTES,
  MAX_CIPHER_BYTES,
  MAX_RESULT_ROWS,
};
