const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { incremental185 } = require('./helpers/directory-incremental185-fixture.cjs');
const {
  realCodec,
  current,
  epoch,
  storeId,
  platformStoreId,
} = require('./helpers/directory-snapshot180-fixture.cjs');
const {
  projectionKey,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const {
  prepareHotDirectory170,
} = require('../src/server/infrastructure/postgres/hot-directory170.cjs');
const { samePlatform196 } = require('../src/server/infrastructure/postgres/hot-directory196.cjs');
function setup() {
  const f = incremental185(),
    operation = f.input.operation,
    generation = Object.freeze({}),
    selections = [];
  let seq = 1,
    changes = [],
    afterSelect = null;
  const head = () => ({
    epoch: '00000000-0000-4000-8000-000000000196',
    seq: String(seq),
    floorSeq: '0',
    resetSeq: '0',
  });
  Object.assign(operation, {
    directory196: true,
    directoryHead196: async () => head(),
    directoryChanges196: async () => ({ head: head(), identities: changes }),
    async selectDirectoryRows196(audience, ids) {
      selections.push([...ids]);
      const rows = [
        {
          id: 'directory164-ready',
          kind: 'meta',
          value: f.f.crypto.encode({ version: 1 }),
        },
        {
          id: 'revision',
          kind: 'meta',
          value: f.f.crypto.encode(f.expected().revision),
        },
      ];
      for (const id of ids) {
        const record = f.records.get(id);
        if (record)
          rows.push(
            { id, kind: 'summary', value: record.cipher },
            {
              id: projectionKey(id, audience),
              kind: 'meta',
              value: record.projection,
            },
          );
      }
      if (afterSelect) afterSelect(selections.length);
      return rows;
    },
  });
  f.input.prepared.keyGeneration196 = generation;
  return {
    f,
    generation,
    head,
    selections,
    change(id, patch) {
      f.change(id, patch);
      seq++;
      changes = [
        {
          identityDigest: createHash('sha256').update(id).digest('hex'),
          patientId: id,
          summaryChanged: true,
          projectionChanged: true,
        },
      ];
    },
    afterSelect(fn) {
      afterSelect = fn;
    },
  };
}
test('196 cold bootstrap and RR notes-only reads keep fresh revision without decoding the full catalogue again', async () => {
  const x = setup(),
    { f } = x;
  try {
    const first = await f.read();
    f.commit();
    assert.equal(first.status, 200);
    assert.equal(f.cache.stats196().bootstraps, 1);
    f.reset();
    f.nextStamp();
    const next = await f.read('limit=2');
    assert.equal(next.status, 200);
    assert.equal(next.body.revision, f.expected().revision);
    assert.equal(next.body.directory.length, 2);
    assert.equal(f.counts.full, 0);
    assert.deepEqual(
      x.selections.map((ids) => ids.length),
      [0, 2],
    );
    f.commit();
  } finally {
    f.close();
  }
});
test('196 changed rows update search after ACK, and discarded candidates never publish', async () => {
  const x = setup(),
    { f } = x;
  try {
    await f.read();
    f.commit();
    f.reset();
    const id = [...f.records.keys()][0];
    x.change(id, {
      name: 'Replacement196',
      firstName: 'Replacement196',
      lastName: '',
    });
    const result = await f.read('q=Replacement196&limit=2');
    assert.equal(result.body.directory[0].id, id);
    assert.equal(f.cache.stats196().patches, 0);
    f.discard();
    assert.equal(f.cache.stats196().patches, 0);
    const accepted = await f.read('q=Replacement196&limit=2');
    f.commit();
    assert.equal(accepted.body.directory[0].id, id);
    assert.equal(f.cache.stats196().patches, 1);
    assert.ok(x.selections.every((ids) => ids.length <= 2));
  } finally {
    f.close();
  }
});
test('196 current selected bytes are checked even when the logical sequence has not changed', async () => {
  const x = setup(),
    { f } = x;
  try {
    await f.read();
    f.commit();
    f.reset();
    f.corruptFull([...f.records.keys()][0]);
    await assert.rejects(f.read('limit=100'), { status: 503 });
    assert.equal(f.cache.stats196().patches, 0);
  } finally {
    f.close();
  }
});
test('196 hot notes path checks P+C after SQL and uses fresh public revision; revocation/key change deny reuse', async () => {
  const x = setup(),
    { f } = x,
    p = realCodec(),
    calls = [];
  try {
    const stamp = (c, pRev = '1') =>
      JSON.stringify([
        'scopes',
        ['platform', platformStoreId, '*', 'p', pRev],
        ['platform', platformStoreId, current.organizationId, 'po', '1'],
        ['cabinet', storeId, '*', 'c', String(c)],
      ]);
    f.input.operation.capturedVersions165 = () => stamp(1);
    await f.read();
    f.commit();
    f.nextStamp();
    const row = {
      fence_locked: true,
      id: current.sessionId,
      account_id: current.accountId,
      organization_id: current.organizationId,
      expires_at: Date.now() + 3600000,
      global_admin: 0,
      account_status: 'active',
      membership_role: 'owner',
      membership_status: 'active',
      organization_status: 'active',
      account_value: p.encode({
        email: 'synthetic@example.invalid',
        displayName: 'Synthetic',
      }),
      session_value: p.encode({}),
    };
    const input = {
      url: f.f.url('limit=2'),
      token: f.input.context.token,
      headers: f.input.context.req.headers,
      epoch,
      config: { dataDir: 'C:/synthetic196' },
      assertActive() {},
      engine: {
        directory196: true,
        marker: {
          platformStoreId,
          stores: [
            {
              kind: 'cabinet',
              storeId,
              organizationId: current.organizationId,
              relativeDirectory: 'tenants/' + current.organizationId,
            },
          ],
        },
        async hotMetadata169(args) {
          calls.push('SQL');
          assert.equal(args.directory196, true);
          assert.equal(args.selectedIds.length, 2);
          return {
            eligible: true,
            authorityRows: [row],
            versions: stamp(2),
            scope: { kind: 'cabinet', storeId },
            directory196: {
              head: x.head(),
              revisionCipher: f.f.crypto.encode(f.expected().revision),
              selected: args.selectedIds.map((id) => ({
                id,
                value: f.records.get(id).cipher,
              })),
            },
          };
        },
      },
      keyCache: {
        async forOperation() {
          calls.push('PC');
          return {
            platform: p,
            cabinet: { ...f.f.crypto, keyGeneration196: x.generation },
          };
        },
        async forPlatform() {
          calls.push('P');
          return p;
        },
      },
      cache: {
        hasClaim170: () => false,
        hasStamp171: () => false,
        get: () => null,
      },
      snapshots180: f.cache,
    };
    const finish = {
      contextMatches() {},
      runtime: () => ({}),
      respondSerialized: (_r, value) => JSON.parse(value),
      acceptColdAuthority171() {
        calls.push('cold');
      },
    };
    let reply = (await prepareHotDirectory170(input))(finish);
    assert.deepEqual(calls, ['SQL', 'PC']);
    assert.equal(reply.revision, f.expected().revision);
    assert.equal(f.cache.stats196().hits, 1);
    calls.length = 0;
    input.keyCache.forOperation = async () => {
      calls.push('PC');
      throw Object.assign(Error('changed'), { status: 503 });
    };
    await assert.rejects(prepareHotDirectory170(input), { status: 503 });
    assert.deepEqual(calls, ['SQL', 'PC']);
    row.membership_status = 'revoked';
    calls.length = 0;
    const denied = await prepareHotDirectory170(input);
    assert.throws(() => denied(finish));
    assert.ok(!calls.includes('PC'));
    assert.equal(samePlatform196(stamp(1), stamp(2)), true);
    assert.equal(samePlatform196(stamp(1), stamp(2, '2')), false);
  } finally {
    f.close();
  }
});
