const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { createReadVersion } = require('../src/server/infrastructure/read-version.cjs');
const {
  revisionOptions,
} = require('../src/server/infrastructure/postgres/revision-operator132.cjs');
const {
  archiveRevisionProfile,
  validateArchivedRevisionProfile,
} = require('../src/server/infrastructure/postgres/revision-profile132.cjs');
const {
  revisionBody,
  legacyBody,
} = require('../src/server/infrastructure/postgres/revision-sql132.cjs');

test('attested revision profile compiles one fresh aggregate and legacy SQL remains unchanged', () => {
  const scope = { kind: 'platform', storeId: 'synthetic-platform' };
  const legacy = compile('PRAGMA data_version', scope, [], 'get', {});
  const native = compile('PRAGMA data_version', { ...scope, revisionProfile: 2 }, [], 'get', {});
  assert.equal(
    legacy.text,
    'SELECT revision AS data_version FROM cartoteca_catalog.stores WHERE kind=$1 AND store_id=$2',
  );
  assert.match(native.text, /SUM\(r\.revision\)/);
  assert.match(native.text, /s\.revision\+COALESCE/);
  assert.deepEqual(native.values, ['platform', 'synthetic-platform']);
  const changes = compile(
    'SELECT total_changes() AS n',
    { ...scope, revisionProfile: 2 },
    [],
    'get',
    {},
  );
  assert.match(changes.text, /SUM\(r\.revision\)/);
  assert.match(changes.text, /AS "n"/);
  assert.deepEqual(changes.values, native.values);
});

test('read-version observes every own-write and rollback clock change with one external read', () => {
  let revision = 123,
    clock = 0,
    reads = 0;
  const db = {
    dialect: 'postgres',
    revisionProfile: 2,
    get localMutationClock() {
      return clock;
    },
    prepare(sql) {
      assert.equal(sql, 'PRAGMA data_version');
      return {
        get() {
          reads++;
          return { data_version: revision };
        },
      };
    },
  };
  const read = createReadVersion(db),
    before = read();
  clock++;
  const first = read();
  clock++;
  const second = read();
  clock++;
  const rolledBack = read();
  assert.notDeepEqual(first, before);
  assert.notDeepEqual(second, first);
  assert.notDeepEqual(rolledBack, before, 'rollback cannot return the previous cache stamp');
  revision++;
  assert.notDeepEqual(read(), rolledBack);
  assert.equal(reads, 5);
});

test('offline revision operator rejects ambiguous or unapproved arguments before connections', () => {
  for (const args of [
    [],
    ['--offline'],
    ['--apply'],
    ['--offline', '--apply', '--dry-run'],
    ['--offline', '--apply', '--force'],
    ['--offline', '--offline'],
  ])
    assert.throws(() => revisionOptions(args), /exactly/);
  assert.deepEqual(revisionOptions(['--offline', '--apply']), { dryRun: false });
  assert.deepEqual(revisionOptions(['--dry-run', '--offline']), { dryRun: true });
});

test('backup revision profile is a closed version marker bound to the prepared helper', () => {
  const native = (body) => [
    {
      kind: 'platform',
      signature: {
        helpers: [
          { proname: 'bump_store_revision', definition: 'AS $function$' + body + '$function$' },
        ],
      },
    },
  ];
  assert.equal(archiveRevisionProfile(undefined), 1);
  assert.equal(validateArchivedRevisionProfile(native(legacyBody), undefined), 1);
  assert.equal(validateArchivedRevisionProfile(native(revisionBody), { version: 2 }), 2);
  for (const bad of [
    null,
    1,
    2,
    { version: 1 },
    { version: 2, sql: 'arbitrary' },
    { version: 4 },
    [],
  ])
    assert.throws(
      () => archiveRevisionProfile(bad),
      (error) => error.code === 'POSTGRES_REVISION_PROFILE_INVALID',
    );
  assert.throws(() => validateArchivedRevisionProfile(native(revisionBody), undefined));
  assert.throws(() => validateArchivedRevisionProfile(native(legacyBody), { version: 2 }));
  assert.throws(() => validateArchivedRevisionProfile([], { version: 2 }));
});
