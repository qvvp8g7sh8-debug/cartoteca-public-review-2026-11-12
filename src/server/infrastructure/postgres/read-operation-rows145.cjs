const { compile } = require('./dialect.cjs');
const { describeReadBatch } = require('./read-operation-batch151.cjs');
const { assertPlanIntent } = require('./lock-intents.cjs');
const { key: requestKey, read: assertRead } = require('./readonly-read-batch140.cjs');
const denied = (code) => Object.assign(Error(code), { code, status: 503 });
const canonicalShapeSql =
  'SELECT kind,id,patient_id,position,value FROM cabinet_patient_records LIMIT 0';
const canonicalColumns = [
  ['kind', 'TEXT'],
  ['id', 'TEXT'],
  ['patient_id', 'TEXT'],
  ['position', 'INTEGER'],
  ['value', 'BLOB'],
];
function emptyCanonicalShape(scope, catalog, sql, args, method) {
  if (
    scope.kind !== 'cabinet' ||
    catalog.version !== 2 ||
    sql !== canonicalShapeSql ||
    method !== 'all' ||
    args.length !== 0
  )
    return false;
  const columns = catalog.tables?.cabinet_patient_records?.columns;
  if (
    !Array.isArray(columns) ||
    columns.length !== canonicalColumns.length ||
    !canonicalColumns.every(
      ([name, type], index) => columns[index]?.name === name && columns[index]?.type === type,
    )
  )
    throw denied('POSTGRES_READ_OPERATION_CATALOG_SHAPE');
  return true;
}

function rows(result, plan) {
  const fields = plan.columns?.length
    ? plan.columns.map((name, index) => ({ ...result.fields[index], name }))
    : result.fields;
  return result.rows.map((values) =>
    Object.fromEntries(
      fields.map((field, index) => {
        let value = values[index];
        if (value != null && [20, 21, 23].includes(field.dataTypeID)) {
          value = Number(value);
          if (!Number.isSafeInteger(value)) throw denied('POSTGRES_INTEGER_RANGE');
        }
        if (value != null && field.dataTypeID === 16) value = value ? 1 : 0;
        if (value != null && field.dataTypeID === 1700) {
          value = Number(value);
          if (!Number.isFinite(value)) throw denied('POSTGRES_NUMERIC_RANGE');
        }
        return [field.name, Buffer.isBuffer(value) ? Buffer.from(value) : value];
      }),
    ),
  );
}
// One physical READONLY operation owns every descriptor and every encrypted row.
// These are materialized query results, never permissions or a cross-request cache.
function createOperationRows({ execute, snapshot, assertActive, maximumReads = 4096 }) {
  const requests = new WeakMap(),
    values = new Map(),
    stores = new Map();
  let issued = 0;
  function token(scope, catalog, sql, args, method) {
    assertActive();
    if (!['get', 'all'].includes(method)) throw denied('POSTGRES_QUERY_ONLY');
    const plan = compile(sql, { ...scope, revisionProfile: 3 }, args, method, catalog);
    assertPlanIntent(plan.steps || [plan], scope, 'READONLY', null, null, catalog);
    if (plan.effect !== 'read' || plan.steps || plan.control) throw denied('POSTGRES_QUERY_ONLY');
    const read = assertRead({ method, plan }),
      key = requestKey(scope, read),
      result = {};
    // The engine attests this catalog inside the owning RR and maintenance
    // guard. This exact constructor check returns no clinical rows by definition;
    // it is a catalog projection, not permission to fetch an unprobed table.
    if (emptyCanonicalShape(scope, catalog, sql, args, method))
      values.set(key, { rows: [], fields: [] });
    requests.set(result, { scope, plan, method, key, batch: describeReadBatch(catalog, sql) });
    return result;
  }
  function requireRows(tokens) {
    assertActive();
    const missing = [],
      seen = new Set();
    for (const token of tokens) {
      const request = requests.get(token);
      if (!request) throw denied('POSTGRES_READ_OPERATION_TOKEN');
      if (!values.has(request.key) && !seen.has(request.key)) {
        seen.add(request.key);
        missing.push(request);
      }
    }
    if (missing.length) {
      throw denied('POSTGRES_READ_OPERATION_NOT_MATERIALIZED');
    }
    return true;
  }
  function store(scope, catalog) {
    const identity = scope.kind + ':' + scope.storeId;
    if (stores.has(identity)) return stores.get(identity);
    const db = {
      dialect: 'postgres',
      revisionProfile: 3,
      catalog,
      isTransaction: true,
      transactionIntent: 'READONLY',
      localMutationClock: 0,
      canPrefetchReads: true,
      newStore: false,
      snapshotVersion: () => {
        assertActive();
        return snapshot;
      },
      readSnapshotIdentity: () => {
        assertActive();
        return db;
      },
      prefetchReads: requireRows,
      prefetchAll,
      prepare(sql) {
        return {
          readRequest: (method, args) => token(scope, catalog, sql, args, method),
          get(...args) {
            if (/^PRAGMA\s+user_version\s*;?$/i.test(sql)) return { user_version: catalog.version };
            const request = token(scope, catalog, sql, args, 'get');
            requireRows([request]);
            const entry = requests.get(request);
            return rows(values.get(entry.key), entry.plan)[0];
          },
          all(...args) {
            const request = token(scope, catalog, sql, args, 'all');
            requireRows([request]);
            const entry = requests.get(request);
            return rows(values.get(entry.key), entry.plan);
          },
          iterate(...args) {
            return this.all(...args)[Symbol.iterator]();
          },
          run() {
            throw denied('POSTGRES_QUERY_ONLY');
          },
          setReadBigInts() {
            throw denied('POSTGRES_READ_OPERATION_BIGINT');
          },
        };
      },
      exec() {
        throw denied('POSTGRES_QUERY_ONLY');
      },
      close() {},
    };
    stores.set(identity, db);
    return db;
  }
  async function prefetchAll(tokens) {
    assertActive();
    const reads = [],
      seen = new Set();
    for (const token of tokens) {
      const read = requests.get(token);
      if (!read) throw denied('POSTGRES_READ_OPERATION_TOKEN');
      if (!values.has(read.key) && !seen.has(read.key)) {
        seen.add(read.key);
        reads.push(read);
      }
    }
    if (!reads.length) return true;
    issued += reads.length;
    if (issued > maximumReads) throw denied('POSTGRES_READ_OPERATION_LIMIT');
    const results = await execute(reads);
    assertActive();
    if (results.length !== reads.length) throw denied('POSTGRES_READ_OPERATION_PROTOCOL');
    // No replay, suspension, fallback or partially published prefix. A pure
    // projection is run once, only after its explicit async preparation succeeds.
    results.forEach((result, index) => values.set(reads[index].key, result));
    return true;
  }

  return {
    store,
    prefetchAll,
    clear() {
      values.clear();
      stores.clear();
    },
  };
}
module.exports = { createOperationRows, operationRows: rows };
