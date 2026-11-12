const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fixture,
  realCodec,
  current,
  accountId,
  organizationId,
  sessionId,
  epoch,
  platformStoreId,
  storeId,
  other,
} = require('./helpers/directory-snapshot180-fixture.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectorySnapshotCache180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-cache180.cjs');
const {
  prepareHotDirectory170,
} = require('../src/server/infrastructure/postgres/hot-directory170.cjs');
function hotFixture() {
  const f = fixture(),
    platformCrypto = realCodec(),
    calls = [],
    budget = createReadCacheBudget({ maxBytes: 1024 * 1024 }),
    cache = createDirectorySnapshotCache180({ budget });
  const row = {
    fence_locked: true,
    id: sessionId,
    account_id: accountId,
    organization_id: organizationId,
    expires_at: Date.now() + 3600000,
    global_admin: 0,
    account_status: 'active',
    membership_role: 'owner',
    membership_status: 'active',
    organization_status: 'active',
    account_value: platformCrypto.encode({
      email: 'synthetic@example.invalid',
      displayName: 'Synthetic',
    }),
    session_value: platformCrypto.encode({}),
  };
  const metadata = {
    eligible: true,
    authorityRows: [row],
    versions: 'C1',
    scope: { kind: 'cabinet', storeId, organizationId },
  };
  cache.publish({ key: f.key, claim: f.claim, stamp: 'C1', audience: '*', index: f.snapshot });
  const input = {
    url: f.url('q=Legacy'),
    token: 'synthetic180-cookie',
    epoch,
    headers: { 'x-cartoteca-account-id': accountId, 'x-cartoteca-organization-id': organizationId },
    config: { dataDir: 'C:/synthetic180' },
    assertActive() {
      calls.push('active');
    },
    engine: {
      marker: {
        platformStoreId,
        stores: [
          {
            kind: 'cabinet',
            organizationId,
            storeId,
            relativeDirectory: 'tenants/' + organizationId,
          },
        ],
      },
      async hotMetadata169() {
        calls.push('metadata');
        return metadata;
      },
    },
    keyCache: {
      async forPlatform() {
        calls.push('P');
        return platformCrypto;
      },
      async forOperation() {
        calls.push('PC');
        return { platform: platformCrypto, cabinet: f.crypto };
      },
    },
    cache: {
      hasClaim170() {
        return false;
      },
      hasStamp171() {
        return false;
      },
      get() {
        throw Error('No exact query body');
      },
    },
    snapshots180: cache,
  };
  const finish = {
    contextMatches(value) {
      calls.push('context');
      assert.equal(value.accountId, accountId);
      assert.equal(value.organizationId, organizationId);
    },
    runtime() {
      return { timestamp: Date.now() };
    },
    respondSerialized(runtime, value) {
      calls.push('output');
      return { value };
    },
    acceptColdAuthority171() {
      calls.push('cold-authority');
    },
  };
  return {
    f,
    row,
    metadata,
    input,
    finish,
    cache,
    calls,
    close() {
      cache.clear();
      f.close();
    },
  };
}
test('180 unseen q uses snapshot only after one fresh metadata query and current assets/authority', async () => {
  const h = hotFixture();
  try {
    const finish = await prepareHotDirectory170(h.input);
    assert.ok(finish);
    assert.equal(h.calls.includes('output'), false);
    const result = finish(h.finish);
    assert.equal(JSON.parse(result.value).directory[0].name, 'Legacy Client');
    assert.equal(h.calls.filter((value) => value === 'metadata').length, 1);
    assert.ok(h.calls.indexOf('PC') < h.calls.indexOf('context'));
    assert.equal(h.cache.stats().hits, 1);
  } finally {
    h.close();
  }
});
test('180 source/session/role/revoke and eviction during assets cannot return a cached snapshot', async () => {
  const changes = [
    (h) => {
      h.metadata.versions = 'C2';
    },
    (h) => {
      h.row.id = other;
    },
    (h) => {
      h.row.membership_role = 'salon_admin';
    },
    (h) => {
      h.row.membership_status = 'inactive';
    },
    (h) => {
      h.row.global_admin = 1;
    },
    (h) => {
      h.row.expires_at = Date.now() - 1;
    },
    (h) => {
      const original = h.input.keyCache.forOperation;
      h.input.keyCache.forOperation = async () => {
        const value = await original();
        h.cache.clear();
        return value;
      };
    },
  ];
  for (const change of changes) {
    const h = hotFixture();
    change(h);
    try {
      const finish = await prepareHotDirectory170(h.input);
      let result = null;
      try {
        result = finish?.(h.finish);
      } catch (error) {
        assert.ok([401, 403].includes(error.status));
      }
      assert.equal(result, null);
      assert.equal(h.calls.includes('output'), false);
      assert.equal(h.cache.stats().hits, 0);
    } finally {
      h.close();
    }
  }
});
