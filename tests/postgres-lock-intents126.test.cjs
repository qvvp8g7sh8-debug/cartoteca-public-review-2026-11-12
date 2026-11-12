const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const {
  KEYS,
  advisoryKey,
  lockPlan,
  assertMode,
  assertPlanIntent,
  runtimeKeyAllowed,
} = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const platform = { kind: 'platform', storeId: 'synthetic-platform' };
const cabinet = { kind: 'cabinet', storeId: 'synthetic-cabinet' };
const definition = (names, primary = ['id']) => ({
  name: 'synthetic',
  columns: names.map((name) => ({ name, type: name === 'value' ? 'BLOB' : 'TEXT' })),
  primary,
  unique: [],
  rowid: true,
});
const catalog = {
  tables: {
    telegram_runtime: definition(['key', 'value'], ['key']),
    telegram_jobs: definition([
      'id',
      'status',
      'expires_at',
      'lease_until',
      'lease_id',
      'attempts',
    ]),
    accounts: definition(['id', 'value']),
    patients: definition(['id', 'value']),
  },
};
const check = (sql, args = [], intent = 'QUEUE', scope = platform) => {
  const plan = compile(sql, scope, args, 'run', catalog);
  assertPlanIntent(plan.steps || [plan], scope, intent);
  return plan;
};

test('lock ordering separates maintenance, policy, platform RMW and tenant ownership', () => {
  assert.equal(KEYS.maintenance, advisoryKey('cartoteca:platform-write-fence:v1'));
  assert.equal(new Set(Object.values(KEYS)).size, 3);
  assert.deepEqual(
    lockPlan(platform, 'IMMEDIATE').map((x) => [x.key, x.shared]),
    [
      [KEYS.maintenance, true],
      [KEYS.policy, false],
      [KEYS.writer, false],
    ],
  );
  assert.deepEqual(
    lockPlan(platform, 'QUEUE', true).map((x) => [x.key, x.shared]),
    [
      [KEYS.maintenance, true],
      [KEYS.policy, true],
      [KEYS.writer, false],
    ],
  );
  assert.deepEqual(lockPlan(cabinet, 'READONLY'), [{ key: KEYS.maintenance, shared: true }]);
  assert.deepEqual(lockPlan(cabinet, 'IMMEDIATE').slice(0, 2), [
    { key: KEYS.maintenance, shared: true },
    { key: KEYS.policy, shared: true },
  ]);
  assert.equal(
    lockPlan({ kind: 'budget', storeId: 'budget' }, 'IMMEDIATE')[0].key,
    KEYS.maintenance,
  );
});

test('restricted outer intents cannot be upgraded by a nested mode', () => {
  for (const mode of ['IMMEDIATE', 'QUEUE', 'SHARED'])
    assert.throws(() => assertMode(cabinet, mode, [{ mode: 'READONLY' }]));
  assert.doesNotThrow(() => assertMode(cabinet, 'DEFERRED', [{ mode: 'READONLY' }]));
  assert.doesNotThrow(() => assertMode(cabinet, 'READONLY', [{ mode: 'QUEUE' }]));
  assert.throws(() => assertMode(cabinet, 'IMMEDIATE', [{ mode: 'QUEUE' }]));
  assert.throws(() => assertMode(cabinet, 'QUEUE'));
});

test('actual compiled queue bulk CAS and insert conflict plans pass the closed target check', () => {
  check(
    'UPDATE telegram_jobs SET status=CASE id WHEN ? THEN ? ELSE status END,lease_until=0 WHERE (id=? AND status=? AND expires_at=? AND lease_until=? AND lease_id IS ?)',
    ['one', 'cancelled', 'one', 'pending', 100, 0, null],
  );
  check('DELETE FROM telegram_jobs WHERE id IN (?,?) AND expires_at<=?', ['one', 'two', 100]);
  check('INSERT OR IGNORE INTO telegram_jobs(id,status) VALUES(?,?)', ['one', 'pending']);
  check(
    'INSERT INTO telegram_jobs(id,status) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status',
    ['one', 'pending'],
  );
});

