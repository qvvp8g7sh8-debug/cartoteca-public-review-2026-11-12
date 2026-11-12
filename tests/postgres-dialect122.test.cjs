const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { compile, splitStatements } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { lex } = require('../src/server/infrastructure/postgres/dialect-lexer.cjs');
const scope = { kind: 'cabinet', storeId: 'synthetic-store-one' };
function catalogFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE patients(id TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE meta(key TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE counters(id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,value BLOB,UNIQUE(value));
    CREATE TABLE audit(id INTEGER PRIMARY KEY,event TEXT NOT NULL);
    CREATE INDEX patients_value ON patients(value);`);
  const objects = db
    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all();
  const tables = {};
  for (const object of objects.filter((o) => o.type === 'table')) {
    const columns = db.prepare('PRAGMA table_info(' + object.name + ')').all();
    const primary = columns
      .filter((c) => c.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const indexes = db
      .prepare('PRAGMA index_list(' + object.name + ')')
      .all()
      .map((index) => ({
        ...index,
        columns: db.prepare('PRAGMA index_xinfo(' + index.name + ')').all(),
      }));
    tables[object.name] = {
      name: object.name,
      sql: object.sql,
      columns,
      primary,
      unique: indexes
        .filter((i) => i.unique && i.origin !== 'pk')
        .map((i) => i.columns.filter((c) => c.key).map((c) => c.name)),
      indexes,
      rowid: true,
      integerPrimaryKey: columns.find((c) => c.pk === 1 && c.type === 'INTEGER')?.name || null,
    };
  }
  return { db, catalog: { version: 1, objects, tables } };
}
test('SQL lexer binds parameters without interpreting question marks or semicolons in literals/comments', (t) => {
  const { catalog } = catalogFixture(t);
  const sql = "SELECT id FROM patients WHERE id=? AND '?;--''?'='?;--''?' /* ?; */";
  const plan = compile(sql, scope, ['synthetic-id'], 'all', catalog);
  assert.deepEqual(plan.values, ['synthetic-id']);
  assert.match(plan.text, /"cartoteca_cabinet"\s*\.\s*"patients"/);
  assert.match(plan.text, /\$1/);
  assert.match(plan.text, /'\?;--''\?'/);
  assert.equal(splitStatements("BEGIN IMMEDIATE;SELECT ';' AS value;COMMIT;").length, 3);
  const punctuation = compile(
    "SELECT '(' AS opening,')' AS closing,',' AS comma,';' AS separator FROM patients WHERE id=?",
    scope,
    ['id'],
    'all',
    catalog,
  );
  assert.deepEqual(punctuation.values, ['id']);
  assert.match(punctuation.text, /'\('\s+AS\s+"opening"/);
  assert.throws(() => lex("SELECT 'unclosed"), { code: 'POSTGRES_SQL_UNSUPPORTED' });
});
test('registered tables map to constant kind schemas and cannot override the trusted store scope', (t) => {
  const { catalog } = catalogFixture(t);
  for (const kind of ['platform', 'cabinet', 'budget']) {
    const plan = compile(
      'SELECT * FROM patients WHERE id=?',
      { ...scope, kind },
      ['id'],
      'all',
      catalog,
    );
    assert.match(plan.text, new RegExp('"cartoteca_' + kind + '"'));
    assert.deepEqual(plan.values, ['id']);
    assert.doesNotMatch(plan.text, /synthetic-store-one/);
  }
  for (const sql of [
    'SELECT * FROM unregistered',
    'SELECT * FROM public.patients',
    'SELECT _store_id FROM patients',
    'SELECT _rowid FROM patients',
    'SELECT pg_sleep(1)',
    'SELECT public.count(*) FROM patients',
    'SELECT pg_catalog.lower(id) FROM patients',
    'SELECT "public"."count"(*) FROM patients',
    "ATTACH DATABASE 'another' AS external",
  ])
    assert.throws(
      () => compile(sql, scope, [], 'all', catalog),
      { code: 'POSTGRES_SQL_UNSUPPORTED' },
      sql,
    );
  assert.throws(() => compile('SELECT * FROM patients', { kind: 'cabinet' }, [], 'all', catalog), {
    code: 'POSTGRES_SQL_UNSUPPORTED',
  });
});
test('implicit INSERT columns preserve opaque BYTEA values and original identity results', (t) => {
  const { catalog } = catalogFixture(t),
    bytes = Buffer.from([0, 255, 13, 10]);
  const insert = compile('INSERT INTO meta VALUES(?,?)', scope, ['key', bytes], 'run', catalog);
  assert.deepEqual(insert.values, ['key', bytes]);
  assert.equal(insert.values[1], bytes);
  assert.match(insert.text, /\(\s*"key"\s*,\s*"value"\s*\)\s*VALUES/);
  assert.equal(insert.returningId, '_rowid');
  const audit = compile('INSERT INTO audit(event) VALUES(?)', scope, ['event'], 'run', catalog);
  assert.equal(audit.returningId, 'id');
  assert.match(audit.text, /RETURNING\s*"id"/);
});
test('REPLACE is atomic DELETE plus INSERT with exact per-step bind counts and fresh ordinal', (t) => {
  const { catalog } = catalogFixture(t),
    bytes = Buffer.from('opaque');
  const replace = compile(
    'INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',
    scope,
    ['key', bytes],
    'run',
    catalog,
  );
  assert.equal(replace.atomic, true);
  assert.equal(replace.steps.length, 2);
  assert.match(replace.steps[0].text, /^DELETE FROM/);
  assert.deepEqual(replace.steps[0].values, ['key']);
  assert.match(replace.steps[1].text, /^INSERT INTO/);
  assert.deepEqual(replace.steps[1].values, ['key', bytes]);
  assert.doesNotMatch(replace.steps[1].text, /DO UPDATE/);
  assert.throws(
    () =>
      compile('INSERT OR REPLACE INTO meta SELECT key,value FROM meta', scope, [], 'run', catalog),
    { code: 'POSTGRES_SQL_UNSUPPORTED' },
  );
});
test('native upserts include store identity and qualify ambiguous target revision references', (t) => {
  const { catalog } = catalogFixture(t);
  const plan = compile(
    `INSERT INTO counters(id,revision) VALUES(?,1)
    ON CONFLICT(id) DO UPDATE SET revision=revision+1`,
    scope,
    ['id'],
    'run',
    catalog,
  );
  assert.match(plan.text, /ON CONFLICT\s*\(\s*"_store_id"\s*,\s*id\s*\)/);
  assert.match(plan.text, /revision\s*=\s*"counters"\s*\.\s*"revision"\s*\+\s*1/);
  assert.throws(
    () =>
      compile(
        'INSERT INTO counters(id) VALUES(?) ON CONFLICT(revision) DO NOTHING',
        scope,
        ['id'],
        'run',
        catalog,
      ),
    { code: 'POSTGRES_SQL_UNSUPPORTED' },
  );
  const ignore = compile(
    'INSERT OR IGNORE INTO meta VALUES(?,?)',
    scope,
    ['k', Buffer.alloc(0)],
    'run',
    catalog,
  );
  assert.match(ignore.text, /ON CONFLICT DO NOTHING/);
});
test('rowid ordering is explicit and its projected field label remains compatible', (t) => {
  const { catalog } = catalogFixture(t);
  const plan = compile('SELECT rowid,id FROM patients ORDER BY rowid', scope, [], 'all', catalog);
  assert.match(plan.text, /SELECT\s*"_rowid"\s+AS\s+rowid/);
  assert.match(plan.text, /ORDER BY\s*"_rowid"/);
  assert.deepEqual(plan.columns, ['rowid']);
  const integer = compile('SELECT rowid FROM audit ORDER BY rowid', scope, [], 'all', catalog);
  assert.match(integer.text, /SELECT\s*"id"\s+AS\s+rowid/);
});
test('catalog PRAGMAs read registered metadata and unsupported capabilities never invent success', (t) => {
  const { catalog } = catalogFixture(t);
  for (const sql of [
    'PRAGMA user_version',
    'PRAGMA data_version',
    'PRAGMA table_info(patients)',
    'PRAGMA index_list(patients)',
    'PRAGMA index_xinfo(patients_value)',
  ]) {
    const plan = compile(sql, scope, [], 'all', catalog);
    assert.match(plan.text, /cartoteca_catalog\./);
    assert.deepEqual(plan.values.slice(0, 2), ['cabinet', scope.storeId]);
  }
  for (const sql of [
    'PRAGMA integrity_check',
    'PRAGMA journal_mode=WAL',
    'PRAGMA user_version=999',
    'PRAGMA table_info(secret_table)',
  ])
    assert.throws(() => compile(sql, scope, [], 'all', catalog), {
      code: 'POSTGRES_SQL_UNSUPPORTED',
    });
  const master = compile(
    "SELECT name,sql FROM sqlite_master WHERE type='table' AND name=?",
    scope,
    ['patients'],
    'all',
    catalog,
  );
  assert.match(master.text, /cartoteca_catalog\s*\.\s*objects/);
  assert.deepEqual(master.values, ['cabinet', scope.storeId, 'patients']);
});
test('known idempotent DDL checks both canonical definition and actual physical object', (t) => {
  const { catalog } = catalogFixture(t);
  const plan = compile(
    'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value BLOB NOT NULL)',
    scope,
    [],
    'exec',
    catalog,
  );
  assert.equal(plan.effect, 'read');
  assert.match(plan.text, /pg_catalog.pg_class/);
  assert.match(plan.text, /CASE WHEN EXISTS/);
  assert.throws(
    () =>
      compile('CREATE TABLE IF NOT EXISTS meta(key TEXT,value BLOB)', scope, [], 'exec', catalog),
    { code: 'POSTGRES_SQL_UNSUPPORTED' },
  );
  assert.throws(
    () =>
      compile(
        'CREATE TRIGGER x AFTER INSERT ON meta BEGIN DELETE FROM meta; END',
        scope,
        [],
        'exec',
        catalog,
      ),
    { code: 'POSTGRES_SQL_UNSUPPORTED' },
  );
});
test('bound JSON batches preserve CTE parameters and use closed native compatibility functions', (t) => {
  const { catalog } = catalogFixture(t);
  const entries = JSON.stringify(['two', 'one', 'two']);
  const plan = compile(
    `WITH request_scope(org,entries) AS (VALUES(?,?))
    SELECT selected.id FROM json_each((SELECT entries FROM request_scope)) AS requested
    CROSS JOIN patients selected ON selected.id=requested.value ORDER BY requested.key`,
    scope,
    ['org', entries],
    'all',
    catalog,
  );
  assert.deepEqual(plan.values, ['org', entries]);
  assert.match(plan.text, /cartoteca_catalog\s*\.\s*json_each/);
  assert.match(plan.text, /"cartoteca_cabinet"\s*\.\s*"patients"/);
});
test('SQLite comparison and scalar forms preserve NULL behavior and explicit labels', (t) => {
  const { catalog } = catalogFixture(t);
  const plan = compile(
    `SELECT MIN(?,?) AS "UpperBound" FROM patients
    WHERE id GLOB ? AND id NOT LIKE ? AND id IS NOT ?`,
    scope,
    [null, 3, 'a*', 'A_%', null],
    'all',
    catalog,
  );
  assert.deepEqual(plan.values, [null, 3, 'a*', 'A_%', null]);
  assert.match(plan.text, /CASE WHEN/);
  assert.match(plan.text, /THEN NULL ELSE LEAST/);
  assert.match(plan.text, /AS\s*"UpperBound"/);
  assert.match(plan.text, /glob_match/);
  assert.match(plan.text, /NOT\s+cartoteca_catalog\s*\.\s*like_match/);
  assert.match(plan.text, /IS DISTINCT FROM/);
});
test('grouped predicates, subqueries and existing public-code storage checks stay closed SQL expressions', (t) => {
  const { catalog } = catalogFixture(t);
  const plan = compile(
    `SELECT (SELECT count(*) FROM patients WHERE (id=? OR id=?)) AS amount
     FROM patients WHERE (id=? AND (id<>? OR id IS NULL))`,
    scope,
    ['a', 'b', 'c', 'd'],
    'all',
    catalog,
  );
  assert.match(plan.text, /"cartoteca_cabinet"\s*\.\s*"patients"/);
  assert.deepEqual(plan.values, ['a', 'b', 'c', 'd']);
  const checks = compile(
    `SELECT typeof(id) AS kind,length(CAST(id AS BLOB)) AS bytes,instr(id,':') AS separator FROM patients`,
    scope,
    [],
    'all',
    catalog,
  );
  assert.match(checks.text, /cartoteca_catalog\s*\.\s*sqlite_typeof/);
  assert.match(checks.text, /pg_catalog\s*\.\s*convert_to/);
  assert.match(checks.text, /pg_catalog\s*\.\s*strpos/);
  assert.throws(() => compile('SELECT WHEREVER(id) FROM patients', scope, [], 'all', catalog), {
    code: 'POSTGRES_SQL_UNSUPPORTED',
  });
});
test('SQLite forced indexes require the same registered physical table before native planning', (t) => {
  const { catalog } = catalogFixture(t);
  for (const source of ['patients', 'patients AS p', 'patients p']) {
    const plan = compile(
      'SELECT * FROM ' + source + ' INDEXED BY patients_value WHERE value=?',
      scope,
      [Buffer.from('cipher')],
      'all',
      catalog,
    );
    assert.doesNotMatch(plan.text, /INDEXED\s+BY/);
    assert.match(plan.text, /"cartoteca_cabinet"\s*\.\s*"patients"/);
  }
  for (const source of ['patients INDEXED BY missing', 'meta INDEXED BY patients_value'])
    assert.throws(() => compile('SELECT * FROM ' + source, scope, [], 'all', catalog), {
      code: 'POSTGRES_SQL_UNSUPPORTED',
    });
});
test('ON-qualified SQLite CROSS joins become native inner joins without changing Cartesian joins', (t) => {
  const { catalog } = catalogFixture(t);
  const plan = compile(
    'SELECT p.id FROM patients p CROSS JOIN patients other CROSS JOIN counters c ON c.id=other.id WHERE p.id=?',
    scope,
    ['a'],
    'all',
    catalog,
  );
  assert.equal((plan.text.match(/CROSS JOIN/g) || []).length, 1);
  assert.equal((plan.text.match(/INNER JOIN/g) || []).length, 1);
  const insert = compile(
    'INSERT INTO counters(id,revision) SELECT id,1 FROM patients WHERE 1 ON CONFLICT(id) DO UPDATE SET revision=revision+1',
    scope,
    [],
    'run',
    catalog,
  );
  assert.match(insert.text, /WHERE TRUE ON CONFLICT/);
  assert.match(insert.text, /ON CONFLICT\s*\(\s*"_store_id"/);
});
