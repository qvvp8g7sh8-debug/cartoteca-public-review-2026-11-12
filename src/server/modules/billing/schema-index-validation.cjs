// Read-only contracts for the prepared billing schemas. Never repair live DDL.
const paidKeys = {
  billing_settings: { primary: ['id'], integer: true },
  billing_organization_settings: { primary: ['organization_id'] },
  billing_wallets: {
    primary: ['id'],
    unique: [['organization_id']],
    nullable: ['organization_id'],
  },
  billing_reservations: { primary: ['id'] },
  billing_entries: {
    primary: ['id'],
    unique: [
      ['wallet_id', 'idempotency_key'],
      ['wallet_id', 'reservation_id', 'kind'],
    ],
    nullable: ['reservation_id'],
  },
  billing_operations: { primary: ['actor_id', 'request_id'] },
  billing_service_connections: { primary: ['organization_id', 'service'] },
  billing_customer_operations: { primary: ['organization_id', 'account_id', 'request_id'] },
  billing_package_definitions: { primary: ['id'] },
  billing_package_grants: {
    primary: ['id'],
    unique: [['source_order_id']],
    nullable: ['source_order_id'],
  },
  billing_package_tasks: {
    primary: ['id'],
    unique: [['organization_id', 'account_id', 'session_hash', 'request_id']],
  },
  billing_package_operations: { primary: ['actor_id', 'request_id'] },
  billing_payment_settings: { primary: ['id'], integer: true },
  billing_payment_orders: {
    primary: ['id'],
    unique: [['provider_payment_id'], ['organization_id', 'request_id']],
    nullable: ['provider_payment_id'],
  },
  billing_payment_operations: { primary: ['actor_id', 'request_id'] },
};
const multiServiceKeys = {
  billing_financial_actions: {
    primary: ['id'],
    unique: [
      ['actor_id', 'request_id'],
      ['kind', 'provider_id'],
    ],
    nullable: ['provider_id'],
  },
  billing_grant_revocations: { primary: ['grant_id'] },
  billing_services: { primary: ['code'] },
};
// Column directions are part of the contract, including non-unique read indexes.
const paidIndexes = [
  ['billing_reservations_org', 'billing_reservations', ['organization_id', 'state', 'created_at']],
  ['billing_entries_wallet', 'billing_entries', ['wallet_id', 'created_at DESC', 'id']],
  ['billing_entries_org', 'billing_entries', ['organization_id', 'created_at DESC']],
  [
    'billing_package_grants_org',
    'billing_package_grants',
    ['organization_id', 'ends_at DESC', 'starts_at DESC'],
  ],
  ['billing_package_tasks_quota', 'billing_package_tasks', ['grant_id', 'state']],
  [
    'billing_payment_orders_org',
    'billing_payment_orders',
    ['organization_id', 'created_at DESC', 'id'],
  ],
  [
    'billing_payment_revenue',
    'billing_payment_orders',
    ['test_mode', 'paid_confirmed_at', 'organization_id', 'price_kopecks'],
  ],
];
const openPayment = "state IN ('creating','pending','uncertain','review')";
const multiServiceIndexes = [
  [
    'billing_payment_open_service',
    'billing_payment_orders',
    ['organization_id', 'service_code'],
    openPayment,
  ],
  ['billing_financial_open_order', 'billing_financial_actions', ['order_id'], openPayment],
  [
    'billing_one_closing_receipt',
    'billing_financial_actions',
    ['order_id'],
    "kind='receipt' AND state NOT IN ('rejected','canceled')",
  ],
  [
    'billing_grants_org_service',
    'billing_package_grants',
    ['organization_id', 'service_code', 'ends_at DESC'],
  ],
];
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
function invalid(kind, name) {
  throw Error('Financial schema ' + kind + ' is invalid: ' + name);
}