test('QUEUE permits only exact role/selftest runtime keys, including both REPLACE steps', () => {
  for (const key of [
    'application-process-roles',
    'staff-selftest-v1:telegram:job_1',
    'staff-selftest-v1:max:job-2',
  ]) {
    assert.equal(runtimeKeyAllowed(key), true);
    const plan = check('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)', [
      key,
      Buffer.from('synthetic'),
    ]);
    assert.equal(plan.steps.length, 2);
    check('UPDATE telegram_runtime SET value=? WHERE key=?', [Buffer.from('synthetic'), key]);
    check('DELETE FROM telegram_runtime WHERE key=?', [key]);
  }
  for (const key of [
    'offset',
    'application-process-roles-other',
    'notification-channel-state-v1',
    'staff-selftest-v1:push:x',
    'staff-selftest-v1:max:',
    'staff-selftest-v1:max:x:extra',
  ]) {
    assert.equal(runtimeKeyAllowed(key), false);
    assert.throws(() =>
      check('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)', [
        key,
        Buffer.from('synthetic'),
      ]),
    );
  }
  assert.throws(() =>
    check('DELETE FROM telegram_runtime WHERE key=? OR key=?', [
      'application-process-roles',
      'offset',
    ]),
  );
  assert.throws(() =>
    check('DELETE FROM telegram_runtime WHERE key>=?', ['staff-selftest-v1:max:']),
  );
  assert.throws(() =>
    check('UPDATE telegram_runtime SET key=? WHERE key=?', ['offset', 'application-process-roles']),
  );
  assert.throws(() =>
    check('INSERT INTO telegram_runtime(key,value) SELECT key,value FROM telegram_runtime'),
  );
});

test('intent validation checks native effects, every step and functions instead of trusting a caller label', () => {
  assert.throws(() =>
    check('UPDATE accounts SET value=? WHERE id=?', [Buffer.from('synthetic'), 'one']),
  );
  assert.throws(() =>
    check(
      'UPDATE patients SET value=? WHERE id=?',
      [Buffer.from('synthetic'), 'one'],
      'QUEUE',
      cabinet,
    ),
  );
  assert.throws(
    () => check('UPDATE telegram_jobs SET status=? WHERE id=?', ['sent', 'one'], 'READONLY'),
    { code: 'POSTGRES_QUERY_ONLY' },
  );
  for (const text of [
    'SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5)',
    'SELECT set_config($1,$2,false)',
    'WITH x AS (DELETE FROM cartoteca_platform.accounts RETURNING *) SELECT * FROM x',
    'SELECT 1; DELETE FROM cartoteca_platform.accounts',
  ]) {
    for (const intent of ['QUEUE', 'READONLY'])
      assert.throws(() =>
        assertPlanIntent([{ text, values: [], effect: 'read' }], platform, intent),
      );
  }
  assert.throws(() =>
    assertPlanIntent(
      [{ text: 'UPDATE cartoteca_platform.accounts SET value=$1', values: [], effect: 'read' }],
      platform,
      'QUEUE',
    ),
  );
  assert.doesNotThrow(() => check('SELECT id FROM accounts WHERE id=?', ['one'], 'READONLY'));
  for (const intent of ['READONLY', 'QUEUE']) {
    assert.doesNotThrow(() =>
      check(
        'WITH request_scope(org,entries) AS (VALUES(?,?)) SELECT org FROM request_scope',
        ['org', '[]'],
        intent,
      ),
    );
    assert.throws(() =>
      assertPlanIntent(
        [
          {
            text: 'WITH unsafe(x) AS (SELECT 1) SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5)',
            values: [],
            effect: 'read',
          },
        ],
        platform,
        intent,
      ),
    );
  }
});

