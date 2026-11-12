const {
  assertMode,
  intentOf,
  queueDomainOf,
  compoundOf,
  scopedQueueOf,
  authOf,
  accountingOf,
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
const { authScope, assertAuthScope } = require('./auth-intent137.cjs');
const { accountingScope, assertAccountingScope } = require('./assistant-accounting145.cjs');
const { createTransport, failure } = require('./transport.cjs');
const cabinetReadBundle = require('./cabinet-read-bundle136.cjs');
const readBatch = require('./readonly-read-batch140.cjs');
const INTEGER_TYPES = new Set([20, 21, 23]);
function scopeOf(input) {
  const storeId = input?.storeId ?? input?.id;
  if (
    !input ||
    !['platform', 'cabinet', 'budget'].includes(input.kind) ||
    typeof storeId !== 'string' ||
    !storeId ||
    storeId.length > 256
  )
    throw failure('POSTGRES_SCOPE_INVALID');
  return Object.freeze({
    kind: input.kind,
    storeId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  });
}
function createPostgresCoordinator(options = {}) {
  if (options.allowBlocking !== true) throw failure('POSTGRES_ISOLATED_OWNER_REQUIRED');
  const transport = options.transport || createTransport(options);
  const compiler = options.compile || ((...args) => require('./dialect.cjs').compile(...args));
  const frames = [];
  const handles = new Set();
  const mutationClocks = new Map();
  const transactionScopes = new Map();
  const readRequests = new WeakMap();
  function clearPrefetched() {
    if (frames[0]) {
      delete frames[0].prefetchedReads;
      delete frames[0].prefetchEpoch;
    }
  }
  const metadataCache = require('./catalog-metadata-cache136.cjs').createCatalogMetadataCache136();
  let closed = false;
  let savepoint = 0;
  let verifiedProfile = null;
  let verifiedLineage = null;
  const scopeKey = (scope) => scope.kind + ':' + scope.storeId;
  function touch(scope) {
    clearPrefetched();
    const key = scopeKey(scope),
      value = mutationClocks.get(key) || 0;
    if (value >= Number.MAX_SAFE_INTEGER) throw failure('POSTGRES_MUTATION_CLOCK_EXHAUSTED');
    mutationClocks.set(key, value + 1);
    if (frames[0]) delete frames[0].snapshotVersion;
  }
  function call(command, mutating = false) {
    if (command.op === 'execute' && mutating) touch(command.scope);
    if (['rollback', 'rollbackTo'].includes(command.op)) {
      // Released cabinet savepoints still belong to an outer rollback. Keep
      // every visited physical scope until the outer transaction has settled.
      for (const scope of transactionScopes.values()) touch(scope);
    }
    try {
      return transport.request({ ...command, mutating }, { mutating });
    } catch (error) {
      clearPrefetched();
      // A failed native operation may leave the owning transaction aborted.
      // Its prior snapshot must never hide that error before ROLLBACK.
      if (frames[0]) delete frames[0].snapshotVersion;
      if (error.transactionOpen === false) {
        for (const scope of transactionScopes.values()) touch(scope);
        frames.length = 0;
        transactionScopes.clear();
      }
      if (error.code === 'POSTGRES_BUSY') {
        error.postgresCode = error.code;
        error.code = 'ERR_SQLITE_ERROR';
        error.errcode = 5;
        error.status = 503;
      }
      throw error;
    }
  }
  function inspect(input) {
    const scope = scopeOf(input);
    assertCompoundScope(scope, compoundOf(frames));
    assertScopedQueueScope(scope, scopedQueueOf(frames));
    assertAuthScope(scope, authOf(frames));
    assertAccountingScope(scope, accountingOf(frames));
    if (verifiedLineage) {
      const expected = verifiedLineage.scopes.get(scopeKey(scope));
      if (expected) assertKnownScope(scope, expected);
      else if (scope.kind !== 'cabinet' || scope.storeId !== scope.organizationId)
        throw failure('POSTGRES_ASSET_LINEAGE_MISMATCH');
    }
    const version =
      input.kind === 'cabinet' && input.allowCreate === true
        ? (input.schemaVersion ?? input.version) || 1
        : (input.schemaVersion ?? input.version);
    const reference = metadataCache.reference(scope.kind, version);
    const result = call(
      {
        op: 'inspect',
        scope,
        optional: input.optional === true,
        allowCreate: input.allowCreate === true,
        version,
        catalogHash: input.catalogHash,
        platformStoreId: input.platformStoreId,
        ...(reference ? { catalogReference: reference } : {}),
        ...([2, 3].includes(options.revisionProfile)
          ? { revisionProfile: options.revisionProfile }
          : {}),
      },
      input.allowCreate === true,
    );
    if (result.catalogReference !== undefined) {
      const metadata = metadataCache.resolve(scope.kind, result.catalogReference);
      if (
        !reference ||
        result.metadata !== undefined ||
        !metadata ||
        result.catalogReference.catalogHash !== reference.catalogHash ||
        result.catalogReference.version !== reference.version ||
        result.catalog_hash !== reference.catalogHash ||
        String(result.version) !== reference.version
      )
        throw failure('POSTGRES_CATALOG_INVALID');
      return { ...result, metadata };
    }
    if (
      result.metadata &&
      /^[a-f0-9]{64}$/.test(result.catalog_hash || '') &&
      result.version !== undefined
    )
      result.metadata = metadataCache.rememberValidated(scope, result);
    return result;
  }
  function open(input) {
    if (closed) throw failure('POSTGRES_CLOSED');
    const scope = scopeOf(input);
    assertCompoundScope(scope, compoundOf(frames));
    assertScopedQueueScope(scope, scopedQueueOf(frames));
    assertAuthScope(scope, authOf(frames));
    assertAccountingScope(scope, accountingOf(frames));
    const key = scopeKey(scope);
    const catalogInfo =
      options.transport && options.catalog
        ? {
            metadata: options.catalog,
            newStore: false,
            ...([2, 3].includes(options.revisionProfile)
              ? { revisionProfile: options.revisionProfile }
              : {}),
          }
        : inspect(input);
    const catalog = catalogInfo.metadata;
    if (!catalog || typeof catalog !== 'object') throw failure('POSTGRES_CATALOG_INVALID');
    if (
      [2, 3].includes(options.revisionProfile) &&
      catalogInfo.revisionProfile !== options.revisionProfile
    )
      throw failure('POSTGRES_REVISION_PROFILE_INVALID');
    // Profile comes from the native worker's attestation, never from caller scope.
    const compilerScope = Object.freeze({
      ...scope,
      ...([2, 3].includes(catalogInfo.revisionProfile)
        ? { revisionProfile: catalogInfo.revisionProfile }
        : {}),
    });
    let alive = true;
    let queryOnly = false;
    let busyTimeout = 5000;
    let lastInsertRowid = 0n;
    const active = () => frames.some((frame) => frame.key === key);
    const assertOpen = () => {
      if (!alive || closed) throw failure('POSTGRES_CLOSED');
    };
    function begin(
      mode,
      queueDomain = null,
      compoundInput = null,
      scopedInput = null,
      authInput = null,
      accountingInput = null,
      atomicStatements = false,
    ) {
      assertOpen();
      if (active()) throw failure('POSTGRES_TRANSACTION_NESTING');
      assertMode(scope, mode, frames);
      if (
        atomicStatements &&
        (!['SHARED', 'COMPOUND'].includes(mode) ||
          scope.kind !== 'platform' ||
          catalogInfo.revisionProfile !== 3 ||
          !verifiedLineage)
      )
        throw failure('POSTGRES_ATOMIC_SHARED_SCOPE');
      let accounting = null;
      if (mode === 'ACCOUNTING' || accountingInput !== null) {
        if (mode !== 'ACCOUNTING' || catalogInfo.revisionProfile !== 3 || frames.length)
          throw failure('POSTGRES_ACCOUNTING_UNAVAILABLE');
        accounting = accountingScope(accountingInput, scope);
        if (!verifiedLineage || verifiedLineage.platformStoreId !== scope.storeId)
          throw failure('POSTGRES_ASSET_LINEAGE_REQUIRED');
      }
      let auth = null;
      if (mode === 'AUTH' || authInput !== null) {
        if (mode !== 'AUTH' || catalogInfo.revisionProfile !== 3 || frames.length)
          throw failure('POSTGRES_AUTH_UNAVAILABLE');
        auth = authScope(authInput, scope);
        if (!verifiedLineage || verifiedLineage.platformStoreId !== scope.storeId)
          throw failure('POSTGRES_ASSET_LINEAGE_REQUIRED');
      }
      let scopedQueue = null;
      if (['QUEUEORG', 'QUEUEENTITY'].includes(mode) || scopedInput !== null) {
        if (
          !['QUEUEORG', 'QUEUEENTITY'].includes(mode) ||
          catalogInfo.revisionProfile !== 3 ||
          frames.length
        )
          throw failure('POSTGRES_SCOPED_QUEUE_UNAVAILABLE');
        scopedQueue = (mode === 'QUEUEORG' ? organizationQueueScope : entityQueueScope)(
          scopedInput,
          scope,
        );
        if (!verifiedLineage || verifiedLineage.platformStoreId !== scope.storeId)
          throw failure('POSTGRES_ASSET_LINEAGE_REQUIRED');
      }
      let compound = null;
      if (mode === 'COMPOUND' || compoundInput !== null) {
        if (mode !== 'COMPOUND' || catalogInfo.revisionProfile !== 3 || frames.length)
          throw failure('POSTGRES_COMPOUND_UNAVAILABLE');
        compound = compoundScope(compoundInput, scope);
        if (!verifiedLineage || verifiedLineage.platformStoreId !== compound.platformStoreId)
          throw failure('POSTGRES_ASSET_LINEAGE_REQUIRED');
        if (compound.cabinetStoreId) {
          const expected = verifiedLineage.scopes.get('cabinet:' + compound.cabinetStoreId);
          if (
            expected
              ? expected.organizationId !== compound.organizationId
              : compound.cabinetStoreId !== compound.organizationId
          )
            throw failure('POSTGRES_ASSET_LINEAGE_MISMATCH');
        }
        if (compound.cabinetStoreId) {
          const matching = [...handles].filter(
            (handle) =>
              handle.isOpen &&
              handle.scope.kind === 'cabinet' &&
              handle.scope.storeId === compound.cabinetStoreId,
          );
          if (
            !matching.length ||
            matching.some(
              (handle) =>
                handle.scope.organizationId &&
                handle.scope.organizationId !== compound.organizationId,
            )
          )
            throw failure('POSTGRES_COMPOUND_SCOPE_INVALID');
        }
      }
      if (queueDomain !== null) {
        assertQueueDomain(queueDomain);
        if (
          mode !== 'QUEUE' ||
          scope.kind !== 'platform' ||
          frames.length ||
          ![2, 3].includes(catalogInfo.revisionProfile)
        )
          throw failure('POSTGRES_QUEUE_DOMAIN_UNAVAILABLE');
      }
      if (
        queryOnly &&
        [
          'IMMEDIATE',
          'QUEUE',
          'COMPOUND',
          'QUEUEORG',
          'QUEUEENTITY',
          'AUTH',
          'ACCOUNTING',
        ].includes(mode)
      )
        throw failure('POSTGRES_QUERY_ONLY');
      if (frames.length && scope.kind === 'platform') throw failure('POSTGRES_TRANSACTION_ORDER');
      const name = frames.length ? 'ct_sp_' + ++savepoint : null;
      call(
        {
          op: name ? 'savepoint' : 'begin',
          scope,
          mode,
          ...(name ? { name } : {}),
          ...(queueDomain ? { queueDomain } : {}),
          ...(auth ? { auth: authInput } : {}),
          ...(accounting ? { accounting: accountingInput } : {}),
          ...(atomicStatements ? { atomicStatements: true } : {}),
          ...(scopedQueue ? { scopedQueue: scopedInput } : {}),
          ...(compound
            ? {
                compound: {
                  operation: compound.operation,
                  organizationId: compound.organizationId,
                  cabinetStoreId: compound.cabinetStoreId,
                },
              }
            : {}),
        },
        [
          'IMMEDIATE',
          'QUEUE',
          'COMPOUND',
          'QUEUEORG',
          'QUEUEENTITY',
          'AUTH',
          'ACCOUNTING',
        ].includes(mode),
      );
      frames.push({
        key,
        scope,
        mode,
        name,
        ...(queueDomain ? { queueDomain } : {}),
        ...(scopedQueue ? { scopedQueue } : {}),
        ...(compound ? { compound } : {}),
        ...(auth ? { auth } : {}),
        ...(accounting ? { accounting } : {}),
      });
      transactionScopes.set(key, scope);
    }
    function end(rollback) {
      assertOpen();
      const frame = frames.at(-1);
      if (!frame) {
        if (rollback) return;
        throw failure('POSTGRES_TRANSACTION_MISSING');
      }
      if (frame.key !== key) throw failure('POSTGRES_TRANSACTION_ORDER');
      if (frame.name) {
        if (rollback) call({ op: 'rollbackTo', name: frame.name, scope });
        call({ op: 'release', name: frame.name, scope });
      } else call({ op: rollback ? 'rollback' : 'commit', scope }, !rollback);
      if (!frame.name) clearPrefetched();
      frames.pop();
      if (!frame.name) transactionScopes.clear();
    }
    function control(sql) {
      const text = sql.trim().replace(/;\s*$/, '');
      const beginMatch =
        /^BEGIN(?:\s+(DEFERRED|IMMEDIATE|SHARED|QUEUE|READONLY))?(?:\s+TRANSACTION)?$/i.exec(text);
      if (beginMatch) {
        begin((beginMatch[1] || 'DEFERRED').toUpperCase());
        return true;
      }
      if (/^(COMMIT|END)(?:\s+TRANSACTION)?$/i.test(text)) {
        end(false);
        return true;
      }
      if (/^ROLLBACK(?:\s+TRANSACTION)?$/i.test(text)) {
        end(true);
        return true;
      }
      const timeout = /^PRAGMA\s+busy_timeout\s*=\s*(\d+)$/i.exec(text);
      if (timeout) {
        const value = Number(timeout[1]);
        if (!Number.isSafeInteger(value) || value > 300000)
          throw failure('POSTGRES_TIMEOUT_INVALID');
        busyTimeout = value;
        return true;
      }
      const readOnly = /^PRAGMA\s+query_only\s*=\s*(ON|OFF|1|0)$/i.exec(text);
      if (readOnly) {
        queryOnly = /^(ON|1)$/i.test(readOnly[1]);
        return true;
      }
      return false;
    }
    function compile(sql, args, method) {
      assertOpen();
      const plan = compiler(sql, compilerScope, args, method, catalog);
      if (!plan || typeof plan !== 'object') throw failure('POSTGRES_PLAN_INVALID');
      assertPlanIntent(
        plan.steps || [plan],
        scope,
        intentOf(frames),
        queueDomainOf(frames),
        compoundOf(frames),
        catalog,
        scopedQueueOf(frames),
        authOf(frames),
        accountingOf(frames),
      );
      const writes = plan.effect === 'write' || plan.steps?.some((step) => step.effect === 'write');
      if (
        writes &&
        (queryOnly ||
          (frames.some((frame) => frame.scope.kind === 'platform' && frame.mode === 'SHARED') &&
            scope.kind === 'platform'))
      )
        throw failure('POSTGRES_QUERY_ONLY');
      return plan;
    }
    function resultRows(result, plan, readBigInts) {
      if (!result || !Array.isArray(result.rows) || !Array.isArray(result.fields))
        throw failure('POSTGRES_RESULT_INVALID');
      const explicit = new Set(plan.columns || []);
      return result.rows.map((source) => {
        const row = {};
        for (const field of result.fields) {
          if (['_store_id', '_rowid'].includes(field.name) && !explicit.has(field.name)) continue;
          let value = source[field.name];
          if (value !== null && value !== undefined && INTEGER_TYPES.has(field.dataTypeID)) {
            if (readBigInts) value = BigInt(value);
            else {
              value = Number(value);
              if (!Number.isSafeInteger(value)) throw failure('POSTGRES_INTEGER_RANGE');
            }
          }
          if (value !== null && value !== undefined && field.dataTypeID === 16)
            value = readBigInts ? (value ? 1n : 0n) : value ? 1 : 0;
          if (value !== null && value !== undefined && field.dataTypeID === 1700) {
            const text = String(value);
            if (/^[+-]?\d+(?:\.0+)?$/.test(text)) {
              const integer = BigInt(text.replace(/\.0+$/, ''));
              value = readBigInts ? integer : Number(integer);
              if (!readBigInts && !Number.isSafeInteger(value))
                throw failure('POSTGRES_INTEGER_RANGE');
            } else {
              value = Number(text);
              if (!Number.isFinite(value)) throw failure('POSTGRES_NUMERIC_RANGE');
            }
          }
          Object.defineProperty(row, field.name, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return row;
      });
    }
    function assertPrefetch() {
      assertOpen();
      assertCompoundScope(scope, compoundOf(frames));
      assertScopedQueueScope(scope, scopedQueueOf(frames));
      assertAuthScope(scope, authOf(frames));
      assertAccountingScope(scope, accountingOf(frames));
      readBatch.context(
        scope,
        catalog,
        frames,
        catalogInfo.revisionProfile,
        Boolean(verifiedLineage),
      );
      const channel = transport.stats();
      if (channel.ready !== true || channel.poisoned || channel.closed || channel.exited)
        throw failure('POSTGRES_READ_BATCH_SCOPE');
      return frames[0];
    }
    function canPrefetch() {
      try {
        assertPrefetch();
        return true;
      } catch (error) {
        if (error.code === 'POSTGRES_READ_BATCH_SCOPE') return false;
        throw error;
      }
    }
    function prefetchReads(tokens) {
      if (!canPrefetch()) return false;
      if (!Array.isArray(tokens) || tokens.length > readBatch.MAX_READS) return false;
      if (!tokens.length) return true;
      const root = assertPrefetch();
      const pending = new Map();
      for (const token of tokens) {
        const request = readRequests.get(token);
        if (
          !request ||
          request.handle !== handle ||
          request.root !== root ||
          !root.prefetchEpoch ||
          request.epoch !== root.prefetchEpoch
        )
          throw failure('POSTGRES_READ_BATCH_TOKEN');
        const plan = request.plan;
        assertPlanIntent(
          [plan],
          scope,
          intentOf(frames),
          queueDomainOf(frames),
          compoundOf(frames),
          catalog,
          scopedQueueOf(frames),
          authOf(frames),
          accountingOf(frames),
        );
        const read = { method: request.method, plan };
        const key = readBatch.key(scope, read);
        if (!root.prefetchedReads?.values.has(key)) pending.set(key, read);
      }
      if (!pending.size) return true;
      const previous = root.prefetchedReads;
      if ((previous?.values.size || 0) + pending.size > readBatch.MAX_READS) return false;
      const reads = [...pending.values()];
      try {
        readBatch.reads(reads);
        const replies = call({ op: 'readonlyReadBatch', scope, reads });
        const total = readBatch.replies(replies, reads.length);
        const current = assertPrefetch();
        if (current !== root) throw failure('POSTGRES_READ_BATCH_SCOPE');
        if (
          (previous?.rows || 0) + total.rows > readBatch.MAX_ROWS ||
          (previous?.bytes || 0) + total.bytes > readBatch.MAX_BYTES
        )
          return false;
        const values = new Map(previous?.values || []);
        [...pending.keys()].forEach((key, i) => values.set(key, readBatch.clone(replies[i])));
        root.prefetchedReads = {
          values,
          rows: (previous?.rows || 0) + total.rows,
          bytes: (previous?.bytes || 0) + total.bytes,
        };
        return true;
      } catch (error) {
        if (
          error.code === 'POSTGRES_READ_BATCH_CAPACITY' &&
          error.transactionOpen !== false &&
          canPrefetch()
        )
          return false;
        throw error;
      }
    }
    function executeWriteBatch(entries) {
      assertOpen();
      if (!active() || !Array.isArray(entries) || !entries.length || entries.length > 32)
        throw failure('POSTGRES_WRITE_BATCH_CONTEXT');
      const steps = entries.map((entry) => {
        if (!entry || typeof entry.sql !== 'string' || !Array.isArray(entry.args))
          throw failure('POSTGRES_WRITE_BATCH_INVALID');
        const plan = compile(entry.sql, entry.args, 'exec');
        if (
          plan.effect !== 'write' ||
          plan.steps ||
          plan.control ||
          plan.returningId ||
          /\bRETURNING\b/i.test(plan.text)
        )
          throw failure('POSTGRES_WRITE_BATCH_INVALID');
        return plan;
      });
      // Ordinary execute validates every original plan again on the physical
      // owner, then runs them in order under ONE statement savepoint. No new
      // authority or SQL opcode is introduced; errors never replay a prefix.
      call(
        {
          op: 'execute',
          scope,
          method: 'exec',
          plan: { effect: 'write', writeBatch155: true, steps },
        },
        true,
      );
    }
    function prepare(sql) {
      assertOpen();
      if (typeof sql !== 'string' || !sql.trim()) throw failure('POSTGRES_SQL_INVALID');
      let readBigInts = false;
      const native = (args, method) => {
        const plan = compile(sql, args, method);
        const cache = frames[0]?.prefetchedReads;
        if (cache && ['get', 'all'].includes(method) && canPrefetch()) {
          const cacheKey = readBatch.keyOrNull(scope, { method, plan });
          const cached = cacheKey && cache.values.get(cacheKey);
          if (cached) return { plan, result: readBatch.clone(cached) };
        }
        const result = call(
          { op: 'execute', plan, scope, method },
          plan.effect === 'write' || plan.steps?.some((step) => step.effect === 'write'),
        );
        return { plan, result };
      };
      const setting = () => {
        if (/^\s*PRAGMA\s+busy_timeout\s*;?\s*$/i.test(sql)) return { timeout: busyTimeout };
        if (/^\s*PRAGMA\s+query_only\s*;?\s*$/i.test(sql)) return { query_only: queryOnly ? 1 : 0 };
        return null;
      };
      const statement = {
        readRequest(method, args) {
          const root = assertPrefetch();
          if (!Array.isArray(args)) throw failure('POSTGRES_READ_BATCH_TOKEN');
          const copied = readBatch.clone(args);
          const plan = compile(sql, copied, method);
          readBatch.read({ method, plan });
          root.prefetchEpoch ||= Object.freeze({});
          const token = Object.freeze({});
          readRequests.set(token, {
            handle,
            root,
            epoch: root.prefetchEpoch,
            plan: readBatch.clone(plan),
            method,
          });
          return token;
        },
        get(...args) {
          assertOpen();
          const local = setting();
          if (local) {
            if (args.length) throw failure('POSTGRES_ARGUMENT_COUNT');
            return local;
          }
          const { plan, result } = native(args, 'get');
          return resultRows(result, plan, readBigInts)[0];
        },
        all(...args) {
          assertOpen();
          const local = setting();
          if (local) {
            if (args.length) throw failure('POSTGRES_ARGUMENT_COUNT');
            return [local];
          }
          const { plan, result } = native(args, 'all');
          return resultRows(result, plan, readBigInts);
        },
        run(...args) {
          assertOpen();
          if (!args.length && control(sql))
            return { changes: 0, lastInsertRowid: readBigInts ? 0n : 0 };
          const { plan, result } = native(args, 'run');
          const last = plan.returningId ? result.rows[0]?.[plan.returningId] : undefined;
          if (last !== undefined && last !== null) lastInsertRowid = BigInt(last);
          let id = lastInsertRowid;
          if (readBigInts) id = BigInt(id);
          else {
            id = Number(id);
            if (!Number.isSafeInteger(id)) throw failure('POSTGRES_INTEGER_RANGE');
          }
          return { changes: plan.effect === 'write' ? result.rowCount : 0, lastInsertRowid: id };
        },
        *iterate(...args) {
          assertOpen();
          const local = setting();
          if (local) {
            if (args.length) throw failure('POSTGRES_ARGUMENT_COUNT');
            yield local;
            return;
          }
          const plan = compile(sql, args, 'iterate');
          const { cursor } = call({ op: 'cursorOpen', plan, scope });
          let failed = false;
          try {
            for (;;) {
              const result = call({
                op: 'cursorNext',
                cursor,
                scope,
                size: options.cursorPageSize || 128,
              });
              const rows = resultRows(result, plan, readBigInts);
              if (!rows.length) break;
              yield* rows;
            }
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            try {
              call({ op: 'cursorClose', cursor, scope });
            } catch (error) {
              if (!failed) throw error;
            }
          }
        },
        setReadBigInts(value) {
          readBigInts = !!value;
          return statement;
        },
      };
      return statement;
    }
    function transaction(callback, mode) {
      begin(mode);
      try {
        const result = callback();
        if (result && typeof result.then === 'function')
          throw failure('POSTGRES_ASYNC_TRANSACTION');
        end(false);
        return result;
      } catch (error) {
        if (active())
          try {
            end(true);
          } catch (rollbackError) {
            if (!error.outcomeUnknown) error = rollbackError;
          }
        throw error;
      }
    }
    const handle = {
      get isOpen() {
        return alive && !closed && !transport.stats().poisoned;
      },
      get isTransaction() {
        return active();
      },
      get dialect() {
        return 'postgres';
      },
      get revisionProfile() {
        return [2, 3].includes(catalogInfo.revisionProfile) ? catalogInfo.revisionProfile : 1;
      },
      get directoryState196() {
        const state = catalogInfo.directoryState196;
        if (!state) return null;
        if (
          catalogInfo.revisionProfile !== 3 ||
          state.version !== 1 ||
          !/^[a-f0-9-]{36}$/.test(state.epoch || '') ||
          !/^[a-f0-9]{64}$/.test(state.digest || '') ||
          state.maxChanges !== 4096 ||
          state.seqWindow !== 128
        )
          throw failure('POSTGRES_DIRECTORY_STATE_INVALID');
        return Object.freeze({ ...state });
      },
      get patientCapsule197() {
        const state = catalogInfo.patientCapsule197;
        if (!state) return null;
        if (
          catalogInfo.revisionProfile !== 3 ||
          state.version !== 1 ||
          !/^[a-f0-9-]{36}$/.test(state.epoch || '') ||
          !/^[a-f0-9]{64}$/.test(state.digest || '') ||
          !state.hotMetadata169 ||
          state.hotMetadata169.version !== 1 ||
          !/^[a-f0-9-]{36}$/.test(state.hotMetadata169.epoch || '') ||
          !/^[a-f0-9]{64}$/.test(state.hotMetadata169.digest || '') ||
          !/^[a-f0-9-]{36}$/.test(state.hotMetadata169.readScopes?.epoch || '') ||
          !/^[a-f0-9]{64}$/.test(state.hotMetadata169.readScopes?.digest || '')
        )
          throw failure('POSTGRES_PATIENT_CAPSULE_INVALID');
        return Object.freeze({
          ...state,
          hotMetadata169: Object.freeze({
            ...state.hotMetadata169,
            readScopes: Object.freeze({ ...state.hotMetadata169.readScopes }),
          }),
        });
      },
      get authScope() {
        return authOf(frames);
      },
      get scopedQueue() {
        return scopedQueueOf(frames);
      },
      get transactionIntent() {
        return compoundOf(frames)
          ? 'COMPOUND'
          : scopedQueueOf(frames)
            ? scopedQueueOf(frames).type === 'organization'
              ? 'QUEUEORG'
              : 'QUEUEENTITY'
            : intentOf(frames);
      },
      get localMutationClock() {
        return mutationClocks.get(key) || 0;
      },
      get newStore() {
        return catalogInfo.newStore === true;
      },
      get catalog() {
        return catalog;
      },
      get catalogInfo() {
        return catalogInfo;
      },
      get scope() {
        return scope;
      },
      get canPrefetchReads() {
        return canPrefetch();
      },
      prefetchReads,
      get canReadSelectedBundle() {
        assertOpen();
        try {
          cabinetReadBundle.assertContext(
            scope,
            catalog,
            frames,
            catalogInfo.revisionProfile,
            Boolean(verifiedLineage),
          );
          return true;
        } catch (error) {
          if (error.code === 'POSTGRES_READ_BUNDLE_SCOPE') return false;
          throw error;
        }
      },
      readSelectedBundle:
        scope.kind === 'cabinet' &&
        catalogInfo.revisionProfile === 3 &&
        [1, 2].includes(catalog.version)
          ? (patientIds, serviceIds) => {
              assertOpen();
              cabinetReadBundle.assertContext(
                scope,
                catalog,
                frames,
                catalogInfo.revisionProfile,
                Boolean(verifiedLineage),
              );
              const selection = cabinetReadBundle.selectionOf({
                operation: cabinetReadBundle.OPERATION,
                patientIds,
                serviceIds,
              });
              const value = call({ op: 'cabinetReadBundle', scope, selection });
              return cabinetReadBundle.unpack(value, selection, catalog.version);
            }
          : null,
      prepare,
      beginQueue: (domain) => begin('QUEUE', domain),
      beginQueueOrganization: (input) => begin('QUEUEORG', null, null, input),
      beginQueueEntity: (input) => begin('QUEUEENTITY', null, null, input),
      beginCompound: (input) => begin('COMPOUND', null, input),
      beginAuth: (input) => begin('AUTH', null, null, null, input),
      beginAccounting: (input) => begin('ACCOUNTING', null, null, null, null, input),
      get accountingCapability() {
        return accountingOf(frames);
      },
      readSnapshotIdentity() {
        assertOpen();
        const root = frames[0];
        if (!root || root.mode !== 'READONLY' || frames.some((frame) => frame.mode !== 'READONLY'))
          throw failure('POSTGRES_QUERY_SNAPSHOT_INVALID');
        // Includes current scope/transport checks and an SQL probe after a prior failure.
        handle.snapshotVersion();
        return (root.readIdentity ||= Object.freeze({}));
      },
      snapshotVersion() {
        assertOpen();
        if (catalogInfo.revisionProfile !== 3) throw failure('POSTGRES_SNAPSHOT_PROFILE_REQUIRED');
        assertCompoundScope(scope, compoundOf(frames));
        assertScopedQueueScope(scope, scopedQueueOf(frames));
        assertAuthScope(scope, authOf(frames));
        assertAccountingScope(scope, accountingOf(frames));
        // A physical READONLY root owns one fixed REPEATABLE READ snapshot.
        // Nested scopes share it; no value survives root COMMIT/ROLLBACK. Other
        // intents and unframed reads must observe a fresh snapshot every time.
        const root = frames[0]?.mode === 'READONLY' ? frames[0] : null;
        if (root?.snapshotVersion) {
          const channel = transport.stats();
          if (channel.ready === true && !channel.poisoned && !channel.closed && !channel.exited)
            return root.snapshotVersion;
        }
        const value = call({ op: 'snapshotVersion', scope });
        if (typeof value !== 'string' || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(value))
          throw failure('POSTGRES_SNAPSHOT_INVALID');
        if (root) root.snapshotVersion = value;
        return value;
      },
      exec(sql) {
        assertOpen();
        if (typeof sql !== 'string') throw failure('POSTGRES_SQL_INVALID');
        if (control(sql)) return;
        const plan = compile(sql, [], 'exec');
        function executePlan(step) {
          if (step.control) {
            if (!control(step.control)) throw failure('POSTGRES_CONTROL_INVALID');
          } else if (step.effect === 'control' && step.steps) {
            for (const nested of step.steps) executePlan(nested);
          } else
            call({ op: 'execute', plan: step, scope, method: 'exec' }, step.effect === 'write');
        }
        executePlan(plan);
      },
      transaction: (callback, mode = 'IMMEDIATE') => transaction(callback, mode),
      sharedCommit: (callback) => transaction(callback, 'SHARED'),
      ...(catalogInfo.revisionProfile === 3 && scope.kind === 'platform'
        ? {
            beginAtomicShared: () => begin('SHARED', null, null, null, null, null, true),
            beginAtomicCompound: (input) => begin('COMPOUND', null, input, null, null, null, true),
          }
        : {}),
      ...(catalogInfo.revisionProfile === 3 && scope.kind === 'cabinet'
        ? { executeWriteBatch }
        : {}),
      close() {
        if (!alive) return;
        // Evicting an inactive cabinet does not change the owning physical RR.
        // Its closed statements/tokens still fail their ordinary handle guards.
        if (active()) {
          clearPrefetched();
          end(true);
        }
        alive = false;
        handles.delete(handle);
      },
    };
    handles.add(handle);
    return handle;
  }
  return {
    dialect: 'postgres',
    processRoles: options.processRoles || null,
    ready: () => transport.ready(),
    inspect,
    open,
    verifyProfile(profile) {
      if (closed) throw failure('POSTGRES_CLOSED');
      const { platformStoreId, migrationId, markerHash, lineage } = profile || {};
      const uuid = (value) =>
        typeof value === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
      if (
        !uuid(platformStoreId) ||
        !uuid(migrationId) ||
        typeof markerHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(markerHash)
      )
        throw failure('POSTGRES_ASSET_LINEAGE_MISMATCH');
      const verified =
        lineage === undefined
          ? null
          : assetLineage(lineage, { platformStoreId, migrationId, markerHash });
      const identity = JSON.stringify([
        platformStoreId,
        migrationId,
        markerHash,
        Boolean(verified),
      ]);
      if (verifiedProfile === identity) return true;
      if (
        call({
          op: 'verifyProfile',
          scope: { kind: 'platform', storeId: platformStoreId },
          migrationId,
          markerHash,
          ...(verified ? { lineage } : {}),
        }) !== true
      )
        throw failure('POSTGRES_ASSET_LINEAGE_MISMATCH');
      verifiedProfile = identity;
      if (verified) verifiedLineage = verified;
      return true;
    },
    acquireExecutorAuthority(platformStoreId) {
      if (typeof platformStoreId !== 'string' || !platformStoreId || platformStoreId.length > 256)
        throw failure('POSTGRES_SCOPE_INVALID');
      call({ op: 'authorityAcquire', platformStoreId });
      let released = false;
      const verifyOwnedSync = () => !released && call({ op: 'authorityVerify' }) === true;
      const release = () => {
        if (!released) {
          released = true;
          call({ op: 'authorityRelease' });
        }
      };
      return Object.freeze({
        verifyOwnedSync,
        assertOwned() {
          if (!verifyOwnedSync()) {
            const error = failure('POSTGRES_AUTHORITY_LOST');
            error.status = 503;
            throw error;
          }
        },
        close: release,
        release,
      });
    },
    closeSync() {
      clearPrefetched();
      closed = true;
      handles.clear();
      verifiedProfile = null;
      verifiedLineage = null;
      try {
        options.processRoles?.closeSync();
      } finally {
        try {
          transport.closeSync();
        } finally {
          frames.length = 0;
        }
      }
    },
    close() {
      clearPrefetched();
      closed = true;
      handles.clear();
      verifiedProfile = null;
      verifiedLineage = null;
      return Promise.allSettled([options.processRoles?.close(), transport.close()]).then(
        (results) => {
          frames.length = 0;
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
        },
      );
    },
    stats: () => ({ ...transport.stats(), stores: handles.size, transactions: frames.length }),
  };
}
module.exports = { createPostgresCoordinator, scopeOf };
