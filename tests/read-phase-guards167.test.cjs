const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  platformGuard167,
  fenceRow167,
  catalogRow167,
  scopeRows167,
} = require('../src/server/infrastructure/postgres/read-phase-guards167.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const platform = { kind: 'platform', storeId: '00000000-0000-4000-8000-000000000001' };
const locks = [{ key: KEYS.maintenance, shared: true }],
  epoch = '00000000-0000-4000-8000-000000000002';
test('167 closed platform guard has opt-in clocks and cannot mutate scope or fetch ciphertext', () => {
  const plain = platformGuard167({ platform, locks });
  assert.deepEqual(plain.values, [KEYS.maintenance, platform.storeId]);
  assert.equal(/read_scope_|set_config|\.value\b/i.test(plain.text), false);
  const clock = platformGuard167({ platform, locks, organizationId: 'org' });
  assert.deepEqual(clock.values, [KEYS.maintenance, platform.storeId, ['*', 'org']]);
  assert.match(clock.text, /read_scope_versions163/);
  assert.match(clock.text, /FROM ct_release167 h LEFT JOIN ct_catalog167 c ON true/);
  assert.doesNotMatch(
    clock.text,
    /CASE[^;]+pg_advisory_unlock_shared/s,
    'empty/invalid catalog and false xact guard cannot suppress matching unlock',
  );
  for (const change of [
    { platform: { ...platform, kind: 'cabinet' } },
    { locks: [{ ...locks[0], shared: false }] },
    { locks: [null] },
    { locks: [{ ...locks[0], key: '1' }] },
    { organizationId: '' },
  ])
    assert.throws(() => platformGuard167({ platform, locks, ...change }), {
      code: 'POSTGRES_READ_GUARD_CONTEXT167',
      status: 503,
    });
});
test('167 fence parser preserves release evidence independently from missing/invalid catalog', () => {
  const result = {
    rows: [
      {
        locked: [false],
        released: [true],
        snapshot: '1:2:',
        version: null,
        catalog_hash: null,
        catalog_matches: null,
      },
    ],
  };
  const row = fenceRow167(result);
  assert.equal(row.released[0], true);
  assert.equal(catalogRow167(row, { metadata: { version: 19 }, hash: 'x' }), false);
  assert.throws(
    () =>
      catalogRow167(
        { ...row, version: 19, catalog_hash: 'wrong', catalog_matches: true },
        { metadata: { version: 19 }, hash: 'right' },
      ),
    { code: 'POSTGRES_CATALOG_INVALID' },
  );
  for (const result of [
    { rows: [] },
    { rows: [{ locked: [true], released: [], snapshot: '1:2:' }] },
    { rows: [{ locked: [true], released: [true], snapshot: '' }] },
  ])
    assert.throws(() => fenceRow167(result), { code: 'POSTGRES_READ_GUARD_FENCE167', status: 503 });
});
test('167 scalar clocks require the current component epoch and exact scope rows', () => {
  const rows = [
    ['*', epoch, '1'],
    ['org', epoch, '2'],
  ];
  assert.deepEqual(scopeRows167(rows, ['*', 'org'], epoch, epoch), rows);
  assert.equal(scopeRows167([rows[0]], ['*', 'org'], epoch, epoch), null);
  assert.equal(scopeRows167([rows[0], rows[0]], ['*', 'org'], epoch, epoch), null);
  assert.throws(() => scopeRows167(rows, ['*', 'org'], 'wrong', epoch), {
    code: 'POSTGRES_READ_SCOPE_COMPONENT_CHANGED',
  });
  assert.throws(() => scopeRows167([rows[0], ['org', epoch, '0']], ['*', 'org'], epoch, epoch), {
    code: 'POSTGRES_READ_SCOPE_VERSION',
  });
  assert.throws(() => scopeRows167([rows[0], ['org', epoch, 2]], ['*', 'org'], epoch, epoch), {
    code: 'POSTGRES_READ_SCOPE_VERSION',
  });
});