function facade() {
  const calls = [];
  const transport = {
    request(command) {
      calls.push(command);
      return { rows: [], fields: [], rowCount: 1 };
    },
    stats: () => ({}),
    close: async () => {},
    ready: async () => {},
  };
  const owner = createPostgresCoordinator({ allowBlocking: true, transport, catalog, compile });
  return { owner, calls, p: owner.open(platform), c: owner.open(cabinet) };
}
test('coordinator exposes explicit modes, keeps nested read-only restriction and restores intent after release', () => {
  const f = facade();
  f.p.transaction(() => {
    f.c.transaction(() => {
      assert.throws(() => f.p.prepare('UPDATE telegram_jobs SET status=?').run('sent'), {
        code: 'POSTGRES_QUERY_ONLY',
      });
      assert.throws(() => f.c.exec('BEGIN IMMEDIATE'));
    }, 'READONLY');
    assert.equal(f.p.prepare('UPDATE telegram_jobs SET status=?').run('sent').changes, 1);
  }, 'QUEUE');
  assert.equal(f.calls[0].mode, 'QUEUE');
  assert.equal(f.calls[1].mode, 'READONLY');
  assert.equal(f.calls.filter((x) => x.op === 'execute').length, 1);
  f.p.exec('BEGIN READONLY');
  assert.throws(() => f.c.exec('BEGIN IMMEDIATE'), { code: 'POSTGRES_QUERY_ONLY' });
  assert.throws(() => f.p.prepare('UPDATE telegram_jobs SET status=?').run('sent'), {
    code: 'POSTGRES_QUERY_ONLY',
  });
  f.p.exec('ROLLBACK');
});

test('cached read grammar never trusts a mutated effect, SQL text or outer capability', () => {
  const plan = {
    text: 'SELECT $1 AS value /* structural142 */',
    values: ['first'],
    effect: 'read',
  };
  for (const intent of ['READONLY', 'QUEUE', 'COMPOUND', 'QUEUEORG'])
    assert.doesNotThrow(() => assertPlanIntent([plan], platform, intent));
  plan.effect = 'write';
  assert.throws(() => assertPlanIntent([plan], platform, 'READONLY'), {
    code: 'POSTGRES_QUERY_ONLY',
  });
  assert.throws(() => assertPlanIntent([plan], platform, 'QUEUE'));
  plan.effect = 'read';
  for (const text of [
    'UPDATE cartoteca_platform.accounts SET value=$1',
    'WITH changed AS (DELETE FROM cartoteca_platform.accounts RETURNING *) SELECT * FROM changed',
    'SELECT set_config($1,$2,false)',
    'SELECT pg_catalog.pg_sleep(1)',
    'SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5)',
    'SELECT 1; DELETE FROM cartoteca_platform.accounts',
    'SELECT (1',
  ]) {
    const altered = { ...plan, text };
    for (let repeat = 0; repeat < 2; repeat++)
      assert.throws(() => assertPlanIntent([altered], platform, 'READONLY'));
  }
  const wrong = {
    platformStoreId: 'another-platform',
    organizationId: 'another-org',
    cabinetStoreId: 'another-cabinet',
  };
  assert.throws(() => assertPlanIntent([plan], platform, 'READONLY', null, wrong), {
    code: 'POSTGRES_COMPOUND_SCOPE_INVALID',
  });
  assert.throws(() => assertPlanIntent([plan], platform, 'READONLY', null, null, null, wrong), {
    code: 'POSTGRES_SCOPED_QUEUE_SCOPE_INVALID',
  });
  assert.throws(
    () => assertPlanIntent([plan], platform, 'READONLY', null, null, null, null, wrong),
    { code: 'POSTGRES_AUTH_SCOPE_INVALID' },
  );
  assert.throws(() => assertPlanIntent([plan], platform, 'READONLY', 'unknown-domain'), {
    code: 'POSTGRES_QUEUE_DOMAIN_INVALID',
  });
  assert.throws(
    () =>
      assertPlanIntent([plan], platform, 'AUTH', null, null, catalog, null, {
        platformStoreId: platform.storeId,
      }),
    'AUTH must execute its exact value/catalog rules, never the read-grammar shortcut',
  );
  const write = () =>
    check('UPDATE telegram_runtime SET value=? WHERE key=?', [
      Buffer.from('synthetic'),
      'application-process-roles',
    ]);
  assert.doesNotThrow(write);
  assert.throws(
    () =>
      check('UPDATE telegram_runtime SET value=? WHERE key=?', [
        Buffer.from('synthetic'),
        'offset',
      ]),
    'value-dependent write keys are never grammar-cached',
  );
  plan.values = ['second'];
  assert.doesNotThrow(() => assertPlanIntent([plan], cabinet, 'READONLY'));
});
