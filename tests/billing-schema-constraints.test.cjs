const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePaidSchema } = require('../src/server/modules/billing/prepared-schema.cjs');
const {
  validateMultiServiceSchema,
} = require('../src/server/modules/billing/multi-service-schema.cjs');
const { fixture, validateReadOnly } = require('./helpers/billing-schema-fixture.cjs');
const baseIndexes = [
  'billing_reservations_org',
  'billing_entries_wallet',
  'billing_entries_org',
  'billing_package_grants_org',
  'billing_package_tasks_quota',
  'billing_payment_orders_org',
  'billing_payment_revenue',
];
const multiIndexes = [
  'billing_grants_org_service',
  'billing_payment_open_service',
  'billing_financial_open_order',
  'billing_one_closing_receipt',
];

for (const version of [19, 20]) {
  test('canonical billing schema' + version + ' passes without any schema/data writes', (t) => {
    const db = fixture(t, { version });
    validateReadOnly(db, validatePaidSchema, { rejects: false });
    if (version === 20) validateReadOnly(db, validateMultiServiceSchema, { rejects: false });
  });

  const indexes = [
    ...baseIndexes,
    ...(version === 20 ? multiIndexes : ['billing_payment_open_org']),
  ];
  for (const name of indexes) {
    test('schema' + version + ' rejects missing named index ' + name, (t) => {
      const db = fixture(t, { version });
      db.exec('DROP INDEX ' + name);
      validateReadOnly(db, validatePaidSchema);
      if (version === 20) validateReadOnly(db, validateMultiServiceSchema);
    });
  }
}

function replaceIndex(db, name, ddl) {
  db.exec('DROP INDEX ' + name + ';' + ddl);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
}

const openStates = "state IN ('creating','pending','uncertain','review')";
for (const version of [19, 20]) {
  const name = version === 19 ? 'billing_payment_open_org' : 'billing_payment_open_service';
  const columns = version === 19 ? 'organization_id' : 'organization_id,service_code';
  const prefix = 'CREATE UNIQUE INDEX ' + name + ' ON billing_payment_orders(' + columns + ')';
  const substitutions = [
    ['nonunique with identical name', prefix.replace('UNIQUE ', '') + ' WHERE ' + openStates],
    ['wrong columns', prefix.replace('(' + columns + ')', '(account_id)') + ' WHERE ' + openStates],
    [
      'NOCASE collation',
      prefix.replace('(' + columns + ')', '(' + columns + ' COLLATE NOCASE)') +
        ' WHERE ' +
        openStates,
    ],
    [
      'expression key',
      prefix.replace('(' + columns + ')', '(lower(organization_id))') + ' WHERE ' + openStates,
    ],
    [
      'DESC key',
      prefix.replace('(' + columns + ')', '(' + columns + ' DESC)') + ' WHERE ' + openStates,
    ],
    ['no predicate', prefix],
    ['too narrow predicate', prefix + " WHERE state='pending'"],
    [
      'too broad predicate',
      prefix + " WHERE state IN ('creating','pending','uncertain','review','paid')",
    ],
    ['OR bypass predicate', prefix + ' WHERE ' + openStates + ' OR 1'],
    [
      'changed literal case',
      prefix + " WHERE state IN ('Creating','pending','uncertain','review')",
    ],
  ];
  for (const [description, ddl] of substitutions) {
    test('schema' + version + ' rejects ' + description + ' for payment open index', (t) => {
      const db = fixture(t, { version });
      replaceIndex(db, name, ddl);
      validateReadOnly(db, validatePaidSchema);
      if (version === 20) validateReadOnly(db, validateMultiServiceSchema);
    });
  }
}

for (const [name, ddl] of [
  [
    'billing_financial_open_order',
    'CREATE INDEX billing_financial_open_order ON billing_financial_actions(order_id) WHERE ' +
      openStates,
  ],
  [
    'billing_one_closing_receipt',
    "CREATE UNIQUE INDEX billing_one_closing_receipt ON billing_financial_actions(order_id) WHERE kind='receipt'",
  ],
  [
    'billing_one_closing_receipt',
    "CREATE UNIQUE INDEX billing_one_closing_receipt ON billing_financial_actions(order_id) WHERE kind='refund' AND state NOT IN ('rejected','canceled')",
  ],
  [
    'billing_grants_org_service',
    'CREATE INDEX billing_grants_org_service ON billing_package_grants(service_code,organization_id,ends_at DESC)',
  ],
]) {
  test('both public guards reject substituted multi-service index: ' + ddl, (t) => {
    const db = fixture(t, { version: 20 });
    replaceIndex(db, name, ddl);
    validateReadOnly(db, validatePaidSchema);
    validateReadOnly(db, validateMultiServiceSchema);
  });
}

test('index with correct name on wrong table is rejected', (t) => {
  const db = fixture(t);
  replaceIndex(
    db,
    'billing_payment_open_org',
    'CREATE UNIQUE INDEX billing_payment_open_org ON billing_reservations(organization_id) WHERE ' +
      openStates,
  );
  validateReadOnly(db, validatePaidSchema);
});

test('ordinary index loses ordering contract even when its name and columns remain', (t) => {
  const db = fixture(t);
  replaceIndex(
    db,
    'billing_entries_wallet',
    'CREATE INDEX billing_entries_wallet ON billing_entries(wallet_id,created_at ASC,id)',
  );
  validateReadOnly(db, validatePaidSchema);
});

test('ordinary index changes key order despite preserving the column set', (t) => {
  const db = fixture(t);
  replaceIndex(
    db,
    'billing_payment_revenue',
    'CREATE INDEX billing_payment_revenue ON billing_payment_orders(organization_id,test_mode,paid_confirmed_at,price_kopecks)',
  );
  validateReadOnly(db, validatePaidSchema);
});

test('quoted identifiers and whitespace do not invalidate the same unique predicate', (t) => {
  const db = fixture(t);
  replaceIndex(
    db,
    'billing_payment_open_org',
    `CREATE UNIQUE INDEX "billing_payment_open_org"
ON "billing_payment_orders" ( "organization_id" COLLATE BINARY ASC )
WHERE "state" IN ( 'creating', 'pending', 'uncertain', 'review' )`,
  );
  validateReadOnly(db, validatePaidSchema, { rejects: false });
});
