const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fixture,
  current,
  realCodec,
  accountId,
  organizationId,
  sessionId,
  storeId,
  platformStoreId,
  epoch,
} = require('./helpers/directory-snapshot180-fixture.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectorySnapshotCache180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-cache180.cjs');
const {
  createDirectorySnapshotIndex180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');
const {
  prepareHotDirectory170,
} = require('../src/server/infrastructure/postgres/hot-directory170.cjs');

function retained188(indexFactory) {
  const f = fixture(),
    budget = createReadCacheBudget({ maxBytes: 1024 * 1024 });
  let now = 100;
  const cache = createDirectorySnapshotCache180({ budget, now: () => now, ttlMs: 1000 });
  const item = {
    key: f.key,
    claim: f.claim,
    stamp: 'C1',
    audience: '*',
    index: indexFactory?.(f) ?? f.snapshot,
  };
  assert.ok(item.index);
  assert.equal(cache.publish(item), true);
  return {
    f,
    budget,
    cache,
    item,
    input: { audience: '*', current, url: f.url('q=Legacy'), cursorCrypto: f.crypto },
    at(value) {
      now = value;
    },
    close() {
      cache.clear();
      f.close();
    },
  };
}

test('188 accepted current snapshot reads keep active representation resident without extra charge', () => {
  const b = retained188();
  try {
    const initial = b.budget.stats();
    for (const now of [1000, 1900, 2800, 3700]) {
      b.at(now);
      const page = b.cache.render(b.f.key, 'C1', b.input);
      assert.deepEqual(JSON.parse(page), b.f.legacy(b.input.url));
      assert.equal(b.cache.stats().entries, 1);
      assert.equal(b.budget.stats().bytes, initial.bytes);
      assert.equal(b.budget.stats().entries, initial.entries);
      assert.equal(b.budget.stats().peakBytes, initial.peakBytes);
    }
    assert.equal(b.cache.stats().hits, 4);
    b.at(4699);
    assert.equal(b.cache.hasClaim180(b.f.claim), true);
    b.at(4700);
    assert.equal(
      b.cache.render(b.f.key, 'C1', b.input),
      null,
      'inactive for full TTL still expires at boundary',
    );
    assert.equal(b.cache.hasClaim180(b.f.claim), false);
    assert.equal(b.budget.stats().bytes, 0);
  } finally {
    b.close();
  }
});

test('188 metadata hints and detached proof inspection never renew inactive snapshots', () => {
  const b = retained188();
  try {
    b.at(1000);
    assert.equal(b.cache.has(b.f.key), true);
    assert.equal(b.cache.hasClaim180(b.f.claim), true);
    assert.equal(b.cache.hasStamp180(b.f.key, 'C1'), true);
    b.cache.proofs185(b.f.key, b.f.timeZone);
    b.at(1100);
    assert.equal(b.cache.render(b.f.key, 'C1', b.input), null);
    assert.equal(b.cache.stats().expired, 1);
    assert.equal(b.cache.stats().hits, 0);
    assert.equal(b.budget.stats().bytes, 0);
  } finally {
    b.close();
  }
});

test('188 foreign stamp or audience and unsupported rendering do not keep an entry alive', () => {
  for (const change of [
    (b) => b.cache.render(b.f.key, 'C2', b.input),
    (b) => b.cache.render(b.f.key, 'C1', { ...b.input, audience: 'a'.repeat(64) }),
    (b) => b.cache.render(b.f.key, 'C1', { ...b.input, cursorCrypto: null }),
  ]) {
    const b = retained188();
    try {
      b.at(1000);
      assert.equal(change(b), null);
      b.at(1100);
      assert.equal(b.cache.render(b.f.key, 'C1', b.input), null);
      assert.equal(b.cache.stats().hits, 0);
      assert.equal(b.budget.stats().bytes, 0);
    } finally {
      b.close();
    }
  }
});

test('188 oversize private page fallback does not renew a snapshot', () => {
  const b = retained188((f) =>
    createDirectorySnapshotIndex180(
      Array.from({ length: 20 }, (_, n) => ({
        ...f.rows[0],
        id: 'large188-' + n,
        name: 'Synthetic188-' + 'x'.repeat(4000),
      })),
      { revision: f.revision, timeZone: f.timeZone },
    ),
  );
  try {
    b.at(1000);
    assert.equal(b.cache.render(b.f.key, 'C1', { ...b.input, url: b.f.url('limit=100') }), null);
    b.at(1100);
    assert.equal(b.cache.has(b.f.key), false);
    assert.equal(b.cache.stats().hits, 0);
    assert.equal(b.budget.stats().bytes, 0);
  } finally {
    b.close();
  }
});

test('188 invalid cursor, renderer and budget errors never renew a retained entry', () => {
  for (const kind of ['cursor', 'renderer', 'budget']) {
    const b = retained188();
    try {
      b.at(1000);
      if (kind === 'cursor') {
        assert.throws(
          () => b.cache.render(b.f.key, 'C1', { ...b.input, url: b.f.url('cursor=invalid') }),
          { status: 400 },
        );
      } else if (kind === 'renderer') {
        const error = Error('synthetic188-render');
        assert.throws(
          () =>
            b.cache.render(b.f.key, 'C1', {
              ...b.input,
              url: b.f.url('limit=1'),
              cursorCrypto: {
                ...b.f.crypto,
                encode() {
                  throw error;
                },
              },
            }),
          (value) => value === error,
        );
      } else {
        b.budget.touch = () => {
          throw Error('synthetic188-budget');
        };
        assert.throws(() => b.cache.render(b.f.key, 'C1', b.input), /synthetic188-budget/);
      }
      b.at(1100);
      assert.equal(b.cache.hasClaim180(b.f.claim), false);
      assert.equal(b.budget.stats().bytes, 0);
    } finally {
      b.close();
    }
  }
});

test('188 renewed entries remain subject to exact row eviction, shared budget eviction and clear', () => {
  const b = retained188();
  try {
    b.at(1000);
    assert.equal(typeof b.cache.render(b.f.key, 'C1', b.input), 'string');
    b.budget.clear();
    assert.equal(b.cache.hasClaim180(b.f.claim), false);
    assert.equal(b.cache.stats().entries, 0);
    assert.equal(b.budget.stats().bytes, 0);
    b.cache.publish(b.item);
    b.cache.clear();
    assert.equal(b.cache.stats().rows, 0);
    assert.equal(b.cache.hasClaim180(b.f.claim), false);
    assert.equal(b.budget.stats().bytes, 0);
    const small = createDirectorySnapshotCache180({ budget: b.budget, maxRows: 6 });
    assert.equal(small.publish(b.item), true);
    assert.equal(typeof small.render(b.f.key, 'C1', b.input), 'string');
    assert.equal(small.publish({ ...b.item, key: 'other188', claim: 'other188' }), true);
    assert.equal(small.hasClaim180(b.f.claim), false);
    assert.equal(small.stats().rows, 6);
    small.clear();
  } finally {
    b.close();
  }
});

test('188 expiry or revocation during fresh assets await cannot resurrect a cached answer', async () => {
  for (const kind of ['expiry', 'revoke']) {
    const b = retained188(),
      platformCrypto = realCodec();
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
        email: 'synthetic188@example.invalid',
        displayName: 'Synthetic',
      }),
      session_value: platformCrypto.encode({}),
    };
    let output = false;
    const input = {
      url: b.input.url,
      token: 'synthetic180-cookie',
      epoch,
      headers: {
        'x-cartoteca-account-id': accountId,
        'x-cartoteca-organization-id': organizationId,
      },
      config: { dataDir: 'C:/synthetic188' },
      assertActive() {},
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
          return {
            eligible: true,
            authorityRows: [row],
            versions: 'C1',
            scope: { kind: 'cabinet', storeId, organizationId },
          };
        },
      },
      keyCache: {
        async forPlatform() {
          return platformCrypto;
        },
        async forOperation() {
          await Promise.resolve();
          if (kind === 'expiry') b.at(1100);
          else row.membership_status = 'inactive';
          return { platform: platformCrypto, cabinet: b.f.crypto };
        },
      },
      cache: {
        hasClaim170: () => false,
        hasStamp171: () => false,
        get() {
          throw Error('No exact body');
        },
      },
      snapshots180: b.cache,
    };
    try {
      const finish = await prepareHotDirectory170(input);
      let answer = null;
      try {
        answer = finish?.({
          contextMatches() {},
          runtime: () => ({ timestamp: Date.now() }),
          acceptColdAuthority171() {},
          respondSerialized() {
            output = true;
          },
        });
      } catch (error) {
        assert.ok([401, 403].includes(error.status));
      }
      assert.equal(answer, null);
      assert.equal(output, false);
      assert.equal(b.cache.stats().hits, 0);
      b.at(1100);
      assert.equal(b.cache.hasClaim180(b.f.claim), false);
    } finally {
      b.close();
    }
  }
});
