const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { createReadVersion } = require('../src/server/infrastructure/read-version.cjs');
const {
  archiveRevisionProfile,
  validateArchivedRevisionProfile,
} = require('../src/server/infrastructure/postgres/revision-profile132.cjs');
const { revisionBody } = require('../src/server/infrastructure/postgres/revision-sql133.cjs');
const {
  revisionBody: domainBody,
} = require('../src/server/infrastructure/postgres/revision-sql132.cjs');
const {
  nativeCommandIsolation,
} = require('../src/server/infrastructure/native-command-routes.cjs');
test('profile 3 uses fresh exact opaque snapshots and monotonic local clock without numeric SQL', () => {
  let snapshot = '100:105:101,103',
    clock = 0,
    reads = 0;
  const db = {
    dialect: 'postgres',
    revisionProfile: 3,
    snapshotVersion() {
      reads++;
      return snapshot;
    },
    get localMutationClock() {
      return clock;
    },
    prepare() {
      assert.fail('profile 3 must not read compatibility revision counters');
    },
  };
  const read = createReadVersion(db),
    before = read();
  snapshot = '100:105:101';
  assert.notDeepEqual(read(), before, 'late commit must change an exact xip token');
  const late = read();
  clock++;
  assert.notDeepEqual(read(), late, 'own writes change the local clock');
  const written = read();
  clock++;
  assert.notDeepEqual(read(), written, 'rollback cannot reuse a previous cache stamp');
  assert.equal(reads, 6);
});
test('profile 3 numeric compatibility counters fail closed while profile 2 stays supported', () => {
  for (const sql of ['PRAGMA data_version', 'SELECT total_changes() AS n']) {
    assert.throws(
      () =>
        compile(sql, { kind: 'platform', storeId: 'synthetic', revisionProfile: 3 }, [], 'get', {}),
      (error) => error.code === 'POSTGRES_OPAQUE_READ_VERSION_REQUIRED',
    );
    assert.match(
      compile(sql, { kind: 'platform', storeId: 'synthetic', revisionProfile: 2 }, [], 'get', {})
        .text,
      /SUM/,
    );
  }
});
test('snapshot revision profile archives require a closed marker bound to the exact known helper', () => {
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
  assert.equal(archiveRevisionProfile({ version: 3 }), 3);
  assert.equal(validateArchivedRevisionProfile(native(revisionBody), { version: 3 }), 3);
  for (const marker of [{ version: 3, sql: 'injected' }, { version: 4 }, { version: '3' }])
    assert.throws(() => archiveRevisionProfile(marker));
  assert.throws(() => validateArchivedRevisionProfile(native(domainBody), { version: 3 }));
  assert.throws(() => validateArchivedRevisionProfile(native(revisionBody), { version: 2 }));
  assert.throws(() => validateArchivedRevisionProfile(native(revisionBody), undefined));
  assert.throws(() => validateArchivedRevisionProfile([], { version: 3 }));
  assert.throws(() =>
    validateArchivedRevisionProfile([...native(revisionBody), ...native(domainBody)], {
      version: 3,
    }),
  );
});
test('snapshot helper retains store guards and does not write revision state', () => {
  assert.match(revisionBody, /Store identity cannot change/);
  assert.match(revisionBody, /Store catalog missing/);
  assert.doesNotMatch(revisionBody, /(?:INSERT|UPDATE|DELETE) (?:INTO|cartoteca_catalog)/i);
  assert.equal(
    nativeCommandIsolation({ storageBackend: 'postgres', postgresRevisionProfile: 3 }),
    true,
  );
  assert.equal(
    nativeCommandIsolation({ storageBackend: 'postgres', postgresRevisionProfile: 1 }),
    false,
  );
});
