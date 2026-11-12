const { Int32Array, Atomics, ArrayBuffer } = globalThis;
const { parentPort, workerData } = require('node:worker_threads');
const {
  advisoryKey: key,
  KEYS,
  intentOf,
  queueDomainOf,
  compoundOf,
  scopedQueueOf,
  authOf,
  accountingOf,
  assertMode,
  lockPlan,
  assertPlanIntent,
} = require('./lock-intents.cjs');
const { assertQueueDomain } = require('./queue-domains.cjs');
const { compoundScope, assertCompoundScope } = require('./compound-intent133.cjs');
const { assetLineage, assertKnownScope } = require('./asset-lineage133.cjs');
const {
  organizationQueueScope,
  entityQueueScope,
  assertScopedQueueScope,
} = require('./scoped-queue134.cjs');
const { authScope, assertAuthScope, admissionPlans } = require('./auth-intent137.cjs');
const {
  accountingScope,
  assertAccountingScope,
  assertAccountingReservation,
} = require('./assistant-accounting145.cjs');
const { runLockBatch } = require('./transaction-locks.cjs');
const cabinetReadBundle = require('./cabinet-read-bundle136.cjs');
const readBatch = require('./readonly-read-batch140.cjs');
const v8 = require('node:v8');
const memorySampling = require('../native-memory-observation.cjs').startMemorySampling(
  workerData.memoryProcess,
  workerData.memoryMailbox,
);
const { Client, Query, types } = require('pg');
const { createPreparedQueries, orderedResults } = require('./prepared-query141.cjs');
const preparedQuery = createPreparedQueries();

