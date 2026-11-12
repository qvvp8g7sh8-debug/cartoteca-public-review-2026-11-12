const test = require('node:test');
const { validatePaidSchema } = require('../src/server/modules/billing/prepared-schema.cjs');
const {
  validateMultiServiceSchema,
} = require('../src/server/modules/billing/multi-service-schema.cjs');
const {
  fixture,
  changeTable,
  withoutPrimaryKey,
  validateReadOnly,
} = require('./helpers/billing-schema-fixture.cjs');

const baseTables = [
  'billing_settings',
  'billing_organization_settings',
  'billing_wallets',
  'billing_reservations',
  'billing_entries',
  'billing_operations',
  'billing_service_connections',
  'billing_customer_operations',
  'billing_package_definitions',
  'billing_package_grants',
  'billing_package_tasks',
  'billing_package_operations',
  'billing_payment_settings',
  'billing_payment_orders',
  'billing_payment_operations',
];
const multiTables = ['billing_financial_actions', 'billing_grant_revocations', 'billing_services'];
function check(db, version, rejects = true) {
  validateReadOnly(db, validatePaidSchema, { rejects });
  if (version === 20) validateReadOnly(db, validateMultiServiceSchema, { rejects });
}
function modified(t, table, change, version = multiTables.includes(table) ? 20 : 19) {
  return fixture(t, {
    version,
    [multiTables.includes(table) ? 'changeMulti' : 'changeBase']: (sql) =>
      changeTable(sql, table, change),
  });
}

for (const version of [19, 20]) {
  for (const table of [...baseTables, ...(version === 20 ? multiTables : [])]) {
    test('schema' + version + ' rejects lost PRIMARY KEY on ' + table, (t) => {
      check(modified(t, table, withoutPrimaryKey, version), version);
    });
  }
}

const uniqueConstraints = [
  ['billing_wallets', 'organization_id TEXT UNIQUE', 'organization_id TEXT'],
  ['billing_entries', 'UNIQUE(wallet_id,idempotency_key),', ''],
  ['billing_entries', ',\n  UNIQUE(wallet_id,reservation_id,kind)', ''],
  ['billing_package_grants', 'source_order_id TEXT UNIQUE', 'source_order_id TEXT'],
  ['billing_package_tasks', ',\n UNIQUE(organization_id,account_id,session_hash,request_id)', ''],
  ['billing_payment_orders', 'provider_payment_id TEXT UNIQUE', 'provider_payment_id TEXT'],
  ['billing_payment_orders', ',UNIQUE(organization_id,request_id)', ''],
  ['billing_financial_actions', 'UNIQUE(actor_id,request_id),', ''],
  ['billing_financial_actions', ',UNIQUE(kind,provider_id)', ''],
];
for (const version of [19, 20]) {
  for (const [table, from, to] of uniqueConstraints) {
    if (version === 19 && multiTables.includes(table)) continue;
    test('schema' + version + ' rejects missing UNIQUE ' + table + ': ' + from, (t) => {
      check(
        modified(t, table, (ddl) => ddl.replace(from, to), version),
        version,
      );
    });
  }
}

const keyChanges = [
  ['billing_payment_orders', 'id TEXT PRIMARY KEY', 'id TEXT UNIQUE'],
  ['billing_operations', 'PRIMARY KEY(actor_id,request_id)', 'PRIMARY KEY(request_id,actor_id)'],
  [
    'billing_service_connections',
    'PRIMARY KEY(organization_id,service)',
    'PRIMARY KEY(service,organization_id)',
  ],
  ['billing_entries', 'UNIQUE(wallet_id,idempotency_key)', 'UNIQUE(idempotency_key,wallet_id)'],
  [
    'billing_payment_orders',
    'provider_payment_id TEXT UNIQUE',
    'provider_payment_id TEXT COLLATE NOCASE UNIQUE',
  ],
  [
    'billing_payment_orders',
    'UNIQUE(organization_id,request_id)',
    'UNIQUE(organization_id,request_id DESC)',
  ],
  ['billing_financial_actions', 'UNIQUE(kind,provider_id)', 'UNIQUE(provider_id,kind)'],
  ['billing_services', 'code TEXT PRIMARY KEY', 'code TEXT UNIQUE'],
];
for (const [table, from, to] of keyChanges) {
  test('rejects substituted constraint on ' + table + ': ' + from, (t) => {
    check(
      modified(t, table, (ddl) => ddl.replace(from, to)),
      multiTables.includes(table) ? 20 : 19,
    );
  });
}

