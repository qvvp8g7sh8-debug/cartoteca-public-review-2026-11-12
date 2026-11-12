const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const {
  lockPlan,
  KEYS,
  advisoryKey,
  assertPlanIntent,
} = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  queueDomainNames,
  queueDomainForTable,
  assertQueueDomain,
} = require('../src/server/infrastructure/postgres/queue-domains.cjs');
const platform = { kind: 'platform', storeId: 'synthetic-platform' };
const cabinet = { kind: 'cabinet', storeId: 'synthetic-cabinet' };
const table = (columns, primary = ['id']) => ({
  name: 'synthetic',
  columns: columns.map((name) => ({ name, type: name === 'value' ? 'BLOB' : 'TEXT' })),
  primary,
  unique: [],
  rowid: true,
});
const catalog = {
  tables: {
    telegram_jobs: table(['id', 'status', 'attempts', 'lease_until']),
    staff_max_jobs: table(['id', 'status']),
    accounts: table(['id', 'value']),
    patients: table(['id', 'value']),
    telegram_runtime: table(['key', 'value'], ['key']),
  },
};
function check(sql, args, domain) {
  const plan = compile(sql, platform, args, 'run', catalog);
  assertPlanIntent(plan.steps || [plan], platform, 'QUEUE', domain);
}
function fixture({ profile = 2, expected, execute } = {}) {
  const calls = [],
    compiledScopes = [];
  const transport = {
    request(command) {
      calls.push(command);
      if (command.op === 'inspect')
        return { metadata: catalog, ...(profile === 2 ? { revisionProfile: 2 } : {}) };
      if (command.op === 'execute')
        return execute?.(command) || { rows: [], fields: [], rowCount: 1 };
      return null;
    },
    stats: () => ({ poisoned: false }),
    ready: async () => {},
    close: async () => {},
    closeSync() {},
  };
  const owner = createPostgresCoordinator({
    allowBlocking: true,
    transport,
    ...(expected ? { revisionProfile: expected } : {}),
    compile(sql, scope, args, method, metadata) {
      compiledScopes.push(scope);
      return compile(sql, scope, args, method, metadata);
    },
  });
  return { owner, calls, compiledScopes };
}

test('queue domains are a fixed whole-queue partition with exact selftest keys', () => {
  assert.deepEqual(queueDomainNames, [
    'telegram',
    'staff-telegram',
    'staff-max',
    'push',
    'client',
    'max-inbox',
  ]);
  assert.equal(queueDomainForTable('telegram_jobs'), 'telegram');
  assert.equal(queueDomainForTable('max_runtime_leases'), 'max-inbox');
  assert.equal(queueDomainForTable('telegram_runtime', 'staff-selftest-v1:max:job-1'), 'staff-max');
  for (const key of [
    'application-process-roles',
    'staff-selftest-v1:max:',
    'staff-selftest-v1:max:job:other',
  ])
    assert.equal(queueDomainForTable('telegram_runtime', key), null);
  for (const name of ['accounts', 'notification_schedule', 'notification_schedule_intents'])
    assert.equal(queueDomainForTable(name), null);
  for (const name of ['__proto__', '', 'push:organization', null])
    assert.throws(() => assertQueueDomain(name), { code: 'POSTGRES_QUEUE_DOMAIN_INVALID' });
});

test('scoped ownership retains global fences and legacy exclusion while allowing separate domains', () => {
  const domain = lockPlan(platform, 'QUEUE', true, null, 'push');
  assert.deepEqual(domain, [
    { key: KEYS.maintenance, shared: true },
    { key: KEYS.policy, shared: true },
    { key: KEYS.writer, shared: true },
    { key: advisoryKey('cartoteca:platform-queue:v1:synthetic-platform:push'), shared: false },
  ]);
  assert.equal(lockPlan(platform, 'QUEUE', true).at(-1).shared, false);
  assert.notEqual(
    domain.at(-1).key,
    lockPlan(platform, 'QUEUE', true, null, 'telegram').at(-1).key,
  );
  assert.notEqual(
    domain.at(-1).key,
    lockPlan({ ...platform, storeId: 'another' }, 'QUEUE', true, null, 'push').at(-1).key,
  );
  assert.throws(() => lockPlan(cabinet, 'QUEUE', true, 'QUEUE', 'push'));
});