types.setTypeParser(20, (value) => BigInt(value));
const state = new Int32Array(workerData.mailbox, 0, 4);
const inline = new Uint8Array(workerData.mailbox, 16);
const client = new Client({
  ...workerData.connection,
  pipeline: true,
  connectionTimeoutMillis: workerData.statementTimeoutMs,
});
const cursors = new Map();
let active = null;
let transaction = false;
let sharedOnly = false;
let atomicStatements = false;
let atomicStatementFailed = false;
let heldLocks = new Map();
let intentFrames = [];
let currentScope = null;
let tenantVisited = false;
let cursorSequence = 0;
let broken = false;
let statementSequence = 0;
let authority = null;
let revisionProfile = null;
let directoryState196;
let patientCapsule197;
let verifiedLineage = null;
let queueOrganizations = new Set();
const validatedKinds = new Set();
const scopedCatalogs = new Map();
const inspectedScopes = new Map();
const metadataCache = require('./catalog-metadata-cache136.cjs').createCatalogMetadataCache136();
const catalogFor = (scope) => scopedCatalogs.get(scope.kind + ':' + scope.storeId);
const sqlState = (error) => /^[0-9A-Z]{5}$/.test(error?.code || '');
function fault(code, extra = {}) {
  return Object.assign(Error('PostgreSQL operation failed.'), { code }, extra);
}
function clearLocks() {
  heldLocks = new Map();
  currentScope = null;
}
function clearTransaction() {
  transaction = false;
  sharedOnly = false;
  atomicStatements = false;
  atomicStatementFailed = false;
  intentFrames = [];
  tenantVisited = false;
  clearLocks();
}
function scopeCheck(scope) {
  if (
    !scope ||
    !['platform', 'cabinet', 'budget'].includes(scope.kind) ||
    typeof scope.storeId !== 'string' ||
    !scope.storeId ||
    scope.storeId.length > 256
  )
    throw fault('POSTGRES_SCOPE_INVALID');
  assertAuthScope(scope, authOf(intentFrames));
  assertAccountingScope(scope, accountingOf(intentFrames));
}
async function setScope(scope) {
  scopeCheck(scope);
  const identity = scope.kind + ':' + scope.storeId;
  if (currentScope === identity) return;
  await client.query(
    "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
    [scope.kind, scope.storeId],
  );
  currentScope = identity;
}
async function lockBatch(locks, operation) {
  try {
    return await runLockBatch(client, locks, operation);
  } catch (error) {
    // A failed batch may already own an unknown session-lock prefix. Never
    // classify it as clean contention or reuse this connection after that.
    broken = true;
    client.end().catch(() => {});
    error.channelPoisoned = true;
    throw error;
  }
}
async function acquire(scope, writing, beforeBegin = false) {
  scopeCheck(scope);
  const intent = intentOf(intentFrames);
  assertCompoundScope(scope, compoundOf(intentFrames));
  assertScopedQueueScope(scope, scopedQueueOf(intentFrames), writing);
  if (writing && intent === 'READONLY') throw fault('POSTGRES_QUERY_ONLY');
  if (writing && intent === 'QUEUE' && scope.kind !== 'platform')
    throw fault('POSTGRES_QUEUE_WRITE_FORBIDDEN');
  const writerAtRoot =
    intentFrames[0]?.scope.kind === 'platform' &&
    ['IMMEDIATE', 'QUEUE', 'COMPOUND', 'QUEUEORG', 'QUEUEENTITY', 'AUTH', 'ACCOUNTING'].includes(
      intentFrames[0]?.mode,
    );
  if (
    writing &&
    scope.kind === 'platform' &&
    tenantVisited &&
    !heldLocks.has(KEYS.writer) &&
    !writerAtRoot
  )
    throw fault('POSTGRES_TRANSACTION_ORDER');
  const mode = intent || intentFrames[0]?.mode || 'DEFERRED';
  const desired = lockPlan(
    scope,
    mode,
    writing,
    intent,
    queueDomainOf(intentFrames),
    compoundOf(intentFrames),
    scopedQueueOf(intentFrames),
    authOf(intentFrames),
    accountingOf(intentFrames),
  ).filter((lock) => {
    const previous = heldLocks.get(lock.key);
    return previous !== 'exclusive' && previous !== (lock.shared ? 'shared' : 'exclusive');
  });
  const locked = await lockBatch(desired, 'transaction');
  for (let i = 0; i < desired.length; i++) {
    if (!locked[i]) throw fault('POSTGRES_BUSY', { retryableBeforeBegin: beforeBegin });
    heldLocks.set(desired[i].key, desired[i].shared ? 'shared' : 'exclusive');
  }
  if (scope.kind !== 'platform' && intent !== 'READONLY') tenantVisited = true;
}
async function begin(
  scope,
  mode,
  queueDomain = null,
  compoundInput = null,
  scopedInput = null,
  authInput = null,
  accountingInput = null,
) {
  if (transaction) throw fault('POSTGRES_TRANSACTION_NESTING');
  scopeCheck(scope);
  assertMode(scope, mode);
  let accounting = null;
  if (mode === 'ACCOUNTING' || accountingInput !== null) {
    if (mode !== 'ACCOUNTING' || revisionProfile !== 3 || !catalogFor(scope))
      throw fault('POSTGRES_ACCOUNTING_UNAVAILABLE');
    accounting = accountingScope(accountingInput, scope);
    if (!verifiedLineage || verifiedLineage.platformStoreId !== scope.storeId)
      throw fault('POSTGRES_ASSET_LINEAGE_REQUIRED');
  }
  let auth = null;
  if (mode === 'AUTH' || authInput !== null) {
    if (mode !== 'AUTH' || revisionProfile !== 3 || !catalogFor(scope))
      throw fault('POSTGRES_AUTH_UNAVAILABLE');
    auth = authScope(authInput, scope);
    if (!verifiedLineage || verifiedLineage.platformStoreId !== scope.storeId)
      throw fault('POSTGRES_ASSET_LINEAGE_REQUIRED');
  }
  let scopedQueue = null;
  if (['QUEUEORG', 'QUEUEENTITY'].includes(mode) || scopedInput !== null) {
    if (!['QUEUEORG', 'QUEUEENTITY'].includes(mode) || revisionProfile !== 3 || !catalogFor(scope))
      throw fault('POSTGRES_SCOPED_QUEUE_UNAVAILABLE');
    scopedQueue = (mode === 'QUEUEORG' ? organizationQueueScope : entityQueueScope)(
      scopedInput,
      scope,
    );
    if (!verifiedLineage || verifiedLineage.platformStoreId !== scope.storeId)
      throw fault('POSTGRES_ASSET_LINEAGE_REQUIRED');
    if (
      scopedQueue.type === 'organization' &&
      !queueOrganizations.has(scopedQueue.organizationId)
    ) {
      await setScope(scope);
      const organization = await query(
        'SELECT id FROM cartoteca_platform.organizations WHERE _store_id=$1 AND id=$2',
        [scope.storeId, scopedQueue.organizationId],
      );
      if (organization.rows.length !== 1) throw fault('POSTGRES_SCOPED_QUEUE_SCOPE_INVALID');
      // Cache lineage identity only. Delivery policy, memberships, channel
      // versions and leases are still read freshly by the caller's guards.
      if (queueOrganizations.size < 100000) queueOrganizations.add(scopedQueue.organizationId);
    }
  }
  let compound = null;
  if (mode === 'COMPOUND' || compoundInput !== null) {
    if (mode !== 'COMPOUND' || revisionProfile !== 3 || !catalogFor(scope))
      throw fault('POSTGRES_COMPOUND_UNAVAILABLE');
    compound = compoundScope(compoundInput, scope);
    if (!verifiedLineage || verifiedLineage.platformStoreId !== compound.platformStoreId)
      throw fault('POSTGRES_ASSET_LINEAGE_REQUIRED');
    if (compound.cabinetStoreId) {
      const expected = verifiedLineage.scopes.get('cabinet:' + compound.cabinetStoreId);
      if (!expected || expected.organizationId !== compound.organizationId)
        throw fault('POSTGRES_ASSET_LINEAGE_MISMATCH');
    }
    if (compound.cabinetStoreId) {
      const cabinet = inspectedScopes.get('cabinet:' + compound.cabinetStoreId);
      if (
        !cabinet ||
        (cabinet.organizationId && cabinet.organizationId !== compound.organizationId)
      )
        throw fault('POSTGRES_COMPOUND_SCOPE_INVALID');
    }
  }
  if (queueDomain !== null) {
    assertQueueDomain(queueDomain);
    if (mode !== 'QUEUE' || scope.kind !== 'platform' || ![2, 3].includes(revisionProfile))
      throw fault('POSTGRES_QUEUE_DOMAIN_UNAVAILABLE');
  }
  const writes = [
    'IMMEDIATE',
    'QUEUE',
    'COMPOUND',
    'QUEUEORG',
    'QUEUEENTITY',
    'AUTH',
    'ACCOUNTING',
  ].includes(mode);
  const guards = lockPlan(
    scope,
    mode,
    writes,
    null,
    queueDomain,
    compound,
    scopedQueue,
    auth,
    accounting,
  );
  const acquired = [];
  let pendingError;
  try {
    // A RR snapshot is assigned before SELECT evaluates its lock function. Hold
    // session guards before BEGIN, then transfer ownership to transaction locks.
    const locked = await lockBatch(guards, 'session');
    for (let i = 0; i < guards.length; i++) {
      if (!locked[i]) throw fault('POSTGRES_BUSY', { retryableBeforeBegin: true });
      acquired.push(guards[i]);
    }
    await client.query(
      mode === 'READONLY'
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : mode === 'DEFERRED'
          ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'
          : 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
    );
    transaction = true;
    sharedOnly = mode === 'SHARED';
    intentFrames = [
      {
        scope,
        mode,
        name: null,
        ...(queueDomain ? { queueDomain } : {}),
        ...(scopedQueue ? { scopedQueue } : {}),
        ...(compound ? { compound } : {}),
        ...(auth ? { auth } : {}),
        ...(accounting ? { accounting } : {}),
      },
    ];
    await acquire(scope, writes, true);
    if (accounting) {
      await setScope(scope);
      await assertAccountingReservation(query, scope, accounting);
    }
    if (auth) {
      await setScope(scope);
      for (const [index, plan] of admissionPlans(auth, scope, catalogFor(scope)).entries()) {
        const result = await query(plan.text, plan.values);
        if (
          result.rows.length !== 1 ||
          (index === 1 &&
            (result.rows[0].organization_id !== auth.organizationId ||
              result.rows[0].projection_ready !== 1))
        )
          throw fault('POSTGRES_AUTH_AUTHORITY_CHANGED');
      }
    }
  } catch (error) {
    pendingError = error;
    if (transaction)
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
    clearTransaction();
  } finally {
    if (acquired.length) {
      try {
        const released = await lockBatch(acquired.reverse(), 'release');
        if (released.some((value) => value !== true)) throw fault('POSTGRES_FENCE_RELEASE_FAILED');
      } catch (error) {
        broken = true;
        client.end().catch(() => {});
        pendingError ||= error;
      }
    }
  }
  if (pendingError) {
    if (broken) pendingError.channelPoisoned = true;
    throw pendingError;
  }
}
async function query(text, values = [], softLimit = null) {
  if (typeof text !== 'string' || !text || !Array.isArray(values))
    throw fault('POSTGRES_PLAN_INVALID');
  return new Promise((resolve, reject) => {
    const request = new Query(preparedQuery(text, values));
    const rows = [];
    let used = 0;
    let overflow = false;
    let softOverflow = false;
    request.on('row', (row) => {
      if (overflow || softOverflow) return;
      const aggregate = softLimit?.aggregate;
      if (aggregate?.overflow) {
        softOverflow = true;
        rows.length = 0;
        return;
      }
      const size = v8.serialize(row).byteLength;
      used += size;
      if (used > Math.max(0, workerData.maxReplyBytes - 1024)) {
        overflow = true;
        broken = true;
        client.end().catch(() => {});
      } else if (softLimit && (used > softLimit.bytes || rows.length >= softLimit.rows)) {
        // Drain this SELECT without retaining its remaining rows. No connection
        // poisoning or SQL transaction failure is caused by a prefetch budget.
        softOverflow = true;
        rows.length = 0;
      } else if (
        aggregate &&
        (aggregate.rows >= readBatch.MAX_ROWS || aggregate.bytes + size > readBatch.MAX_BYTES)
      ) {
        aggregate.overflow = true;
        softOverflow = true;
        rows.length = 0;
      } else {
        if (aggregate) {
          aggregate.rows++;
          aggregate.bytes += size;
        }
        rows.push(row);
      }
    });
    request.once('error', (error) =>
      reject(overflow ? fault('POSTGRES_REPLY_TOO_LARGE', { channelPoisoned: true }) : error),
    );
    request.once('end', (result) => {
      if (overflow) reject(fault('POSTGRES_REPLY_TOO_LARGE', { channelPoisoned: true }));
      else if (softOverflow || softLimit?.aggregate?.overflow)
        reject(readBatch.fault('POSTGRES_READ_BATCH_CAPACITY'));
      else
        resolve({
          rows,
          rowCount: result.rowCount || 0,
          fields: result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })),
        });
    });
    client.query(request);
  });
}
async function statement(work) {
  // A physical read-only snapshot cannot recover a statement failure locally:
  // PostgreSQL keeps it aborted until the owning callback rolls it back.
  const savepoint =
    transaction && intentFrames[0]?.mode !== 'READONLY' && !atomicStatements
      ? 'ct_statement_' + ++statementSequence
      : null;
  let created = false;
  try {
    const result = savepoint
      ? (
          await orderedResults([
            () =>
              client.query(`SAVEPOINT ${savepoint}`).then(() => {
                created = true;
              }),
            work,
          ])
        )[1]
      : await work();
    // A client-side binding/validation error need not abort PostgreSQL. Never
    // queue RELEASE before work succeeds: a prior step may still need rollback.
    if (savepoint) await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (atomicStatements) atomicStatementFailed = true;
    if (created)
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        clearLocks();
      } catch {
        broken = true;
      }
    throw error;
  }
}
function plans(plan) {
  const steps = plan?.steps || [plan];
  if (!Array.isArray(steps) || !steps.length || steps.length > 128)
    throw fault('POSTGRES_PLAN_INVALID');
  for (const step of steps)
    if (
      !step ||
      typeof step.text !== 'string' ||
      !Array.isArray(step.values) ||
      !['read', 'write'].includes(step.effect)
    )
      throw fault('POSTGRES_PLAN_INVALID');
  return steps;
}
async function execute(command) {
  const steps = plans(command.plan);
  const writing = steps.some((step) => step.effect === 'write');
  const writeBatch = command.plan?.writeBatch155 === true;
  if (
    Object.hasOwn(command.plan, 'writeBatch155') &&
    (!writeBatch ||
      !transaction ||
      revisionProfile !== 3 ||
      !verifiedLineage ||
      command.scope.kind !== 'cabinet' ||
      command.method !== 'exec' ||
      !command.plan.steps ||
      steps.length > 32 ||
      steps.some(
        (step) => step.effect !== 'write' || step.returningId || /\bRETURNING\b/i.test(step.text),
      ))
  )
    throw fault('POSTGRES_WRITE_BATCH_INVALID');
  const owned = !transaction && writing;
  assertPlanIntent(
    steps,
    command.scope,
    intentOf(intentFrames),
    queueDomainOf(intentFrames),
    compoundOf(intentFrames),
    catalogFor(command.scope),
    scopedQueueOf(intentFrames),
    authOf(intentFrames),
    accountingOf(intentFrames),
  );
  if (sharedOnly && command.scope.kind === 'platform' && writing)
    throw fault('POSTGRES_QUERY_ONLY');
  if (owned) await begin(command.scope, 'IMMEDIATE');
  try {
    const result = await statement(async () => {
      if (transaction && writing) await acquire(command.scope, true);
      if (writeBatch) {
        await setScope(command.scope);
        // Every original statement was authorized before the first submission.
        // The physical pg connection executes these in order. Drain ALL queued
        // results before the single statement savepoint may roll back; no failed
        // prefix or later 25P02 is hidden and no statement is replayed.
        const replies = await orderedResults(
          steps.map((step) => () => query(step.text, step.values)),
        );
        return replies.at(-1);
      }
      let reply;
      for (const step of steps) {
        await setScope(command.scope);
        const text =
          command.method === 'get' && step.effect === 'read'
            ? `SELECT * FROM (${step.text.replace(/;\s*$/, '')}) AS ct_first_row LIMIT 1`
            : step.text;
        reply = await query(text, step.values);
      }
      return reply;
    });
    if (owned) {
      await client.query('COMMIT');
      clearTransaction();
    }
    return result;
  } catch (error) {
    if (owned) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      clearTransaction();
    }
    throw error;
  }
}
async function cursorOpen(command) {
  const [plan, ...other] = plans(command.plan);
  if (other.length || plan.effect !== 'read') throw fault('POSTGRES_CURSOR_READ_ONLY');
  assertPlanIntent(
    [plan],
    command.scope,
    intentOf(intentFrames),
    queueDomainOf(intentFrames),
    compoundOf(intentFrames),
    catalogFor(command.scope),
    scopedQueueOf(intentFrames),
    authOf(intentFrames),
    accountingOf(intentFrames),
  );
  if (cursors.size >= workerData.maxCursors) throw fault('POSTGRES_CURSOR_LIMIT');
  const cursor = 'ct_cursor_' + ++cursorSequence;
  const held = !transaction;
  if (held) await begin(command.scope, 'READONLY');
  try {
    await statement(async () => {
      await setScope(command.scope);
      await client.query(
        `DECLARE "${cursor}" NO SCROLL CURSOR${held ? ' WITH HOLD' : ''} FOR ${plan.text}`,
        plan.values,
      );
    });
    if (held) {
      await client.query('COMMIT');
      clearTransaction();
    }
    cursors.set(cursor, { held, scope: command.scope });
    return { cursor };
  } catch (error) {
    if (held) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      clearTransaction();
    }
    throw error;
  }
}
async function assertAssetScope(scope) {
  if (!verifiedLineage) {
    if (revisionProfile === 3 && scope.kind === 'cabinet')
      throw fault('POSTGRES_ASSET_LINEAGE_REQUIRED');
    return;
  }
  const key = scope.kind + ':' + scope.storeId;
  const expected = verifiedLineage.scopes.get(key);
  if (expected) {
    assertKnownScope(scope, expected);
    return;
  }
  if (
    scope.kind !== 'cabinet' ||
    scope.storeId !== scope.organizationId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(scope.storeId)
  )
    throw fault('POSTGRES_ASSET_LINEAGE_MISMATCH');
  await setScope({ kind: 'platform', storeId: verifiedLineage.platformStoreId });
  const organization = await query(
    'SELECT id FROM cartoteca_platform.organizations WHERE _store_id=$1 AND id=$2',
    [verifiedLineage.platformStoreId, scope.organizationId],
  );
  if (organization.rows.length !== 1) throw fault('POSTGRES_ASSET_LINEAGE_MISMATCH');
  verifiedLineage.scopes.set(
    key,
    Object.freeze({
      kind: 'cabinet',
      storeId: scope.storeId,
      organizationId: scope.organizationId,
    }),
  );
}
// Inspect pins immutable physical identity once. Later RPCs must not replace
// its organization metadata while keeping the same physical store identifier.
function assertCommandAssetScope(scope) {
  if (revisionProfile !== 3 || !verifiedLineage) return;
  scopeCheck(scope);
  const key = scope.kind + ':' + scope.storeId;
  const expected = verifiedLineage.scopes.get(key);
  if (!expected) throw fault('POSTGRES_ASSET_LINEAGE_MISMATCH');
  assertKnownScope(scope, expected);
  const inspected = inspectedScopes.get(key);
  if (inspected)
    assertKnownScope(scope, {
      kind: inspected.kind,
      storeId: inspected.storeId,
      organizationId: inspected.organizationId || null,
    });
}
async function verifyProfile(command) {
  const scope = command.scope;
  scopeCheck(scope);
  if (
    scope.kind !== 'platform' ||
    typeof command.migrationId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(command.migrationId) ||
    typeof command.markerHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(command.markerHash)
  )
    throw fault('POSTGRES_ASSET_LINEAGE_MISMATCH');
  const verified =
    command.lineage === undefined
      ? null
      : assetLineage(command.lineage, {
          platformStoreId: scope.storeId,
          migrationId: command.migrationId,
          markerHash: command.markerHash,
        });
  if (
    verifiedLineage &&
    (verifiedLineage.platformStoreId !== scope.storeId ||
      verifiedLineage.migrationId !== command.migrationId ||
      verifiedLineage.markerHash !== command.markerHash)
  )
    throw fault('POSTGRES_ASSET_LINEAGE_MISMATCH');
  await setScope(scope);
  const result = await query(
    "SELECT migration_id,marker_hash FROM cartoteca_catalog.asset_profiles WHERE kind='platform' AND store_id=$1",
    [scope.storeId],
  );
  if (
    result.rows.length !== 1 ||
    result.rows[0].migration_id !== command.migrationId ||
    result.rows[0].marker_hash !== command.markerHash
  )
    throw fault('POSTGRES_ASSET_LINEAGE_MISMATCH');
  if (verified) {
    verifiedLineage = verified;
    queueOrganizations = new Set(
      [...verified.scopes.values()].map((scope) => scope.organizationId).filter(Boolean),
    );
  }
  return true;
}
async function inspect(command) {
  scopeCheck(command.scope);
  if (
    command.catalogReference !== undefined &&
    !require('./catalog-metadata-cache136.cjs').validReference(command.catalogReference)
  )
    throw fault('POSTGRES_CATALOG_INVALID');
  assertCompoundScope(command.scope, compoundOf(intentFrames));
  assertScopedQueueScope(command.scope, scopedQueueOf(intentFrames));
  const previousScope = inspectedScopes.get(command.scope.kind + ':' + command.scope.storeId);
  if (
    previousScope?.organizationId &&
    command.scope.organizationId !== previousScope.organizationId
  )
    throw fault('POSTGRES_COMPOUND_SCOPE_INVALID');
  if (!validatedKinds.has(command.scope.kind)) {
    try {
      await require('./catalog-postgres.cjs').validatePostgresSchema(client, {
        kind: command.scope.kind,
        applicationRole: client.user,
      });
      validatedKinds.add(command.scope.kind);
    } catch (error) {
      if (error.code) throw error;
      throw fault('POSTGRES_SCHEMA_INVALID');
    }
  }
  if (revisionProfile === null)
    revisionProfile = await require('./revision-profile132.cjs').readRevisionProfile(
      client,
      client.user,
    );
  if ([2, 3].includes(command.revisionProfile) && command.revisionProfile !== revisionProfile)
    throw fault('POSTGRES_REVISION_PROFILE_INVALID');
  if (revisionProfile === 3 && directoryState196 === undefined)
    directoryState196 = await require('./directory-state-schema196.cjs').verifyDirectoryState196(
      client,
      client.user,
    );
  if (revisionProfile === 3 && patientCapsule197 === undefined)
    patientCapsule197 = await require('./patient-capsule-schema197.cjs').verifyPatientCapsule197(
      client,
      client.user,
    );
  await assertAssetScope(command.scope);
  let owned = false;
  try {
    await setScope(command.scope);
    const values = [command.scope.kind, command.scope.storeId];
    let newStore = false;
    const inspected = await metadataCache.read(query, command.scope, command.version);
    let result = inspected.result;
    let metadataVerified = inspected.metadataVerified;
    if (!result.rows.length && command.allowCreate === true) {
      if (intentOf(intentFrames)) throw fault('POSTGRES_PROVISION_INTENT_FORBIDDEN');
      if (
        command.scope.kind !== 'cabinet' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          command.scope.storeId,
        )
      )
        throw fault('POSTGRES_PROVISION_SCOPE');
      owned = !transaction;
      if (owned) await begin(command.scope, 'IMMEDIATE');
      else await acquire(command.scope, true);
      let hash = command.catalogHash;
      if (!hash) {
        const templates = await query(
          'SELECT catalog_hash FROM cartoteca_catalog.templates WHERE kind=$1 AND version=$2',
          ['cabinet', command.version],
        );
        if (templates.rows.length !== 1) throw fault('POSTGRES_TEMPLATE_MISSING');
        hash = templates.rows[0].catalog_hash;
      }
      const provision = await query(
        'SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5) AS created',
        [...values, command.version, hash, command.platformStoreId],
      );
      newStore = provision.rows[0]?.created === true;
      result = await query(
        'SELECT metadata,catalog_hash,revision,version FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2',
        values,
      );
    }
    if (!result.rows.length && command.optional === true && command.allowCreate !== true)
      return { exists: false };
    if (result.rows.length !== 1) throw fault('POSTGRES_STORE_MISSING');
    const record = result.rows[0];
    let valid = false;
    try {
      valid =
        (metadataVerified ||
          require('./catalog-sqlite.cjs').digest(record.metadata) === record.catalog_hash) &&
        BigInt(record.metadata?.version) === BigInt(record.version);
    } catch {}
    if (!valid) throw fault('POSTGRES_CATALOG_INVALID');
    if (
      command.version !== undefined &&
      command.version !== 0 &&
      (!Number.isSafeInteger(command.version) ||
        command.version < 0 ||
        BigInt(record.version) !== BigInt(command.version))
    )
      throw fault('POSTGRES_CATALOG_VERSION_MISMATCH');
    if (owned) {
      await client.query('COMMIT');
      clearTransaction();
    }
    record.metadata = metadataCache.rememberValidated(command.scope, record);
    scopedCatalogs.set(command.scope.kind + ':' + command.scope.storeId, record.metadata);
    inspectedScopes.set(command.scope.kind + ':' + command.scope.storeId, command.scope);
    // References only suppress schema bytes after fresh SQL equality has
    // attested this exact metadata. A caller-supplied hash is never authority.
    const compact =
      metadataVerified &&
      command.catalogReference?.catalogHash === record.catalog_hash &&
      command.catalogReference?.version === String(record.version);
    const { metadata, ...summary } = record;
    return {
      ...(compact ? { ...summary, catalogReference: command.catalogReference } : record),
      exists: true,
      newStore,
      ...([2, 3].includes(revisionProfile) ? { revisionProfile } : {}),
      ...(command.scope.kind === 'cabinet' && directoryState196 ? { directoryState196 } : {}),
      ...(command.scope.kind === 'cabinet' && patientCapsule197 ? { patientCapsule197 } : {}),
    };
  } catch (error) {
    if (owned && transaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      clearTransaction();
    }
    throw error;
  }
}
async function authorityOperation(command) {
  if (intentOf(intentFrames) && command.op !== 'authorityVerify')
    throw fault('POSTGRES_AUTHORITY_INTENT_FORBIDDEN');
  if (command.op === 'authorityAcquire') {
    if (authority) throw fault('POSTGRES_AUTHORITY_ALREADY_OWNED');
    const socket = new Client({
      ...workerData.connection,
      application_name: 'cartoteca-assistant-authority',
      connectionTimeoutMillis: workerData.statementTimeoutMs,
    });
    const lockKey = key('cartoteca:assistant-authority:' + command.platformStoreId);
    let owned = false;
    socket.on('error', () => {
      owned = false;
    });
    try {
      await socket.connect();
      const result = await socket.query('SELECT pg_try_advisory_lock($1::bigint) AS owned', [
        lockKey,
      ]);
      if (result.rows[0]?.owned !== true) throw fault('POSTGRES_AUTHORITY_BUSY');
      owned = true;
      authority = { socket, lockKey, owned: () => owned };
      return true;
    } catch (error) {
      await socket.end().catch(() => {});
      if (error.code === 'POSTGRES_AUTHORITY_BUSY') throw error;
      throw fault('POSTGRES_AUTHORITY_UNAVAILABLE');
    }
  }
  if (!authority) return false;
  const current = authority;
  if (command.op === 'authorityRelease') {
    authority = null;
    let released = false;
    try {
      const result = await current.socket.query(
        'SELECT pg_advisory_unlock($1::bigint) AS released',
        [current.lockKey],
      );
      released = result.rows[0]?.released === true;
    } catch {
      /* A disconnected session has already lost its authority. */
    } finally {
      await current.socket.end().catch(() => {});
    }
    return released;
  }
  if (!current.owned()) return false;
  const unsigned = BigInt.asUintN(64, BigInt(current.lockKey));
  try {
    const result = await current.socket.query(
      "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND granted) AS owned",
      [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString()],
    );
    return result.rows[0]?.owned === true;
  } catch {
    return false;
  }
}
async function dispatch(command) {
  if (broken) throw fault('POSTGRES_CHANNEL_POISONED', { channelPoisoned: true });
  if (
    atomicStatementFailed &&
    !['commit', 'rollback', 'rollbackTo', 'release', 'shutdown'].includes(command.op)
  )
    throw fault('POSTGRES_ATOMIC_STATEMENT_FAILED');
  if (command.op === 'shutdown') {
    if (authority) {
      await authority.socket.end();
      authority = null;
    }
    await client.end();
    clearTransaction();
    return null;
  }
  if (command.op === 'verifyProfile') return statement(() => verifyProfile(command));
  if (command.op === 'inspect') return statement(() => inspect(command));
  if (['authorityAcquire', 'authorityVerify', 'authorityRelease'].includes(command.op))
    return authorityOperation(command);
  if (
    [
      'snapshotVersion',
      'cabinetReadBundle',
      'readonlyReadBatch',
      'execute',
      'begin',
      'savepoint',
      'release',
      'rollbackTo',
      'commit',
      'rollback',
      'cursorOpen',
      'cursorNext',
      'cursorClose',
    ].includes(command.op)
  )
    assertCommandAssetScope(command.scope);
  if (command.op === 'readonlyReadBatch') {
    if (
      Object.keys(command).sort().join(',') !== 'mutating,op,reads,scope' ||
      command.mutating !== false
    )
      throw readBatch.fault();
    scopeCheck(command.scope);
    const catalog = catalogFor(command.scope);
    readBatch.context(
      command.scope,
      catalog,
      intentFrames,
      revisionProfile,
      Boolean(verifiedLineage),
    );
    const reads = readBatch.reads(command.reads);
    // Every original compiled plan passes the ordinary intent/catalog/RLS
    // checks before the first query; there are no user SQL descriptors.
    for (const { plan } of reads)
      assertPlanIntent(
        [plan],
        command.scope,
        intentOf(intentFrames),
        queueDomainOf(intentFrames),
        compoundOf(intentFrames),
        catalog,
        scopedQueueOf(intentFrames),
        authOf(intentFrames),
        accountingOf(intentFrames),
      );
    return statement(async () => {
      await setScope(command.scope);
      const deadline = active?.sqlDeadline;
      if (!Number.isSafeInteger(deadline)) throw readBatch.fault('POSTGRES_READ_BATCH_INVALID');
      if (reads.length === 1) {
        const remaining = Math.floor(deadline - Date.now() - 25);
        if (remaining <= 1) throw readBatch.fault('POSTGRES_READ_BATCH_CAPACITY');
        const { plan, method } = reads[0];
        const text =
          method === 'get'
            ? `SELECT * FROM (${plan.text.replace(/;\s*$/, '')}) AS ct_first_row LIMIT 1`
            : plan.text;
        let result, pendingError;
        try {
          [, result] = await orderedResults([
            () =>
              client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining)]),
            () =>
              query(text, plan.values, { rows: readBatch.MAX_ROWS, bytes: readBatch.MAX_BYTES }),
          ]);
        } catch (error) {
          pendingError = error;
        }
        if (!pendingError || pendingError.code === 'POSTGRES_READ_BATCH_CAPACITY')
          await client.query("SELECT set_config('statement_timeout',$1,true)", [
            String(workerData.statementTimeoutMs),
          ]);
        if (pendingError) throw pendingError;
        if (Date.now() >= deadline) throw readBatch.fault('POSTGRES_READ_BATCH_CAPACITY');
        readBatch.replies([result], 1);
        return [result];
      }
      // Establish a conservative cutoff in the SERVER clock domain. Its sample
      // predates this reply, so clock skew cannot extend the transport deadline.
      const clock = await client.query(
        'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS clock_ms',
      );
      const reserve = 25 + 2 * readBatch.MAX_READS;
      const remaining = Math.floor(deadline - Date.now() - reserve);
      if (remaining <= 1) throw readBatch.fault('POSTGRES_READ_BATCH_CAPACITY');
      const cutoff = clock.rows[0]?.clock_ms;
      if (typeof cutoff !== 'bigint') throw readBatch.fault();
      const aggregate = { rows: 0, bytes: 0, overflow: false };
      const queued = [
        () =>
          client.query("SELECT set_config('cartoteca.read_batch_deadline142',$1,true)", [
            String(cutoff + BigInt(remaining)),
          ]),
      ];
      for (const { plan, method } of reads) {
        const text =
          method === 'get'
            ? `SELECT * FROM (${plan.text.replace(/;\s*$/, '')}) AS ct_first_row LIMIT 1`
            : plan.text;
        // All bounded pairs are queued before waiting. PostgreSQL computes the
        // remaining timeout when EACH pair reaches the server, never as zero.
        queued.push(
          () =>
            client.query(
              "SELECT set_config('statement_timeout',greatest(1,floor(current_setting('cartoteca.read_batch_deadline142')::numeric-extract(epoch FROM clock_timestamp())*1000))::text,true)",
            ),
          () => query(text, plan.values, { aggregate }),
        );
      }
      queued.push(
        () =>
          client.query(
            "SELECT extract(epoch FROM clock_timestamp())*1000 <= current_setting('cartoteca.read_batch_deadline142')::numeric AS within_deadline",
          ),
        () =>
          client.query("SELECT set_config('statement_timeout',$1,true)", [
            String(workerData.statementTimeoutMs),
          ]),
      );
      // Drain every queued command even on capacity/SQL failure. A real SQL
      // error takes priority over capacity; later 25P02 never hides its cause.
      const replies = await orderedResults(queued, {
        deferError: (error) => error?.code === 'POSTGRES_READ_BATCH_CAPACITY',
      });
      if (replies.at(-2)?.rows[0]?.within_deadline !== true || Date.now() >= deadline)
        throw readBatch.fault('POSTGRES_READ_BATCH_CAPACITY');
      const results = reads.map((_, index) => replies[2 + index * 2]);
      readBatch.replies(results, reads.length);
      return results;
    });
  }
  if (command.op === 'cabinetReadBundle') {
    if (
      Object.keys(command).sort().join(',') !== 'mutating,op,scope,selection' ||
      command.mutating !== false
    )
      throw cabinetReadBundle.fault();
    scopeCheck(command.scope);
    const catalog = catalogFor(command.scope);
    cabinetReadBundle.assertContext(
      command.scope,
      catalog,
      intentFrames,
      revisionProfile,
      Boolean(verifiedLineage),
    );
    const selection = cabinetReadBundle.selectionOf(command.selection);
    const plan = cabinetReadBundle.queryFor(command.scope, catalog, selection);
    return statement(async () => {
      await setScope(command.scope);
      const result = await query(plan.text, plan.values);
      const value = { rows: result.rows };
      cabinetReadBundle.unpack(value, selection, catalog.version);
      return value;
    });
  }
  if (command.op === 'snapshotVersion') {
    scopeCheck(command.scope);
    assertCompoundScope(command.scope, compoundOf(intentFrames));
    assertScopedQueueScope(command.scope, scopedQueueOf(intentFrames));
    if (revisionProfile !== 3 || !catalogFor(command.scope))
      throw fault('POSTGRES_SNAPSHOT_PROFILE_REQUIRED');
    return statement(async () => {
      await setScope(command.scope);
      const result = await query('SELECT pg_current_snapshot()::text AS snapshot');
      if (result.rows.length !== 1 || typeof result.rows[0].snapshot !== 'string')
        throw fault('POSTGRES_SNAPSHOT_INVALID');
      return result.rows[0].snapshot;
    });
  }
  if (command.op === 'execute') return execute(command);
  if (command.op === 'begin') {
    if (
      command.atomicStatements !== undefined &&
      (command.atomicStatements !== true ||
        !['SHARED', 'COMPOUND'].includes(command.mode) ||
        command.scope.kind !== 'platform' ||
        revisionProfile !== 3 ||
        !verifiedLineage)
    )
      throw fault('POSTGRES_ATOMIC_SHARED_SCOPE');
    await begin(
      command.scope,
      command.mode,
      command.queueDomain ?? null,
      command.compound ?? null,
      command.scopedQueue ?? null,
      command.auth ?? null,
      command.accounting ?? null,
    );
    atomicStatements = command.atomicStatements === true;
    return null;
  }
  if (command.op === 'savepoint') {
    if (command.queueDomain !== undefined) throw fault('POSTGRES_QUEUE_DOMAIN_UNAVAILABLE');
    if (command.compound !== undefined) throw fault('POSTGRES_COMPOUND_UNAVAILABLE');
    if (command.scopedQueue !== undefined) throw fault('POSTGRES_SCOPED_QUEUE_UNAVAILABLE');
    if (command.auth !== undefined) throw fault('POSTGRES_AUTH_NESTING');
    if (command.accounting !== undefined) throw fault('POSTGRES_ACCOUNTING_NESTING');
    if (
      !transaction ||
      !/^ct_sp_[0-9]+$/.test(command.name) ||
      intentFrames.some((frame) => frame.name === command.name)
    )
      throw fault('POSTGRES_TRANSACTION_NESTING');
    assertMode(command.scope, command.mode, intentFrames);
    await client.query(`SAVEPOINT ${command.name}`);
    intentFrames.push({ scope: command.scope, mode: command.mode, name: command.name });
    try {
      await acquire(command.scope, command.mode === 'IMMEDIATE' || command.mode === 'QUEUE');
    } catch (error) {
      intentFrames.pop();
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${command.name}`);
        await client.query(`RELEASE SAVEPOINT ${command.name}`);
        clearLocks();
      } catch {
        broken = true;
      }
      throw error;
    }
    return null;
  }
  if (['release', 'rollbackTo'].includes(command.op)) {
    if (
      !transaction ||
      !/^ct_sp_[0-9]+$/.test(command.name) ||
      intentFrames.at(-1)?.name !== command.name
    )
      throw fault('POSTGRES_TRANSACTION_NESTING');
    await client.query(
      `${command.op === 'release' ? 'RELEASE SAVEPOINT' : 'ROLLBACK TO SAVEPOINT'} ${command.name}`,
    );
    if (command.op === 'release') intentFrames.pop();
    // PostgreSQL releases post-savepoint locks and restores transaction settings.
    if (command.op === 'rollbackTo') clearLocks();
    return null;
  }
  if (command.op === 'commit' || command.op === 'rollback') {
    if (!transaction) throw fault('POSTGRES_TRANSACTION_MISSING');
    if (command.op === 'commit' && atomicStatementFailed) {
      // PostgreSQL can acknowledge COMMIT of an aborted transaction with a
      // ROLLBACK command tag. Never let that look like a successful mutation,
      // even if an internal caller caught the original SQL exception.
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
        await client.end().catch(() => {});
      } finally {
        clearTransaction();
        for (const [id, cursor] of cursors) if (!cursor.held) cursors.delete(id);
      }
      throw fault('POSTGRES_ATOMIC_STATEMENT_FAILED', {
        transactionOpen: false,
        channelPoisoned: broken,
        outcomeUnknown: broken,
      });
    }
    try {
      await client.query(command.op === 'commit' ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      if (command.op === 'commit' && !sqlState(error)) error.outcomeUnknown = true;
      if (sqlState(error))
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
      else broken = true;
      throw error;
    } finally {
      clearTransaction();
      for (const [id, cursor] of cursors) if (!cursor.held) cursors.delete(id);
    }
    return null;
  }
  if (command.op === 'cursorOpen') return cursorOpen(command);
  if (command.op === 'cursorNext' || command.op === 'cursorClose') {
    assertCompoundScope(command.scope, compoundOf(intentFrames));
    assertScopedQueueScope(command.scope, scopedQueueOf(intentFrames));
    const cursor = cursors.get(command.cursor);
    if (
      !cursor ||
      cursor.scope.kind !== command.scope.kind ||
      cursor.scope.storeId !== command.scope.storeId
    )
      throw fault('POSTGRES_CURSOR_SCOPE');
    return statement(async () => {
      await setScope(command.scope);
      if (command.op === 'cursorClose') {
        await client.query(`CLOSE "${command.cursor}"`);
        cursors.delete(command.cursor);
        return null;
      }
      const size =
        Number.isSafeInteger(command.size) && command.size >= 1 && command.size <= 512
          ? command.size
          : 128;
      return query(`FETCH FORWARD ${size} FROM "${command.cursor}"`);
    });
  }
  throw fault('POSTGRES_OPERATION_INVALID');
}
function publish(id, reply) {
  if (!active || active.id !== id || active.finished) return;
  active.finished = true;
  let bytes = v8.serialize({ id, ...reply });
  if (bytes.byteLength > workerData.maxReplyBytes)
    bytes = v8.serialize({
      id,
      ok: false,
      error: {
        code: 'POSTGRES_REPLY_TOO_LARGE',
        outcomeUnknown: active.command?.mutating === true,
        transactionOpen: transaction,
      },
    });
  Atomics.store(state, 2, id);
  Atomics.store(state, 1, bytes.byteLength);
  if (bytes.byteLength <= inline.length) {
    inline.set(bytes);
    Atomics.store(state, 0, 1);
  } else {
    const owned = Uint8Array.from(bytes);
    workerData.replyPort.postMessage({ id, bytes: owned.buffer }, [owned.buffer]);
    Atomics.store(state, 0, 2);
  }
  memorySampling?.publishIfDue();
  Atomics.notify(state, 0);
  if (active?.id === id && active.finished) active.command = null;
}
function errorShape(error, command) {
  const connectionFailure = !sqlState(error) && !String(error?.code || '').startsWith('POSTGRES_');
  return {
    code:
      sqlState(error) || String(error?.code || '').startsWith('POSTGRES_')
        ? error.code
        : 'POSTGRES_CONNECTION_FAILED',
    outcomeUnknown:
      error?.outcomeUnknown === true || (connectionFailure && command?.mutating === true),
    retryableBeforeBegin: error?.retryableBeforeBegin === true,
    channelPoisoned: broken || connectionFailure || error?.channelPoisoned === true,
    transactionOpen: transaction,
  };
}
client.on('error', (error) => {
  currentScope = null;
  broken = true;
  if (active && !active.finished)
    publish(active.id, { ok: false, error: errorShape(error, active.command) });
  parentPort.postMessage({ type: 'fatal', code: 'POSTGRES_CONNECTION_FAILED' });
});
parentPort.on('message', async (message) => {
  if (message?.close === true) {
    await client.end().catch(() => {});
    process.exitCode = 0;
    parentPort.close();
    return;
  }
  if (active && !active.finished) return;
  if (
    !(message?.bytes instanceof ArrayBuffer) ||
    message.bytes.byteLength > workerData.maxCommandBytes
  )
    return;
  const id = message.id;
  active = { id, finished: false, command: null, sqlDeadline: message.sqlDeadline };
  try {
    const command = v8.deserialize(Buffer.from(message.bytes));
    active.command = command;
    const value = await dispatch(command);
    publish(id, { ok: true, value });
    if (command.op === 'shutdown') {
      workerData.replyPort.close();
      parentPort.close();
    }
  } catch (error) {
    currentScope = null;
    publish(id, { ok: false, error: errorShape(error, active.command) });
  }
});
(async () => {
  try {
    await client.connect();
    await client.query(
      "SELECT set_config('statement_timeout',$1,false),set_config('idle_in_transaction_session_timeout',$2,false)",
      [
        String(workerData.statementTimeoutMs),
        String(Math.max(30000, workerData.statementTimeoutMs)),
      ],
    );
    parentPort.postMessage({ type: 'ready' });
  } catch {
    parentPort.postMessage({ type: 'fatal', code: 'POSTGRES_CONNECTION_FAILED' });
    await client.end().catch(() => {});
    process.exitCode = 1;
    parentPort.close();
  }
})();