test('same primary key name cannot cover a different column', (t) => {
  check(
    modified(t, 'billing_payment_settings', (ddl) =>
      withoutPrimaryKey(ddl).replace(/\);$/, ',PRIMARY KEY(revision));'),
    ),
    19,
  );
});

const conflictClauses = [
  ['billing_settings', 'id INTEGER PRIMARY KEY'],
  ['billing_payment_orders', 'id TEXT PRIMARY KEY'],
  ['billing_operations', 'PRIMARY KEY(actor_id,request_id)'],
  ['billing_payment_orders', 'provider_payment_id TEXT UNIQUE'],
  ['billing_payment_orders', 'UNIQUE(organization_id,request_id)'],
  ['billing_financial_actions', 'id TEXT PRIMARY KEY'],
  ['billing_financial_actions', 'UNIQUE(actor_id,request_id)'],
];
for (const [table, clause] of conflictClauses) {
  for (const policy of ['REPLACE', 'IGNORE']) {
    test('rejects changed conflict policy ' + policy + ' on ' + table + ': ' + clause, (t) => {
      check(
        modified(t, table, (ddl) => ddl.replace(clause, clause + ' ON CONFLICT ' + policy)),
        multiTables.includes(table) ? 20 : 19,
      );
    });
  }
}

const requiredKeyColumns = [
  ['billing_operations', ['actor_id', 'request_id']],
  ['billing_service_connections', ['organization_id', 'service']],
  ['billing_customer_operations', ['organization_id', 'account_id', 'request_id']],
  ['billing_package_operations', ['actor_id', 'request_id']],
  ['billing_payment_operations', ['actor_id', 'request_id']],
  ['billing_entries', ['wallet_id', 'idempotency_key', 'kind']],
  ['billing_package_tasks', ['organization_id', 'account_id', 'session_hash', 'request_id']],
  ['billing_payment_orders', ['organization_id', 'request_id', 'state']],
  ['billing_financial_actions', ['actor_id', 'request_id', 'kind', 'order_id', 'state']],
];
for (const [table, columns] of requiredKeyColumns) {
  for (const column of columns) {
    test('rejects nullable identity column ' + table + '.' + column, (t) => {
      const from = column + ' TEXT NOT NULL';
      check(
        modified(t, table, (ddl) => ddl.replace(from, column + ' TEXT')),
        multiTables.includes(table) ? 20 : 19,
      );
    });
  }
}

test('schema20 payment open-state predicate rejects a nullable state column', (t) => {
  const db = modified(
    t,
    'billing_payment_orders',
    (ddl) => ddl.replace('state TEXT NOT NULL', 'state TEXT'),
    20,
  );
  check(db, 20);
});

test('schema20 service key remains nonnull even though its column is added later', (t) => {
  const db = fixture(t, {
    version: 20,
    changeMulti: (sql) =>
      sql.replace(
        'ALTER TABLE billing_payment_orders ADD COLUMN service_code TEXT NOT NULL',
        'ALTER TABLE billing_payment_orders ADD COLUMN service_code TEXT',
      ),
  });
  check(db, 20);
});

for (const version of [19, 20]) {
  test(
    'conflict words in SQL comments and literals do not change schema' + version + ' constraints',
    (t) => {
      const db = fixture(t, {
        version,
        changeBase: (sql) =>
          changeTable(
            changeTable(sql, 'billing_payment_orders', (ddl) =>
              ddl.replace('id TEXT PRIMARY KEY', 'id TEXT PRIMARY KEY /* ON CONFLICT REPLACE */'),
            ),
            'billing_package_definitions',
            (ddl) =>
              ddl.replace(
                'title TEXT NOT NULL',
                "title TEXT NOT NULL DEFAULT 'ON CONFLICT IGNORE'",
              ),
          ),
      });
      check(db, version, false);
    },
  );
}