test('domain plan validation denies foreign queue, business and mismatched runtime mutations', () => {
  check('UPDATE telegram_jobs SET status=? WHERE id=?', ['sent', 'job'], 'telegram');
  check('DELETE FROM telegram_jobs WHERE id=?', ['job'], 'telegram');
  check(
    'INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)',
    ['staff-selftest-v1:max:job', Buffer.from('synthetic')],
    'staff-max',
  );
  for (const [sql, args, domain] of [
    ['UPDATE telegram_jobs SET status=? WHERE id=?', ['sent', 'job'], 'push'],
    ['UPDATE accounts SET value=? WHERE id=?', [Buffer.from('synthetic'), 'account'], 'telegram'],
    ['DELETE FROM telegram_runtime WHERE key=?', ['staff-selftest-v1:telegram:job'], 'staff-max'],
    ['DELETE FROM telegram_runtime WHERE key=?', ['application-process-roles'], 'staff-max'],
    [
      'DELETE FROM telegram_runtime WHERE key>=? AND key<?',
      ['staff-selftest-v1:max:', 'staff-selftest-v1:max:\uffff'],
      'staff-max',
    ],
  ])
    assert.throws(() => check(sql, args, domain), { code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN' });
});

test('only native attested v2 enables a domain; caller scope cannot forge the compiler profile', () => {
  const legacy = fixture({ profile: 1 }),
    p1 = legacy.owner.open({ ...platform, revisionProfile: 2 });
  assert.equal(p1.revisionProfile, 1);
  assert.throws(() => p1.beginQueue('push'), { code: 'POSTGRES_QUEUE_DOMAIN_UNAVAILABLE' });
  p1.prepare('SELECT id FROM accounts').all();
  assert.equal(legacy.compiledScopes.at(-1).revisionProfile, undefined);
  const mismatch = fixture({ profile: 1, expected: 2 });
  assert.throws(() => mismatch.owner.open(platform), { code: 'POSTGRES_REVISION_PROFILE_INVALID' });
  const modern = fixture(),
    p2 = modern.owner.open(platform);
  p2.beginQueue('telegram');
  assert.equal(modern.calls.at(-1).queueDomain, 'telegram');
  p2.prepare('UPDATE telegram_jobs SET status=? WHERE id=?').run('sent', 'job');
  assert.equal(modern.compiledScopes.at(-1).revisionProfile, 2);
  assert.throws(
    () => p2.prepare('UPDATE staff_max_jobs SET status=? WHERE id=?').run('sent', 'job'),
    { code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN' },
  );
  const c = modern.owner.open(cabinet);
  assert.throws(() => c.exec('BEGIN IMMEDIATE'), { code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN' });
  c.exec('BEGIN DEFERRED');
  c.exec('COMMIT');
  assert.throws(() => c.beginQueue('push'));
  p2.exec('ROLLBACK');
});

test('mutation clock is shared by scope and never returns to a cached value after rollback', () => {
  let failWrite = false;
  const f = fixture({
    execute(command) {
      if (failWrite && command.plan.effect === 'write') throw Error('Synthetic SQL failure');
    },
  });
  const p = f.owner.open(platform),
    c = f.owner.open(cabinet),
    second = f.owner.open(cabinet);
  assert.equal(c.localMutationClock, 0);
  p.exec('BEGIN IMMEDIATE');
  c.exec('BEGIN IMMEDIATE');
  c.prepare('UPDATE patients SET value=? WHERE id=?').run(Buffer.from('synthetic'), 'patient');
  const afterWrite = c.localMutationClock;
  assert.ok(afterWrite > 0);
  assert.equal(second.localMutationClock, afterWrite);
  c.exec('COMMIT');
  p.exec('ROLLBACK');
  assert.ok(
    c.localMutationClock > afterWrite,
    'outer rollback invalidates even a released cabinet savepoint',
  );
  const prior = second.localMutationClock;
  failWrite = true;
  assert.throws(
    () =>
      second
        .prepare('UPDATE patients SET value=? WHERE id=?')
        .run(Buffer.from('synthetic'), 'patient'),
    /Synthetic SQL failure/,
  );
  assert.ok(
    second.localMutationClock > prior,
    'failed and unknown write attempts invalidate conservatively',
  );
  const current = second.localMutationClock;
  second.prepare('SELECT id FROM patients').all();
  assert.equal(second.localMutationClock, current);
  failWrite = false;
  p.exec('BEGIN IMMEDIATE');
  c.exec('BEGIN IMMEDIATE');
  c.exec('ROLLBACK');
  assert.ok(
    second.localMutationClock > current,
    'savepoint rollback also advances the local clock',
  );
  p.exec('ROLLBACK');
});
