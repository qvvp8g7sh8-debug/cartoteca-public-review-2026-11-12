const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { createPatientRecords } = require('../src/server/infrastructure/cabinet-records.cjs');
const { createCabinetIndexes } = require('../src/server/infrastructure/cabinet-indexes.cjs');
const { createTenantPool } = require('../src/server/infrastructure/tenant-pool.cjs');

function laboratory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-open-phases-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) if (store.db.isOpen) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open(id, options) {
      const store = createStorage(path.join(root, id), options);
      stores.push(store);
      return store;
    },
  };
}

for (const version of [1, 2]) {
  test(`prepared cabinet ${version} reads schema once on every open without repeated DDL`, (t) => {
    const lab = laboratory(t);
    lab.open('prepared', { cabinetSchema: version }).close();
    const queries = [], commands = [];
    const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
      queries.push(sql);
      return prepare.call(this, sql, ...args);
    });
    t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
      commands.push(sql);
      return exec.call(this, sql, ...args);
    });
    for (let reopen = 0; reopen < 2; reopen++) {
      queries.length = 0; commands.length = 0;
      const store = lab.open('prepared', { cabinetSchema: version });
      assert.equal(queries.filter((sql) => sql === 'PRAGMA user_version').length, 1);
      assert.ok(commands.every((sql) => !/CREATE |VACUUM|user_version=/i.test(sql)));
      assert.equal(store.capabilities.cabinetSchemaVersion, version);
      assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
      assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      store.close();
    }
  });
}

test('schema zero still uses the migration path and standalone factories read current schema', (t) => {
  const lab = laboratory(t), store = lab.open('original');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='cabinet_summaries'").get());
  let reads = 0;
  const db = { prepare(sql) {
    assert.equal(sql, 'PRAGMA user_version');
    reads++;
    return { get: () => ({ user_version: 1 }) };
  } };
  assert.equal(createPatientRecords({ db }), null);
  createCabinetIndexes({ db });
  assert.equal(reads, 2);
});

test('reopen checks current schema, marker and key independently of earlier successful open', (t) => {
  const lab = laboratory(t), directory = path.join(lab.root, 'guarded');
  const store = lab.open('guarded');
  store.db.exec('PRAGMA user_version=3');
  store.close();
  assert.throws(() => lab.open('guarded'), /Unsupported cabinet database version/);
  assert.throws(() => lab.open('guarded', { cabinetSchema: 1 }), /offline copy/);
  const marker = path.join(directory, '.cabinet-records-in-progress');
  fs.writeFileSync(marker, 'synthetic');
  assert.throws(() => lab.open('guarded'), /Incomplete cabinet records copy/);
  fs.unlinkSync(marker);
  fs.renameSync(path.join(directory, 'encryption.key'), path.join(directory, 'saved-test-key'));
  assert.throws(() => lab.open('guarded'), /Encryption key is missing/);
  assert.equal(fs.existsSync(path.join(directory, 'encryption.key')), false);
});

test('malformed normalized schema still fails closed and closes its connection', (t) => {
  const lab = laboratory(t), store = lab.open('malformed', { cabinetSchema: 2 });
  store.db.exec('DROP TABLE cabinet_patient_records');
  store.close();
  let failedConnection;
  const close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'close', function (...args) {
    failedConnection = this;
    return close.apply(this, args);
  });
  const phases = [];
  assert.throws(() => lab.open('malformed', {
    cabinetSchema: 2,
    observeOpen(name, ms, failed) { phases.push({ name, ms, failed }); },
  }), /no such table/);
  assert.equal(failedConnection.isOpen, false);
  assert.deepEqual(phases.map(({ name, failed }) => [name, failed]), [
    ['key', false], ['configuration', false], ['schema', true],
  ]);
});

test('open observers cannot change a successful outcome or hide a configuration failure', (t) => {
  const lab = laboratory(t), phases = [];
  const store = lab.open('observed', { observeOpen(name, elapsed, failed) {
    phases.push([name, elapsed, failed]);
    throw Error('Synthetic observer failure');
  } });
  assert.deepEqual(phases.map(([name]) => name), ['key', 'configuration', 'schema', 'indexes']);
  assert.ok(phases.every(([, ms, failed]) => Number.isFinite(ms) && ms >= 0 && !failed));
  store.close();
  const fault = Error('Synthetic configuration failure'), exec = DatabaseSync.prototype.exec;
  let connection;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (sql === 'PRAGMA foreign_keys=ON') { connection = this; throw fault; }
    return exec.call(this, sql, ...args);
  });
  phases.length = 0;
  assert.throws(() => lab.open('observed', { observeOpen(name, ms, failed) {
    phases.push([name, ms, failed]);
    throw Error('Synthetic observer failure');
  } }), (error) => error === fault);
  assert.equal(connection.isOpen, false);
  assert.deepEqual(phases.map(([name, , failed]) => [name, failed]), [
    ['key', false], ['configuration', true],
  ]);
});

test('pool open phases are bounded, contain no tenant labels and preserve independent snapshots', () => {
  let failOpen = true;
  const pool = createTenantPool({ limit: 1, open(id, observe) {
    observe('key', 0.5, false);
    observe('configuration', 1500, failOpen);
    observe('schema', 5, false);
    observe('indexes', 10, false);
    observe(id, 1, false);
    observe('__proto__', 1, false);
    observe('key', NaN, false);
    if (failOpen) throw Error('Synthetic opening failure');
    return { close() {} };
  } });
  try {
    assert.throws(() => pool.get('private-tenant'), /Synthetic opening failure/);
    failOpen = false;
    pool.get('private-tenant');
    const snapshot = pool.stats();
    assert.equal(snapshot.openErrors, 1);
    assert.equal(snapshot.opens, 1);
    assert.deepEqual(Object.keys(snapshot.openPhases), ['key', 'configuration', 'schema', 'indexes']);
    assert.deepEqual(snapshot.openPhases.configuration, {
      count: 2, errors: 1, totalMs: 3000, maxMs: 1500, buckets: [0, 0, 0, 0, 0, 0, 0, 2],
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /private-tenant/);
    snapshot.openPhases.configuration.buckets[0] = 99;
    snapshot.openPhases.configuration.count = 99;
    snapshot.openBoundsMs[0] = 99;
    assert.equal(pool.stats().openPhases.configuration.count, 2);
    assert.equal(pool.stats().openPhases.configuration.buckets[0], 0);
    assert.equal(pool.stats().openBoundsMs[0], 1);
  } finally { pool.close(); }
});

test('real storage phase observer reaches pool metrics for a reopened tenant', (t) => {
  const lab = laboratory(t);
  const pool = createTenantPool({ limit: 1, open(id, observeOpen) {
    return lab.open(id, { observeOpen });
  } });
  try {
    pool.get('a'); pool.get('b'); pool.get('a');
    const stats = pool.stats();
    assert.equal(stats.opens, 3);
    for (const phase of Object.values(stats.openPhases)) {
      assert.equal(phase.count, 3);
      assert.equal(phase.errors, 0);
      assert.equal(phase.buckets.reduce((sum, count) => sum + count, 0), 3);
      assert.ok(phase.totalMs >= phase.maxMs);
    }
  } finally { pool.close(); }
});
