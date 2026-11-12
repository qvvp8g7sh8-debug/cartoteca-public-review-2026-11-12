const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const { createReadViewCache } = require('../src/server/infrastructure/read-view-cache152.cjs');
const {
  authorityQuery,
  authorityValue,
} = require('../src/server/infrastructure/postgres/read-session152.cjs');
const {
  sourceProbe,
  sourceWitness,
} = require('../src/server/infrastructure/postgres/read-source-probe152.cjs');
test('152 shared projection cache is byte bounded, rejects oversized entries and never lends mutable graphs', () => {
  let time = 1000;
  const budget = createReadCacheBudget({ maxBytes: 2048 });
  const cache = createReadViewCache({ budget, maximumEntries: 2, ttlMs: 100, now: () => time });
  cache.put('org-owner', 'one', { patients: [{ name: 'Synthetic' }] });
  const first = cache.get('org-owner', 'one');
  first.patients[0].name = 'Changed';
  assert.equal(cache.get('org-owner', 'one').patients[0].name, 'Synthetic');
  assert.equal(cache.get('org-staff', 'one'), null);
  assert.equal(cache.get('org-owner', 'two'), null, 'fresh source version invalidates');
  cache.put('org-owner', 'two', { value: 1 });
  time = 1101;
  assert.equal(cache.get('org-owner', 'two'), null);
  cache.put('org-owner', null, { value: 'unattested' });
  assert.equal(cache.get('org-owner', null), null);
  cache.put('big', 'one', { value: 'x'.repeat(600000) });
  assert.equal(cache.get('big', 'one'), null);
  cache.put('a', 'one', { value: 'x'.repeat(300) });
  cache.put('b', 'one', { value: 'y'.repeat(300) });
  assert.ok(budget.stats().bytes <= 2048);
  cache.clear();
  assert.equal(budget.stats().bytes, 0);
});
test('152 native authority shares policy, never trusts headers, and requires its physical guard', () => {
  const query = authorityQuery(
    { kind: 'platform', storeId: 'physical-platform' },
    'synthetic-session',
  );
  assert.equal(query.values.length, 3);
  assert.equal(query.text.includes('pg_try_advisory_xact_lock_shared'), true);
  assert.equal(query.text.includes('synthetic-session'), false);
  assert.throws(() => authorityValue([{ fence_locked: false }], () => {}), {
    code: 'POSTGRES_BUSY',
  });
  assert.deepEqual(
    authorityValue([{ fence_locked: true, id: null }], () => {}),
    { supported: true, current: null },
  );
  const row = {
    fence_locked: true,
    id: 'session',
    account_id: 'account',
    organization_id: 'org',
    expires_at: String(Date.now() + 100000),
    global_admin: '0',
    account_status: 'active',
    organization_status: 'active',
    membership_status: 'active',
    membership_role: 'owner',
    account_value: { email: 'synthetic@invalid.test', displayName: 'Synthetic' },
  };
  const result = authorityValue([row], (value) => value);
  assert.equal(result.current.role, 'owner');
  assert.equal(result.current.organizationId, 'org');
  assert.equal(
    authorityValue([{ ...row, membership_status: 'inactive' }], (value) => value).current,
    null,
  );
  assert.equal(authorityValue([{ ...row, expires_at: 0 }], (value) => value).current, null);
  assert.equal(
    authorityValue([{ ...row, organization_id: null }], (value) => value).unsupported,
    'session-selection',
  );
});
test('152 source witnesses cover exact selection, bounded physical row versions and scope', () => {
  const source = {
    scope: { kind: 'cabinet', storeId: 'cabinet' },
    catalog: {
      version: 2,
      tables: {
        meta: {
          columns: [
            { name: 'key', type: 'TEXT' },
            { name: 'value', type: 'BLOB' },
          ],
        },
      },
    },
    table: 'meta',
    where: 's.key=$2',
    values: ['revision'],
  };
  const text = sourceProbe(source, 0, 0, { witness: true });
  assert.match(text, /ctid/);
  assert.match(text, /xmin/);
  assert.match(text, /row_number<=4096/);
  assert.match(text, /FILTER/);
  assert.match(text, /sha256/);
  assert.equal(text.includes('revision'), false);
  const proof = 'a'.repeat(64);
  assert.notEqual(
    sourceWitness([source], [proof]),
    sourceWitness([{ ...source, scope: { kind: 'cabinet', storeId: 'other' } }], [proof]),
  );
  assert.equal(sourceWitness([source], [null]), null);
});

const {
  createReadResultCache,
  resultCacheKey,
} = require('../src/server/infrastructure/postgres/read-result-cache153.cjs');
test('153 cached SQL rows retain byte ownership and require a fresh exact scope/selection witness', () => {
  const budget = createReadCacheBudget({ maxBytes: 2048 }),
    cache = createReadResultCache({ budget });
  const read = {
    scope: { kind: 'platform', storeId: 'p' },
    plan: { text: 'SELECT value FROM organization', values: ['org'] },
    method: 'get',
  };
  const key = resultCacheKey('worker', read, 'witness');
  assert.notEqual(key, resultCacheKey('worker', read, 'new'));
  assert.notEqual(
    key,
    resultCacheKey('worker', { ...read, scope: { kind: 'platform', storeId: 'other' } }, 'witness'),
  );
  assert.equal(
    resultCacheKey(
      'worker',
      { ...read, plan: { text: 'SELECT value FROM platform_sessions', values: [] } },
      'witness',
    ),
    null,
  );
  assert.equal(
    resultCacheKey('worker', { ...read, plan: { text: 'SELECT now()', values: [] } }, 'witness'),
    null,
  );
  assert.equal(resultCacheKey('worker', read, null), null);
  const value = { rows: [[Buffer.from('cipher')]], fields: [{ name: 'value', dataTypeID: 17 }] };
  cache.put(key, value);
  value.rows[0][0][0] = 0;
  const borrowed = cache.get(key);
  assert.equal(borrowed.rows[0][0].toString(), 'cipher');
  borrowed.rows[0][0][0] = 0;
  assert.equal(cache.get(key).rows[0][0].toString(), 'cipher');
  cache.put('huge', { rows: [[Buffer.alloc(300000)]], fields: [] });
  assert.equal(cache.get('huge'), null);
  cache.clear();
  assert.equal(budget.stats().bytes, 0);
});
