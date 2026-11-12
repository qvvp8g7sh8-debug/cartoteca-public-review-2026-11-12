const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const {
  lockPlan,
  KEYS,
  assertPlanIntent,
  assertMode,
} = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const { compoundScope } = require('../src/server/infrastructure/postgres/compound-intent133.cjs');
const {
  organizationQueueScope,
  entityQueueScope,
} = require('../src/server/infrastructure/postgres/scoped-queue134.cjs');
const {
  queueStatements,
} = require('../src/server/infrastructure/postgres/queue-org-statements134.cjs');
const { statements } = require('../src/server/infrastructure/postgres/max-inbox-sql134.cjs');
const platform = { kind: 'platform', storeId: randomUUID() },
  org = randomUUID(),
  other = randomUUID();
const bot = 'max-inbox-bot:' + 'a'.repeat(64),
  otherBot = 'max-inbox-bot:' + 'b'.repeat(64);
let catalog;
test.before(() => {
  catalog = canonicalSqliteSchema({ kind: 'platform', version: 19 });
});
const orgCap = (queueDomain = 'push', organizationId = org) =>
  organizationQueueScope({ queueDomain, organizationId }, platform);
const plan = (cap) =>
  lockPlan(
    platform,
    cap.type === 'organization' ? 'QUEUEORG' : 'QUEUEENTITY',
    true,
    null,
    null,
    null,
    cap,
  );
const verify = (sql, args, cap) => {
  const p = compile(sql, platform, args, 'run', catalog);
  assertPlanIntent(
    p.steps || [p],
    platform,
    cap.type === 'organization' ? 'QUEUEORG' : 'QUEUEENTITY',
    null,
    null,
    catalog,
    cap,
  );
  return p;
};
test('organization queues share domain gates and use the same exclusive organization key as compound operations', () => {
  const a = plan(orgCap()),
    b = plan(orgCap('push', other)),
    compound = lockPlan(
      platform,
      'COMPOUND',
      true,
      null,
      null,
      compoundScope({ operation: 'intent', organizationId: org, cabinetStoreId: null }, platform),
    );
  assert.deepEqual(a.slice(0, 3), [
    { key: KEYS.maintenance, shared: true },
    { key: KEYS.policy, shared: true },
    { key: KEYS.writer, shared: true },
  ]);
  assert.equal(a[3].shared, true);
  assert.equal(a.at(-1).shared, false);
  assert.notEqual(a.at(-1).key, b.at(-1).key);
  assert.equal(a.at(-1).key, plan(orgCap('staff-max')).at(-1).key);
  assert.equal(a.at(-1).key, compound.at(-1).key);
  assert.equal(plan(orgCap('schedule')).length, 7);
});
test('MAX event ownership shares its bot gate; admission is separate and global while markers remain exact-key scoped', () => {
  const event = entityQueueScope(
      { domain: 'max-inbox', kind: 'event', key: randomUUID(), botHash: bot },
      platform,
    ),
    otherEvent = { ...event, key: randomUUID() };
  const a = plan(event),
    b = plan(otherEvent),
    lease = plan(entityQueueScope({ domain: 'max-inbox', kind: 'bot', key: bot }, platform));
  assert.equal(a.at(-2).shared, true);
  assert.equal(a.at(-2).key, b.at(-2).key);
  assert.equal(a.at(-2).key, lease.at(-1).key);
  assert.equal(lease.at(-1).shared, false);
  assert.notEqual(a.at(-1).key, b.at(-1).key);
  const admission = (key) =>
    plan(entityQueueScope({ domain: 'max-inbox', kind: 'admission', key }, platform));
  assert.equal(admission(bot).at(-1).key, admission(otherBot).at(-1).key);
  assert.notEqual(admission(bot).at(-1).key, lease.at(-1).key);
  const marker = entityQueueScope(
    { domain: 'staff-max', kind: 'marker', key: 'staff-selftest-v1:max:' + randomUUID() },
    platform,
  );
  assert.equal(plan(marker).length, 5);
});
test('capabilities reject arbitrary gates, invalid organization or bot identity and nested upgrades', () => {
  for (const cap of [
    { queueDomain: 'max-inbox', organizationId: org },
    { queueDomain: 'push', organizationId: 'invalid' },
    { queueDomain: 'push', organizationId: org, domains: [] },
  ])
    assert.throws(() => organizationQueueScope(cap, platform));
  for (const cap of [
    { domain: 'max-inbox', kind: 'event', key: randomUUID() },
    { domain: 'max-inbox', kind: 'bot', key: 'raw-bot' },
    { domain: 'staff-max', kind: 'marker', key: 'staff-selftest-v1:telegram:job' },
  ])
    assert.throws(() => entityQueueScope(cap, platform));
  const frames = [{ scope: platform, mode: 'QUEUEORG', scopedQueue: orgCap() }];
  assert.throws(() => assertMode(platform, 'IMMEDIATE', frames));
  assert.throws(() =>
    assertMode(
      { kind: 'cabinet', storeId: randomUUID(), organizationId: org },
      'IMMEDIATE',
      frames,
    ),
  );
});
test('closed organization SQL binds every predicate organization and forbids wider native plans', () => {
  const cap = orgCap(),
    sql = queueStatements('push').finish.sql,
    args = ['sent', 0, org, 'job', 'lease', 100];
  verify(sql, args, cap);
  assert.throws(() => verify(sql, ['sent', 0, other, 'job', 'lease', 100], cap));
  assert.throws(() => verify(sql, args, orgCap('telegram')));
  assert.throws(() =>
    verify('UPDATE staff_push_jobs SET status=? WHERE organization_id=?', ['sent', org], cap),
  );
  const p = compile(sql, platform, args, 'run', catalog),
    forged = { ...p, text: p.text.replace(/\bWHERE\b/i, 'WHERE 1=1 OR ') };
  assert.throws(() => assertPlanIntent([forged], platform, 'QUEUEORG', null, null, catalog, cap));
  assert.throws(() =>
    assertPlanIntent(
      [{ text: 'SELECT pg_catalog.pg_sleep(1)', values: [], effect: 'read' }],
      platform,
      'QUEUEORG',
      null,
      null,
      catalog,
      cap,
    ),
  );
});
test('MAX SQL binds both event and bot identity and cannot use the admission cleanup capability', () => {
  const key = randomUUID(),
    cap = entityQueueScope({ domain: 'max-inbox', kind: 'event', key, botHash: bot }, platform);
  verify(statements.save.sql, [Buffer.from('synthetic'), key, bot, 'lease', 100, 1], cap);
  assert.throws(() =>
    verify(
      statements.save.sql,
      [Buffer.from('synthetic'), randomUUID(), bot, 'lease', 100, 1],
      cap,
    ),
  );
  assert.throws(() =>
    verify(statements.save.sql, [Buffer.from('synthetic'), key, otherBot, 'lease', 100, 1], cap),
  );
  assert.throws(() => verify(statements.release.sql, [bot, 'owner'], cap));
});
