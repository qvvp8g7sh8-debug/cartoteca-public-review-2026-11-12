const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const {
  compile,
  compileUncached,
  compileCacheStats,
} = require('../src/server/infrastructure/postgres/dialect.cjs');
const {
  lex,
  lexReadonly,
  lexCacheStats,
} = require('../src/server/infrastructure/postgres/dialect-lexer.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const catalog = freeze(canonicalSqliteSchema({ kind: 'cabinet', version: 2 }));
const scope = { kind: 'cabinet', storeId: 'synthetic-compile140', revisionProfile: 3 };

test('cached SQL tokens remain independent mutable values and have bounded retention', () => {
  const sql = "SELECT ?1 AS value, '?;--''?' AS literal /* compile140 */";
  const first = lex(sql),
    expected = structuredClone(first),
    before = lexCacheStats();
  first[0].raw = 'DELETE';
  first.splice(1);
  assert.deepEqual(lex(sql), expected);
  assert.equal(lexCacheStats().hits, before.hits + 1);
  for (let n = 0; n < 300; n++) lex(`SELECT ? AS compile140_${n}`);
  const after = lexCacheStats();
  assert.ok(after.entries <= after.maximumEntries);
  assert.ok(after.bytes <= after.maximumBytes);
  assert.throws(() => lex("SELECT 'unclosed"), { code: 'POSTGRES_SQL_UNSUPPORTED' });
  assert.throws(() => lex('SELECT 1\0'), { code: 'POSTGRES_SQL_UNSUPPORTED' });
});

test('one structural translation serves 1000 cold tenant scopes with fresh values', (t) => {
  const sql = 'SELECT id,value FROM patients WHERE id=? /* cold-compile140 */';
  const before = compileCacheStats();
  const start = performance.now();
  for (let n = 0; n < 1000; n++) {
    const current = { ...scope, storeId: 'cold-tenant-' + n };
    const plan = compile(sql, current, ['patient-' + n], 'get', catalog);
    assert.deepEqual(plan.values, ['patient-' + n]);
  }
  const cachedMs = performance.now() - start,
    after = compileCacheStats();
  assert.equal(after.misses - before.misses, 1);
  assert.equal(after.hits - before.hits, 999);
  const baseline = performance.now();
  for (let n = 0; n < 1000; n++)
    compileUncached(
      sql,
      { ...scope, storeId: 'cold-tenant-' + n },
      ['patient-' + n],
      'get',
      catalog,
    );
  t.diagnostic(
    JSON.stringify({
      coldTenantScopes: 1000,
      structuralCompilations: 1,
      templateHits: 999,
      cachedMs,
      uncachedMs: performance.now() - baseline,
      timingIsNotLoadCapacity: true,
    }),
  );
});

test('catalog scope parameters and numbered/repeated arguments are rebound without aliases', () => {
  for (const sql of [
    'SELECT name FROM sqlite_master WHERE type=? /* scoped-compile140 */',
    'SELECT ?2 AS second,?1 AS first,?2 AS repeated /* numbered-compile140 */',
  ]) {
    for (let n = 0; n < 5; n++) {
      const current = { ...scope, storeId: n === 3 ? 'cabinet' : 'tenant-' + n };
      const args = sql.includes('sqlite_master')
        ? [current.storeId]
        : [Buffer.from('blob-' + n), 'text-' + n];
      const expected = compileUncached(sql, current, args, 'all', catalog);
      const plan = compile(sql, current, args, 'all', catalog);
      assert.deepEqual(plan, expected);
      plan.values.fill('mutated');
      if (plan.columns) plan.columns.push('mutated');
      assert.deepEqual(compile(sql, current, args, 'all', catalog), expected);
    }
  }
});

test('type-sensitive scalar translations preserve null, integer, real, text and blob behavior', () => {
  const sql = 'SELECT MAX(?1,?2) AS value /* storage-classes140 */';
  const cases = [
    [1, 2],
    [10n, 20n],
    [1.25, 2],
    [null, 3],
    [undefined, null],
    ['one', 'two'],
    [Buffer.from('one'), Buffer.from('two')],
    [true, false],
  ];
  for (let round = 0; round < 3; round++)
    for (const args of cases)
      assert.deepEqual(
        compile(sql, scope, args, 'get', catalog),
        compileUncached(sql, scope, args, 'get', catalog),
      );
  for (const args of [
    [1, 'two'],
    [Buffer.from('one'), 'two'],
  ]) {
    assert.throws(() => compile(sql, scope, args, 'get', catalog), {
      code: 'POSTGRES_SQL_UNSUPPORTED',
    });
  }
  assert.throws(() => compile(sql, scope, [1], 'get', catalog), {
    code: 'POSTGRES_SQL_UNSUPPORTED',
  });
});

test('atomic REPLACE steps, catalog identity and mutable catalogs keep canonical semantics', () => {
  const sql = 'INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2) /* replace-compile140 */';
  for (let n = 0; n < 4; n++) {
    const args = ['key-' + n, Buffer.from('bytes-' + n)];
    const plan = compile(sql, scope, args, 'run', catalog);
    assert.deepEqual(plan, compileUncached(sql, scope, args, 'run', catalog));
    assert.equal(plan.atomic, true);
    plan.steps[0].values.fill('mutated');
  }
  const mutable = structuredClone(catalog);
  const cast = 'SELECT CAST(value AS BLOB) AS value FROM patients WHERE id=?';
  compile(cast, scope, ['first'], 'all', mutable);
  mutable.tables.patients.columns.find((column) => column.name === 'value').type = 'TEXT';
  assert.deepEqual(
    compile(cast, scope, ['second'], 'all', mutable),
    compileUncached(cast, scope, ['second'], 'all', mutable),
  );
  const altered = freeze(structuredClone(mutable));
  assert.deepEqual(
    compile(cast, scope, ['third'], 'all', altered),
    compileUncached(cast, scope, ['third'], 'all', altered),
  );
  const cyclic = structuredClone(catalog);
  cyclic.unused = cyclic;
  Object.freeze(cyclic);
  assert.deepEqual(
    compile('SELECT id FROM patients', scope, [], 'all', cyclic),
    compileUncached('SELECT id FROM patients', scope, [], 'all', cyclic),
  );
  for (let n = 0; n < 300; n++)
    compile(`SELECT id FROM patients /* eviction140-${n} */`, scope, [], 'all', catalog);
  const stats = compileCacheStats();
  assert.ok(stats.entries <= stats.maximumEntries);
  assert.ok(stats.bytes <= stats.maximumBytes);
});

test('cached plans never bypass current READONLY intent, query_only or a closed handle', () => {
  let calls = 0;
  const state = { ready: true, closed: false };
  const transport = {
    ready: async () => {},
    stats: () => state,
    close: async () => {},
    closeSync() {},
    request(command) {
      calls++;
      return command.op === 'execute' ? { rows: [], fields: [], rowCount: 1 } : null;
    },
  };
  const owner = createPostgresCoordinator({
    allowBlocking: true,
    transport,
    catalog,
    revisionProfile: 3,
  });
  const db = owner.open(scope),
    write = db.prepare('UPDATE patients SET value=? WHERE id=?');
  write.run(Buffer.from('warm'), 'synthetic');
  db.exec('BEGIN READONLY');
  const at = calls;
  assert.throws(() => write.run(Buffer.from('denied'), 'synthetic'), {
    code: 'POSTGRES_QUERY_ONLY',
  });
  assert.equal(calls, at);
  db.exec('ROLLBACK');
  db.exec('PRAGMA query_only=ON');
  assert.throws(() => write.run(Buffer.from('denied'), 'synthetic'), {
    code: 'POSTGRES_QUERY_ONLY',
  });
  db.close();
  assert.throws(() => write.run(Buffer.from('denied'), 'synthetic'), { code: 'POSTGRES_CLOSED' });
});

test('same cached write shape rechecks the new queue key rather than caching authorization', () => {
  const { assertPlanIntent } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
  const metadata = freeze(canonicalSqliteSchema({ kind: 'platform', version: 19 }));
  const current = { kind: 'platform', storeId: 'synthetic-platform140', revisionProfile: 3 };
  const sql = 'UPDATE telegram_runtime SET value=? WHERE key=? /* current-key140 */';
  const allowed = compile(
    sql,
    current,
    [Buffer.from('one'), 'application-process-roles'],
    'run',
    metadata,
  );
  assert.doesNotThrow(() => assertPlanIntent([allowed], current, 'QUEUE', null, null, metadata));
  const denied = compile(sql, current, [Buffer.from('two'), 'offset'], 'run', metadata);
  assert.deepEqual(denied.values, [Buffer.from('two'), 'offset']);
  assert.throws(() => assertPlanIntent([denied], current, 'QUEUE', null, null, metadata), {
    code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN',
  });
});

test('borrowed SQL tokens are deeply immutable and use the same bounded lexer retention', () => {
  const sql = "SELECT $1 AS value, 'structural142' AS literal";
  const borrowed = lexReadonly(sql);
  assert.equal(
    lexReadonly(sql),
    borrowed,
    'read-only guards reuse the frozen structure without copies',
  );
  assert.ok(Object.isFrozen(borrowed));
  assert.ok(borrowed.every(Object.isFrozen));
  assert.equal(Reflect.set(borrowed[0], 'raw', 'DELETE'), false);
  assert.throws(() => borrowed.push({ type: 'word', value: 'DROP' }), TypeError);
  const mutable = lex(sql);
  mutable[0].value = 'DELETE';
  mutable.splice(1);
  assert.equal(lexReadonly(sql), borrowed);
  assert.equal(borrowed[0].value, 'SELECT');
  const before = lexCacheStats();
  const oversized = "SELECT '" + 'large142'.repeat(20000) + "' AS value";
  const large = lexReadonly(oversized);
  assert.ok(Object.isFrozen(large) && large.every(Object.isFrozen));
  assert.notEqual(
    lexReadonly(oversized),
    large,
    'oversized structures have no strong cache retention',
  );
  assert.equal(lexCacheStats().bytes, before.bytes);
  assert.equal(lexCacheStats().entries, before.entries);
  for (let n = 0; n < 300; n++) lexReadonly(`SELECT $1 AS borrow142_${n}`);
  const after = lexCacheStats();
  assert.ok(after.bytes <= after.maximumBytes && after.entries <= after.maximumEntries);
  assert.notEqual(lexReadonly(sql), borrowed, 'LRU eviction retires the old shared identity');
});
