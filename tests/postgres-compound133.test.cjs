const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const {
  lockPlan,
  assertPlanIntent,
  KEYS,
} = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  compoundScope,
  operations,
} = require('../src/server/infrastructure/postgres/compound-intent133.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const platform = { kind: 'platform', storeId: randomUUID() };
const organizationId = randomUUID(),
  cabinetStoreId = randomUUID();
const cabinet = { kind: 'cabinet', storeId: cabinetStoreId, organizationId };
const input = { operation: 'cabinet', organizationId, cabinetStoreId };
let catalog;
test.before(() => {
  catalog = canonicalSqliteSchema({ kind: 'platform', version: 19 });
});
const check = (sql, args, compound = compoundScope(input, platform)) => {
  const plan = compile(sql, platform, args, 'run', catalog);
  assertPlanIntent(plan.steps || [plan], platform, 'COMPOUND', null, compound, catalog);
  return plan;
};

test('compound fixed guards share global policy/writer/domains and separate organization ownership', () => {
  const a = compoundScope(input, platform),
    b = compoundScope(
      { ...input, organizationId: randomUUID(), cabinetStoreId: randomUUID() },
      platform,
    );
  const first = lockPlan(platform, 'COMPOUND', true, null, null, a),
    second = lockPlan(platform, 'COMPOUND', true, null, null, b);
  assert.deepEqual(first.slice(0, 3), [
    { key: KEYS.maintenance, shared: true },
    { key: KEYS.policy, shared: true },
    { key: KEYS.writer, shared: true },
  ]);
  assert.equal(first.length, 7);
  assert.ok(first.slice(3, 5).every((lock) => lock.shared));
  assert.ok(first.slice(5).every((lock) => !lock.shared));
  assert.equal(
    first.filter((x) => !x.shared).some((x) => second.some((y) => y.key === x.key)),
    false,
  );
  for (const operation of Object.keys(operations)) {
    const value = compoundScope(
      { ...input, operation, cabinetStoreId: operation === 'intent' ? null : cabinetStoreId },
      platform,
    );
    assert.ok(lockPlan(platform, 'COMPOUND', true, null, null, value).length <= 16);
  }
});

test('compound capability rejects arbitrary domains, missing tenant and unknown operations', () => {
  for (const value of [
    { ...input, domains: [] },
    { ...input, operation: '__proto__' },
    { ...input, organizationId: '' },
    { ...input, cabinetStoreId: null },
    { ...input, operation: 'intent' },
  ])
    assert.throws(() => compoundScope(value, platform), {
      code: 'POSTGRES_COMPOUND_SCOPE_INVALID',
    });
});

test('closed native write templates bind organization and reject wider SQL', () => {
  check(
    'DELETE FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
    [organizationId, 'patient', 'appointment'],
  );
  check(
    "INSERT INTO notification_schedule_dirty(kind,organization_id,subject) VALUES(?,?,?) ON CONFLICT(kind,organization_id,subject) DO UPDATE SET version=version+1,cursor=''",
    ['client', organizationId, 'patient'],
  );
  check(
    "UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=? AND patient_id=? AND fingerprint=? AND status IN ('pending','sending')",
    [organizationId, 'patient', 'stamp'],
  );
  for (const [sql, args] of [
    [
      'DELETE FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
      [randomUUID(), 'patient', 'appointment'],
    ],
    [
      'DELETE FROM appointment_manual_confirmations WHERE organization_id=? OR 1=1',
      [organizationId],
    ],
    ["UPDATE telegram_jobs SET status='cancelled' WHERE organization_id=?", [organizationId]],
    ['UPDATE accounts SET value=? WHERE id=?', [Buffer.from('synthetic'), 'account']],
  ])
    assert.throws(() => check(sql, args));
  const plan = compile(
    'DELETE FROM appointment_manual_confirmations WHERE organization_id=? AND patient_id=? AND appointment_id=?',
    platform,
    [organizationId, 'patient', 'appointment'],
    'run',
    catalog,
  );
  const forged = {
    ...plan,
    text: plan.text.replace(
      /\bWHERE\b/i,
      'WHERE "_store_id"=$' + (plan.values.length + 1) + ' OR ',
    ),
    values: [...plan.values, randomUUID()],
  };
  assert.notEqual(
    forged.text,
    plan.text,
    'the native plan actually contains a wider forged store predicate',
  );
  assert.throws(() =>
    assertPlanIntent([forged], platform, 'COMPOUND', null, compoundScope(input, platform), catalog),
  );
});

test('compound scopes and unsupported functions remain denied through read-only nesting', () => {
  const compound = compoundScope(input, platform);
  const foreign = { ...cabinet, storeId: randomUUID(), organizationId: randomUUID() };
  assert.throws(
    () =>
      assertPlanIntent(
        [{ text: 'SELECT 1', values: [], effect: 'read' }],
        foreign,
        'READONLY',
        null,
        compound,
        catalog,
      ),
    { code: 'POSTGRES_COMPOUND_SCOPE_INVALID' },
  );
  assert.throws(() =>
    assertPlanIntent(
      [{ text: 'SELECT pg_catalog.pg_sleep(1)', values: [], effect: 'read' }],
      platform,
      'COMPOUND',
      null,
      compound,
      catalog,
    ),
  );
  assert.throws(() =>
    assertPlanIntent(
      [{ text: 'SELECT 1', values: [], effect: 'read' }],
      cabinet,
      'COMPOUND',
      null,
      compoundScope({ operation: 'intent', organizationId, cabinetStoreId: null }, platform),
      catalog,
    ),
  );
});

function fixture(profile = 3) {
  const calls = [];
  const transport = {
    request(command) {
      calls.push(command);
      if (command.op === 'inspect') return { metadata: catalog, revisionProfile: profile };
      if (command.op === 'verifyProfile') return true;
      if (command.op === 'snapshotVersion') return '10:12:11';
      if (command.op === 'execute') return { rows: [], fields: [], rowCount: 1 };
      return null;
    },
    stats: () => ({ poisoned: false }),
    ready: async () => {},
    close: async () => {},
    closeSync() {},
  };
  const owner = createPostgresCoordinator({ allowBlocking: true, transport });
  const lineage = {
    version: 1,
    backend: 'postgres',
    migrationId: randomUUID(),
    platformStoreId: platform.storeId,
    rootCabinetStoreId: cabinetStoreId,
    budgetStoreId: null,
    notificationSchema: 19,
    cabinetSchema: 2,
    cabinetTemplates: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
    stores: [
      {
        kind: 'platform',
        storeId: platform.storeId,
        organizationId: null,
        relativeDirectory: 'platform',
        schemaVersion: 19,
      },
      {
        kind: 'cabinet',
        storeId: cabinetStoreId,
        organizationId,
        relativeDirectory: '.',
        schemaVersion: 2,
      },
    ],
  };
  owner.verifyProfile({
    platformStoreId: platform.storeId,
    migrationId: lineage.migrationId,
    markerHash: digest(lineage),
    lineage,
  });
  return { owner, calls };
}

test('coordinator admits only attested profile3 and preserves a single outer compound transaction', () => {
  for (const profile of [1, 2]) {
    const f = fixture(profile),
      db = f.owner.open(platform);
    assert.throws(() => db.beginCompound(input), { code: 'POSTGRES_COMPOUND_UNAVAILABLE' });
    assert.throws(() => db.snapshotVersion(), { code: 'POSTGRES_SNAPSHOT_PROFILE_REQUIRED' });
  }
  const f = fixture(),
    db = f.owner.open(platform),
    tenant = f.owner.open(cabinet);
  db.beginCompound(input);
  assert.equal(db.transactionIntent, 'COMPOUND');
  assert.deepEqual(f.calls.at(-1).compound, input);
  tenant.exec('BEGIN IMMEDIATE');
  assert.equal(tenant.transactionIntent, 'COMPOUND');
  assert.equal(db.snapshotVersion(), '10:12:11');
  assert.throws(() => tenant.beginQueue('push'));
  tenant.exec('COMMIT');
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
  assert.equal(db.transactionIntent, null);
});