// Preserve string literals exactly. Only SQL whitespace, keyword case and
// identifier quoting may differ; changed partial-index predicates fail closed.
function predicateTokens(value) {
  const token =
    /\s+|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[(),=]/giy;
  const result = [];
  while (token.lastIndex < value.length) {
    const match = token.exec(value);
    if (!match) return null;
    const part = match[0];
    if (/^\s/u.test(part)) continue;
    if (part.startsWith("'")) result.push(part);
    else if (/^["`\[]/u.test(part)) {
      const end = part[0] === '[' ? ']' : part[0];
      result.push(
        part
          .slice(1, -1)
          .replaceAll(end + end, end)
          .toLowerCase(),
      );
    } else result.push(part.toLowerCase());
  }
  return JSON.stringify(result);
}
function validateBillingIndexes(db, version) {
  const multiple = version >= 20;
  const keys = { ...paidKeys, ...(multiple ? multiServiceKeys : {}) };
  const tables = new Map();
  const tableColumns = new Map();
  for (const [table, contract] of Object.entries(keys)) {
    const definition = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    if (typeof definition?.sql !== 'string') invalid('table', table);
    // PRAGMA cannot distinguish ABORT from destructive REPLACE or silent IGNORE.
    // Ignore quoted values/identifiers and comments before inspecting SQL tokens.
    const ddl = definition.sql.replace(
      /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//gu,
      ' ',
    );
    if (/\bON\s+CONFLICT\b/iu.test(ddl)) invalid('conflict policy', table);
    const columns = db.prepare('PRAGMA table_info(' + quote(table) + ')').all();
    tableColumns.set(table, columns);
    const primary = columns.filter((row) => row.pk > 0).sort((a, b) => a.pk - b.pk);
    if (
      primary.length !== contract.primary.length ||
      primary.some((row, index) => row.name !== contract.primary[index] || row.pk !== index + 1)
    )
      invalid('primary key', table);
    // Canonical single-column PKs are nullable in SQLite metadata. Composite
    // keys and non-exempt UNIQUE columns explicitly require NOT NULL in DDL.
    const nullability = new Map(contract.primary.map((name) => [name, Number(primary.length > 1)]));
    for (const name of (contract.unique || []).flat())
      nullability.set(name, Number(!contract.nullable?.includes(name)));
    for (const [name, required] of nullability)
      if (columns.find((column) => column.name === name)?.notnull !== required)
        invalid('key nullability', table + '.' + name);
    const indexes = db.prepare('PRAGMA index_list(' + quote(table) + ')').all();
    const described = indexes.map((row) => ({
      ...row,
      columns: db
        .prepare('PRAGMA index_xinfo(' + quote(row.name) + ')')
        .all()
        .filter((column) => column.key === 1)
        .sort((a, b) => a.seqno - b.seqno),
    }));
    tables.set(table, described);
    const primaryIndexes = described.filter((row) => row.origin === 'pk');
    if (contract.integer) {
      // INTEGER PRIMARY KEY is a rowid alias and has no separate PK index.
      if (primary[0].type.toUpperCase() !== 'INTEGER' || primaryIndexes.length)
        invalid('integer primary key', table);
    } else if (primaryIndexes.length !== 1 || !uniqueKey(primaryIndexes[0], contract.primary))
      invalid('primary index', table);
    for (const columns of contract.unique || [])
      if (!described.some((row) => row.origin === 'u' && uniqueKey(row, columns)))
        invalid('unique constraint', table + '(' + columns.join(',') + ')');
  }
  const indexes = paidIndexes.concat(
    multiple
      ? multiServiceIndexes
      : [['billing_payment_open_org', 'billing_payment_orders', ['organization_id'], openPayment]],
  );
  for (const [name, table, columns, predicate] of indexes) {
    const row = tables.get(table).find((entry) => entry.name === name);
    const definition = db
      .prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='index' AND name=?")
      .get(name);
    if (
      !row ||
      row.origin !== 'c' ||
      row.unique !== Number(Boolean(predicate)) ||
      row.partial !== Number(Boolean(predicate)) ||
      definition?.tbl_name !== table ||
      typeof definition.sql !== 'string' ||
      !keyColumns(row, columns)
    )
      invalid('index', name);
    if (predicate)
      // All canonical partial UNIQUE indexes require non-null keys and state.
      // NULL would otherwise bypass both uniqueness and the state predicate.
      for (const column of columns.concat('state'))
        if (tableColumns.get(table).find((entry) => entry.name === column)?.notnull !== 1)
          invalid('index key nullability', table + '.' + column);
    const where = /\bWHERE\s+([\s\S]*?)\s*;?\s*$/iu.exec(definition.sql);
    if (predicate ? !where || predicateTokens(where[1]) !== predicateTokens(predicate) : where)
      invalid('index predicate', name);
  }
}
function keyColumns(row, columns) {
  return (
    row.columns.length === columns.length &&
    row.columns.every((column, index) => {
      const [name, direction] = columns[index].split(' ');
      return (
        column.cid >= 0 &&
        column.name === name &&
        column.desc === Number(direction === 'DESC') &&
        column.coll?.toUpperCase() === 'BINARY'
      );
    })
  );
}
function uniqueKey(row, columns) {
  return row.unique === 1 && row.partial === 0 && keyColumns(row, columns);
}
module.exports = { validateBillingIndexes };
