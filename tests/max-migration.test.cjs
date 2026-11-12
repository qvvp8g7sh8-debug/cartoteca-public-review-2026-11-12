const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { maxFixture } = require('./max-fixture.cjs');
const {
  migrateMaxConnections,
  rollbackEmptyMaxConnections,
} = require('../src/server/migrations/012-max-connections.cjs');

test('candidate 012 creates only new storage; checked snapshot preserves previous version and encrypted records', (t) => {
  const f = maxFixture(t),
    db = f.database.db;
  rollbackEmptyMaxConnections(f.database);
  const before = db.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value;
  const result = migrateMaxConnections(f.database, f.directory);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.deepEqual(db.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value, before);
  assert.ok(
    result.snapshotDirectory.startsWith(path.join(f.directory, 'migration-backups') + path.sep),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(result.snapshotDirectory, 'platform.key')),
    f.database.key,
  );
  const snapshot = new DatabaseSync(path.join(result.snapshotDirectory, 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(snapshot.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(
      snapshot.prepare('SELECT value FROM accounts WHERE id=?').get('owner').value,
      before,
    );
    assert.equal(
      snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name='max_client_links'").get(),
      undefined,
    );
  } finally {
    snapshot.close();
  }
  const count = fs.readdirSync(path.join(f.directory, 'migration-backups')).length;
  migrateMaxConnections(f.database, f.directory);
  assert.equal(fs.readdirSync(path.join(f.directory, 'migration-backups')).length, count);
});

test('empty staging rollback is repeatably migratable; nonempty MAX storage refuses destructive rollback', (t) => {
  const f = maxFixture(t);
  rollbackEmptyMaxConnections(f.database);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 11);
  migrateMaxConnections(f.database, f.directory);
  const issued = f.links.issue('org', 'p', 'owner', '123', () => {}, f.now);
  assert.throws(() => rollbackEmptyMaxConnections(f.database), /MAX data exists/);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM max_client_tokens').get().n, 1);
  f.links.consume(issued.token, '123', '456', () => {}, f.now);
  assert.ok(f.links.link('org', 'p'));
});

test('candidate migration refuses an unexpected schema without applying anything', (t) => {
  const f = maxFixture(t);
  rollbackEmptyMaxConnections(f.database);
  f.database.db.exec('PRAGMA user_version=13');
  assert.throws(() => migrateMaxConnections(f.database, f.directory), /require platform schema 11/);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 13);
  assert.equal(
    f.database.db.prepare("SELECT 1 FROM sqlite_master WHERE name='max_client_links'").get(),
    undefined,
  );
});
