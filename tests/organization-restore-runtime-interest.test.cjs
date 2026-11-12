const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { organizationRestoreFixture } = require('./helpers/organization-restore-fixture.cjs');
const {
  prepareOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-restore.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');
const fingerprint = (directory) => inventoryFingerprint(dataInventory(directory));
function seed(f) {
  const platform = f.openPlatform(),
    target = f.owners[0].organizationId,
    other = f.owners[1].organizationId;
  const keys = [
    'client-interest-v1:all:' + target,
    'client-interest-v1:reminder:' + target,
    'client-interest-v1:lifecycle:' + target,
  ];
  const unrelated = [
    'client-interest-v1:all:' + other,
    'client-interest-v1:reminder:' + target + '-extra',
    'client-interest-v1:ready',
    'operator-private-state',
  ];
  try {
    const insert = platform.db.prepare(
      'INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)',
    );
    for (const key of [...keys, ...unrelated]) insert.run(key, platform.seal({ synthetic: key }));
    return {
      target,
      keys,
      unrelated,
      changedValue: platform.seal({ synthetic: 'changed' }),
      rows: platform.db.prepare('SELECT key,value FROM telegram_runtime ORDER BY key').all(),
    };
  } finally {
    platform.db.close();
  }
}
function mutatingPrepare(mutate) {
  const mergePath = require.resolve('../src/server/infrastructure/backup/organization-merge.cjs');
  const restorePath =
    require.resolve('../src/server/infrastructure/backup/organization-restore.cjs');
  const originalMerge = require.cache[mergePath].exports,
    originalRestore = require.cache[restorePath];
  try {
    require.cache[mergePath].exports = {
      ...originalMerge,
      mergeOrganization(...args) {
        originalMerge.mergeOrganization(...args);
        mutate(args[0]);
      },
    };
    delete require.cache[restorePath];
    return require(restorePath).prepareOrganizationRestore;
  } finally {
    require.cache[mergePath].exports = originalMerge;
    require.cache[restorePath] = originalRestore;
  }
}
test('selective restore invalidates only the chosen organization client-interest hints and retains every unrelated runtime byte', async (t) => {
  const f = await organizationRestoreFixture(t, 11),
    before = seed(f),
    original = fingerprint(f.source);
  const result = await prepareOrganizationRestore(f.options);
  assert.equal(result.state, 'prepared');
  const candidate = new DatabaseSync(
    path.join(f.jobDirectory, 'candidate', 'platform', 'platform.sqlite'),
    { readOnly: true },
  );
  try {
    const rows = new Map(
      candidate
        .prepare('SELECT key,value FROM telegram_runtime')
        .all()
        .map((row) => [row.key, row.value]),
    );
    for (const key of before.keys) assert.equal(rows.has(key), false, key);
    for (const row of before.rows.filter((row) => !before.keys.includes(row.key)))
      assert.deepEqual(rows.get(row.key), row.value, row.key);
  } finally {
    candidate.close();
  }
  assert.equal(fingerprint(f.source), original);
});
test('selective restore still rejects changed deleted added or recreated runtime state outside the exact invalidation', async (t) => {
  const f = await organizationRestoreFixture(t, 11),
    before = seed(f),
    original = fingerprint(f.source);
  for (const [index, mutate] of [
    (db) =>
      db
        .prepare('UPDATE telegram_runtime SET value=? WHERE key=?')
        .run(before.changedValue, before.unrelated[0]),
    (db) => db.prepare('DELETE FROM telegram_runtime WHERE key=?').run(before.unrelated[1]),
    (db) =>
      db
        .prepare('INSERT INTO telegram_runtime VALUES(?,?)')
        .run('unexpected-global-key', before.changedValue),
    (db) =>
      db
        .prepare('INSERT INTO telegram_runtime VALUES(?,?)')
        .run(before.keys[0], before.changedValue),
  ].entries()) {
    const prepare = mutatingPrepare((candidate) => {
      const db = new DatabaseSync(path.join(candidate, 'platform', 'platform.sqlite'));
      try {
        mutate(db);
      } finally {
        db.close();
      }
    });
    await assert.rejects(
      prepare({ ...f.options, jobDirectory: path.join(f.directory, 'mutated-' + index) }),
      /Unrelated platform data changed/,
    );
    assert.equal(fingerprint(f.source), original);
  }
});
