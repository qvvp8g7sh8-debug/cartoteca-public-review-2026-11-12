const test = require('node:test');
const assert = require('node:assert/strict');
const { logical196, head, comparable } = require('./helpers/directory-logical196-fixture.cjs');
const { incremental185 } = require('./helpers/directory-incremental185-fixture.cjs');
test('196 unchanged directory uses one admitted index with fresh global body and cursor revisions', () => {
  const f = logical196({ count: 1500 });
  try {
    const before = f.budget.stats().bytes,
      original = f.state(),
      first = JSON.parse(f.render('q=Client&limit=1'));
    assert.deepEqual(Object.keys(original).sort(), ['epoch', 'seq', 'token']);
    for (let revision = 21; revision < 100; revision++) {
      const reply = JSON.parse(f.render('q=Client&limit=1', revision));
      assert.equal(reply.revision, revision);
      assert.equal(reply.directory.length, 1);
      assert.equal(
        f.f.crypto.decode(Buffer.from(reply.nextCursor, 'base64url')).revision,
        revision,
      );
    }
    assert.equal(f.state().token, original.token);
    assert.equal(f.decodeCalls(), 1500, 'hot renders never decode/bootstrap again');
    assert.equal(f.budget.stats().bytes, before);
    assert.throws(
      () => f.render('q=Client&limit=1&cursor=' + encodeURIComponent(first.nextCursor), 100),
      { status: 409 },
    );
    const peek = f.cache.peekForClaim196(f.f.claim, {
      url: f.input('q=Client&limit=1').url,
      cursorCrypto: f.f.crypto,
      keyGeneration: f.keyGeneration,
    });
    assert.equal(peek.proofs.length, 1);
    assert.equal(peek.proofs[0].fullHash, f.fullHashes.get(peek.proofs[0].id));
    assert.equal(peek.stamp, 'P196-C1');
    assert.equal('index' in peek || 'directory' in peek || 'body' in peek, false);
    assert.deepEqual(Object.keys(f.cache.stats()).sort(), [
      'entries',
      'evicted',
      'expired',
      'hits',
      'maxEntries',
      'maxRows',
      'misses',
      'rejected',
      'rows',
    ]);
    assert.equal(f.cache.stats196().bootstraps, 1);
    assert.equal(f.cache.stats196().hits, 80);
  } finally {
    f.close();
  }
});
test('196 selected-proof preview detaches data, reacquires ownership after await and detects key replacement', async () => {
  const f = logical196();
  try {
    const id = [...f.model.keys()][0],
      summary = { ...f.model.get(id), firstName: 'Ааа', name: 'Ааа' },
      changes = f.changes([{ id, summary }]),
      state = f.state(),
      options = {
        head: head(2),
        keyGeneration: f.keyGeneration,
        timeZone: f.f.timeZone,
        revision: 21,
      },
      preview = f.cache.previewChanges196(f.f.key, state, changes, options, f.input('limit=1', 21));
    assert.equal(preview.length, 1);
    assert.equal(preview[0].id, id);
    assert.equal(preview[0].fullHash, changes[0].fullHash);
    assert.equal(Object.isFrozen(preview) && Object.isFrozen(preview[0]), true);
    assert.equal(f.cache.state196(f.f.key, { keyGeneration: {}, timeZone: f.f.timeZone }), null);
    assert.equal(
      f.cache.peekForClaim196(f.f.claim, {
        url: f.input().url,
        cursorCrypto: f.f.crypto,
        keyGeneration: {},
      }),
      null,
    );
    await Promise.resolve();
    f.cache.clear();
    assert.equal(f.cache.build196(f.f.key, state, changes, options), null);
    assert.equal(f.budget.stats().bytes, 0);
    assert.equal(
      preview[0].fullHash,
      changes[0].fullHash,
      'proof has no borrowed mutable cache storage',
    );
  } finally {
    f.close();
  }
});
test('196 exact generation/head/token gates force bootstrap on reset, retention gaps and replacement', () => {
  const f = logical196();
  try {
    const state = f.state(),
      options = { keyGeneration: f.keyGeneration, timeZone: f.f.timeZone, revision: 21 };
    for (const next of [
      head(2, { epoch: 'other' }),
      head(2, { floorSeq: '2' }),
      head(2, { resetSeq: '2' }),
      head(0),
    ])
      assert.equal(f.cache.build196(f.f.key, state, [], { ...options, head: next }), null);
    assert.equal(
      f.cache.build196(f.f.key, { ...state, token: {} }, [], { ...options, head: head(2) }),
      null,
    );
    assert.equal(
      f.cache.build196(f.f.key, state, [], { ...options, keyGeneration: null, head: head(2) }),
      null,
    );
    assert.equal(
      f.cache.render196(
        f.f.key,
        { token: {}, head: head(1), keyGeneration: f.keyGeneration },
        f.input(),
      ),
      null,
    );
    assert.equal(
      f.cache.render196(
        f.f.key,
        { token: state.token, head: head(1), keyGeneration: f.keyGeneration },
        { ...f.input(), current: { ...f.input().current, sessionId: 'different196' } },
      ),
      null,
    );
    assert.equal(
      f.cache.render196(
        f.f.key,
        { token: state.token, head: head(2), keyGeneration: f.keyGeneration },
        f.input(),
      ),
      null,
    );
    assert.equal(
      f.cache.render196(
        f.f.key,
        { token: state.token, head: head(1), keyGeneration: f.keyGeneration },
        { ...f.input(), revision: undefined },
      ),
      null,
    );
    const changed = f.accept([]);
    assert.ok(changed);
    assert.notEqual(f.state().token, state.token);
    assert.equal(f.cache.build196(f.f.key, state, [], { ...options, head: head(3) }), null);
    assert.equal(f.cache.stats196().patches, 1);
    assert.equal(f.cache.stats196().bootstraps, 1);
  } finally {
    f.close();
  }
});
test('196 bounded delta overflow declines for bootstrap; IDs resolve without entire proof copies', () => {
  const f = logical196({ count: 40 });
  try {
    const ids = [...f.model.keys()],
      state = f.state(),
      resolved = f.cache.resolve196(
        f.f.key,
        state,
        [
          { identityDigest: f.identity(ids[1]), patientId: ids[1] },
          { identityDigest: f.identity('new196'), patientId: 'new196' },
        ],
        { keyGeneration: f.keyGeneration },
      );
    assert.deepEqual(
      resolved.map((r) => r.id),
      [ids[1], 'new196'],
    );
    assert.equal(
      f.cache.resolve196(
        f.f.key,
        state,
        [{ identityDigest: f.identity(ids[1]), patientId: 'wrong196' }],
        { keyGeneration: f.keyGeneration },
      ),
      null,
    );
    assert.deepEqual(
      f.cache
        .resolve196(f.f.key, state, [f.identity(ids[1])], { keyGeneration: f.keyGeneration })
        .map((r) => r.id),
      [ids[1]],
    );
    assert.equal(
      f.cache.resolve196(f.f.key, state, [f.identity('orphan196')], {
        keyGeneration: f.keyGeneration,
      }),
      null,
      'unmatched projection-only event requires bootstrap',
    );
    for (let n = 0; n < 32; n++)
      assert.ok(
        f.accept([{ id: ids[n], summary: { ...f.model.get(ids[n]), phone: 'changed196-' + n } }]),
      );
    assert.equal(
      f.accept([{ id: ids[32], summary: { ...f.model.get(ids[32]), phone: 'overflow196' } }]),
      null,
    );
    assert.equal(f.model.get(ids[32]).phone.includes('overflow'), false);
    assert.equal(f.cache.stats196().patches, 32);
    assert.equal(f.cache.stats196().fallback, 1);
    const bytes = f.budget.stats().bytes;
    assert.ok(
      bytes > 32 * 384,
      'full base, overlay, proof buffers and derivative reserve are charged',
    );
    f.cache.clear();
    assert.equal(f.budget.stats().bytes, 0);
  } finally {
    f.close();
  }
});
test('196 active retention renews only successful render; expired/keyless entries cannot be candidates', () => {
  const f = logical196();
  try {
    f.clock.now += 59000;
    assert.ok(f.render('limit=1'));
    f.clock.now += 59000;
    assert.ok(f.state());
    const bad = f.input('cursor=invalid');
    assert.equal(
      f.cache.peekForClaim196(f.f.claim, {
        url: bad.url,
        cursorCrypto: f.f.crypto,
        keyGeneration: f.keyGeneration,
      }),
      null,
    );
    assert.throws(() =>
      f.cache.render196(
        f.f.key,
        { token: f.state().token, head: head(1), keyGeneration: f.keyGeneration },
        { ...bad, expectedSelected196: [] },
      ),
    );
    f.clock.now += 1001;
    assert.equal(f.state(), null);
    assert.equal(f.budget.stats().bytes, 0);
  } finally {
    f.close();
  }
});
test('196 no-cursor claim peek is only a detached untrusted hint; it cannot grant keyless final output', () => {
  const f = logical196();
  try {
    const before = f.cache.stats196().hits,
      bytes = f.budget.stats().bytes,
      hint = f.cache.peekForClaim196(f.f.claim, { url: f.input('limit=1').url });
    assert.ok(hint);
    assert.equal(hint.proofs.length, 1);
    assert.equal(
      f.cache.render196(hint.key, { token: hint.token, head: hint.head }, f.input('limit=1')),
      null,
    );
    assert.equal(f.cache.stats196().hits, before);
    assert.equal(f.budget.stats().bytes, bytes);
    assert.equal(f.cache.peekForClaim196(f.f.claim, { url: f.input('cursor=').url }), null);
    assert.equal(f.cache.peekForClaim196(f.f.claim, { url: f.input('cursor=invalid').url }), null);
    assert.ok(
      f.cache.render196(
        hint.key,
        { token: hint.token, head: hint.head, keyGeneration: f.keyGeneration },
        { ...f.input('limit=1'), expectedSelected196: hint.proofs },
      ),
    );
  } finally {
    f.close();
  }
});
test('196 complete bootstrap captures logical head before private borrow and publishes only after ACK hook', async () => {
  const f = incremental185(),
    keyGeneration = Object.freeze({});
  try {
    f.input.operation.directoryHead196 = async () => {
      f.trace.push('head196');
      return head(1);
    };
    f.input.prepared.keyGeneration196 = keyGeneration;
    const reply = await f.read();
    assert.equal(reply.status, 200);
    assert.ok(f.trace.indexOf('head196') < f.trace.indexOf('all-select'));
    assert.equal(f.cache.state196(f.f.key, { keyGeneration, timeZone: f.f.timeZone }), null);
    f.commit();
    const state = f.cache.state196(f.f.key, { keyGeneration, timeZone: f.f.timeZone });
    assert.ok(state);
    assert.equal(state.seq, '1');
    assert.equal(f.cache.stats196().bootstraps, 1);
    assert.equal(f.cache.stats196().patches, 0);
    f.cache.clear();
    f.reset();
    await f.read();
    f.discard();
    assert.equal(f.cache.state196(f.f.key, { keyGeneration, timeZone: f.f.timeZone }), null);
    assert.equal(f.budget.stats().bytes, 0, 'lost commit ACK cannot retain a new owning snapshot');
  } finally {
    f.close();
  }
});
