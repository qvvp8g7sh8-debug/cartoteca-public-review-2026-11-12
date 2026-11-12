const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createAdminDirectory } = require('../src/server/modules/admin/directory.cjs');
const {
  describeSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE organizations(id TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE admin_directory_records(kind TEXT NOT NULL,resource_id TEXT NOT NULL,source_value BLOB NOT NULL,PRIMARY KEY(kind,resource_id));
    CREATE TABLE admin_directory_terms(kind TEXT NOT NULL,resource_id TEXT NOT NULL,term_hash TEXT NOT NULL,PRIMARY KEY(kind,resource_id,term_hash),FOREIGN KEY(kind,resource_id) REFERENCES admin_directory_records(kind,resource_id) ON DELETE CASCADE);`);
  const counts = { sourceGets: 0, previousGets: 0, opened: 0, writes: 0, candidates: [] };
  const touched = [];
  let observer,
    failSecondSave = false,
    saves = 0;
  const db = {
    prepare(sql) {
      const native = sqlite.prepare(sql);
      return {
        get(...values) {
          if (/^SELECT value FROM (accounts|organizations) WHERE id=\?$/.test(sql))
            counts.sourceGets++;
          if (sql.startsWith('SELECT source_value FROM admin_directory_records'))
            counts.previousGets++;
          return native.get(...values);
        },
        all: (...values) => native.all(...values),
        iterate(...values) {
          if (sql.startsWith('SELECT r.id FROM ')) counts.candidates.push({ sql, values });
          return native.iterate(...values);
        },
        run(...values) {
          counts.writes++;
          if (
            failSecondSave &&
            sql.startsWith('INSERT INTO admin_directory_records') &&
            ++saves === 2
          )
            throw Error('Synthetic second index write failed');
          return native.run(...values);
        },
      };
    },
  };
  const context = {
    db,
    open(bytes) {
      counts.opened++;
      return JSON.parse(Buffer.from(bytes));
    },
    limitKey(scope, term) {
      return crypto
        .createHash('sha256')
        .update(scope + ':' + term)
        .digest('hex');
    },
    fail(status, message) {
      return Object.assign(Error(message), { status });
    },
    transaction(callback) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const value = callback();
        sqlite.exec('COMMIT');
        return value;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    setAuditObserver(value) {
      observer = value;
    },
  };
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const account = (id, displayName = id) =>
    sqlite
      .prepare('INSERT INTO accounts VALUES(?,?)')
      .run(id, encode({ displayName, email: id + '@example.test' }));
  const organization = (id, name = id) =>
    sqlite
      .prepare('INSERT INTO organizations VALUES(?,?)')
      .run(id, encode({ name, city: 'Tbilisi', phone: '+79180000000' }));
  const build = () => createAdminDirectory(context, { touch: (...values) => touched.push(values) });
  const reset = () => {
    counts.sourceGets = 0;
    counts.previousGets = 0;
    counts.opened = 0;
    counts.writes = 0;
    counts.candidates = [];
  };
  return {
    sqlite,
    context,
    encode,
    counts,
    touched,
    account,
    organization,
    build,
    reset,
    observer: (...values) => observer(...values),
    failSecondSave() {
      saves = 0;
      failSecondSave = true;
    },
  };
}

function directoryRows(sqlite) {
  return {
    records: sqlite
      .prepare('SELECT * FROM admin_directory_records ORDER BY kind,resource_id')
      .all(),
    terms: sqlite
      .prepare('SELECT * FROM admin_directory_terms ORDER BY kind,resource_id,term_hash')
      .all(),
  };
}

test('prepared startup uses two candidate reads without per-record reads, decrypts or writes', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 20; index++) {
    f.account('account-' + index);
    f.organization('organization-' + index);
  }
  f.build();
  const before = directoryRows(f.sqlite);
  f.reset();
  f.build();
  assert.equal(f.counts.candidates.length, 2);
  assert.equal(f.counts.sourceGets, 0);
  assert.equal(f.counts.previousGets, 0);
  assert.equal(f.counts.opened, 0);
  assert.equal(f.counts.writes, 0);
  assert.deepEqual(directoryRows(f.sqlite), before);
  assert.deepEqual(f.touched, []);
});

test('startup repairs missing, stale and same-id wrong-kind records while preserving matching ciphertext', (t) => {
  const f = fixture(t);
  for (const id of ['clean', 'missing', 'stale', 'same-id']) f.account(id);
  f.organization('same-id', 'Organization with shared identifier');
  f.build();
  const clean = f.sqlite
    .prepare(
      'SELECT * FROM admin_directory_terms WHERE kind=? AND resource_id=? ORDER BY term_hash',
    )
    .all('account', 'clean');
  const oldOrganization = f.sqlite
    .prepare('SELECT source_value FROM admin_directory_records WHERE kind=? AND resource_id=?')
    .get('organization', 'same-id');
  for (const id of ['missing', 'same-id'])
    f.sqlite
      .prepare('DELETE FROM admin_directory_records WHERE kind=? AND resource_id=?')
      .run('account', id);
  const current = f.encode({ displayName: 'Current Person', email: 'current@example.test' });
  f.sqlite.prepare('UPDATE accounts SET value=? WHERE id=?').run(current, 'stale');
  f.reset();
  f.build();
  assert.equal(f.counts.candidates.length, 2);
  assert.equal(f.counts.sourceGets, 3);
  assert.equal(f.counts.previousGets, 3);
  assert.equal(f.counts.opened, 3);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM admin_directory_records').get().n, 5);
  assert.deepEqual(
    Buffer.from(
      f.sqlite
        .prepare('SELECT source_value FROM admin_directory_records WHERE kind=? AND resource_id=?')
        .get('account', 'stale').source_value,
    ),
    current,
  );
  assert.deepEqual(
    f.sqlite
      .prepare(
        'SELECT * FROM admin_directory_terms WHERE kind=? AND resource_id=? ORDER BY term_hash',
      )
      .all('account', 'clean'),
    clean,
  );
  assert.deepEqual(
    f.sqlite
      .prepare('SELECT source_value FROM admin_directory_records WHERE kind=? AND resource_id=?')
      .get('organization', 'same-id'),
    oldOrganization,
  );
  assert.deepEqual(f.touched, []);
  f.reset();
  f.build();
  assert.equal(f.counts.sourceGets + f.counts.previousGets + f.counts.opened + f.counts.writes, 0);
});

test('a repair failure rolls back all startup index writes and post-start observer still follows bump rules', (t) => {
  const f = fixture(t);
  f.account('first');
  f.account('second');
  f.build();
  f.sqlite.prepare('DELETE FROM admin_directory_records').run();
  f.failSecondSave();
  assert.throws(() => f.build(), /Synthetic second index write failed/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM admin_directory_records').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM admin_directory_terms').get().n, 0);
});

test('observer refreshes search terms after startup and keeps version-one and ordinary bump semantics', (t) => {
  const f = fixture(t);
  f.account('person', 'OldName');
  f.build();
  const update = (name, version) => {
    f.sqlite
      .prepare('UPDATE accounts SET value=? WHERE id=?')
      .run(f.encode({ displayName: name, email: name.toLowerCase() + '@example.test' }), 'person');
    f.observer('account.updated', 'person', null, version === undefined ? {} : { version });
  };
  update('NewName');
  assert.deepEqual(f.touched, [['account', 'person']]);
  assert.ok(
    f.sqlite
      .prepare('SELECT 1 FROM admin_directory_terms WHERE kind=? AND resource_id=? AND term_hash=?')
      .get('account', 'person', f.context.limitKey('admin-search', 'newname')),
  );
  update('FinalName', 1);
  assert.deepEqual(f.touched, [['account', 'person']]);
  assert.ok(
    f.sqlite
      .prepare('SELECT 1 FROM admin_directory_terms WHERE kind=? AND resource_id=? AND term_hash=?')
      .get('account', 'person', f.context.limitKey('admin-search', 'finalname')),
  );
});

test('both startup LEFT JOIN variants compile to scoped PostgreSQL tables with binary inequality', (t) => {
  const f = fixture(t);
  f.account('a');
  f.organization('o');
  f.build();
  const catalog = describeSqliteSchema(f.sqlite);
  for (const { sql, values } of f.counts.candidates) {
    const plan = compile(
      sql,
      { kind: 'platform', storeId: '00000000-0000-4000-8000-000000000125' },
      values,
      'iterate',
      catalog,
    );
    assert.equal(plan.effect, 'read');
    assert.deepEqual(plan.values, values);
    assert.match(plan.text, /LEFT JOIN/i);
    assert.match(plan.text, /"cartoteca_platform"\s*\.\s*"admin_directory_records"/);
    const table = values[0] === 'account' ? 'accounts' : 'organizations';
    assert.match(plan.text, new RegExp('"cartoteca_platform"\\s*\\.\\s*"' + table + '"'));
    assert.match(plan.text, /d\s*\.\s*source_value\s*<>\s*r\s*\.\s*value/i);
    assert.match(plan.text, /d\s*\.\s*resource_id\s+IS NULL/i);
  }
});
