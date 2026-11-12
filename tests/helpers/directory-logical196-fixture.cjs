const { createHash } = require('node:crypto');
const { fixture, current } = require('./directory-snapshot180-fixture.cjs');
const { createReadCacheBudget } = require('../../src/server/infrastructure/read-cache-budget.cjs');
const {
  createDirectorySnapshotCache180,
} = require('../../src/server/infrastructure/postgres/directory-snapshot-cache180.cjs');
const {
  createDirectorySnapshotIndex185,
  directorySnapshotIndexInfo180,
} = require('../../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');
const { compact } = require('../../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { directoryPage } = require('../../src/server/modules/cabinet/directory.cjs');
const identity = (id) => createHash('sha256').update(id).digest('hex');
const head = (seq, extra = {}) => ({
  epoch: 'directory-epoch196',
  seq: String(seq),
  floorSeq: '0',
  resetSeq: '0',
  ...extra,
});
function logical196({ count = null, maxBytes = 192 * 1024 * 1024 } = {}) {
  const f = fixture(),
    rows =
      count === null
        ? f.rows.map((r) => structuredClone(r))
        : Array.from({ length: count }, (_, i) => ({
            ...structuredClone(f.rows[i % f.rows.length]),
            id: 'logical196-' + i,
            name: 'Synthetic Client ' + String(i).padStart(4, '0'),
            firstName: 'Synthetic',
            lastName: 'Client ' + String(i).padStart(4, '0'),
          })),
    model = new Map(rows.map((r) => [r.id, r])),
    ciphers = new Map(),
    fullHashes = new Map(),
    keyGeneration = Object.freeze({}),
    budget = createReadCacheBudget({ maxBytes }),
    clock = { now: 1000 },
    cache = createDirectorySnapshotCache180({ budget, now: () => clock.now });
  let sequence = 1,
    revision = 20,
    decodeCalls = 0;
  function encode(row) {
    const value = f.crypto.encode(row);
    ciphers.set(row.id, value);
    fullHashes.set(row.id, f.crypto.hash(value));
    return value;
  }
  const source = rows.map((row) => ({ id: row.id, value: encode(row) })),
    pairs = new Map(
      source.map((row) => [
        row.id,
        { projection: f.crypto.hash(Buffer.from(row.id)), full: fullHashes.get(row.id) },
      ]),
    ),
    original = createDirectorySnapshotIndex185(null, source, {
      pairs,
      revision,
      timeZone: f.timeZone,
      decode: (row) => {
        decodeCalls++;
        return f.crypto.decode(row.value);
      },
    });
  const index = cache.initialize196(original, { revision, timeZone: f.timeZone });
  if (!index) throw Error('logical fixture bootstrap failed');
  function publish(nextIndex, nextHead = head(sequence), stamp = 'P196-C' + sequence) {
    return cache.publish({
      key: f.key,
      stamp,
      claim: f.claim,
      audience: '*',
      index: nextIndex,
      logical196: { head: nextHead, keyGeneration, current, timeZone: f.timeZone },
    });
  }
  if (!publish(index)) throw Error('logical fixture admission failed');
  const input = (query = 'limit=100', nextRevision = revision) => ({
    current,
    url: f.url(query),
    cursorCrypto: f.crypto,
    audience: '*',
    revision: nextRevision,
  });
  const state = () => cache.state196(f.key, { keyGeneration, timeZone: f.timeZone });
  function changes(updates) {
    return updates.map(({ id, summary }) => {
      if (summary === null) return { id, summary: null };
      return { id, summary, fullHash: f.crypto.hash(f.crypto.encode(summary)) };
    });
  }
  function accept(updates, nextHead = head(sequence + 1)) {
    const delta = changes(updates),
      options = { head: nextHead, keyGeneration, timeZone: f.timeZone, revision: ++revision },
      candidate = state(),
      next = cache.build196(f.key, candidate, delta, options);
    if (!next) return null;
    if (!publish(next, nextHead)) throw Error('logical patch admission failed');
    sequence = Number(nextHead.seq);
    for (const row of delta) {
      if (row.summary === null) {
        model.delete(row.id);
        fullHashes.delete(row.id);
      } else {
        model.set(row.id, structuredClone(row.summary));
        fullHashes.set(row.id, row.fullHash);
      }
    }
    return next;
  }
  function expected(query = 'limit=100', rev = revision, sourceModel = model) {
    const page = directoryPage(
      f.storage,
      current,
      f.url(query),
      { revision: rev, directory: [...sourceModel.values()].map(compact) },
      f.timeZone,
    );
    page.directory = page.directory.map((r) => sourceModel.get(r.id));
    return page;
  }
  return {
    f,
    cache,
    budget,
    clock,
    model,
    keyGeneration,
    input,
    state,
    head,
    fullHashes,
    changes,
    publish,
    accept,
    expected,
    identity,
    bootstrapIndex: index,
    legacyIndex: original,
    revision: () => revision,
    sequence: () => sequence,
    decodeCalls: () => decodeCalls,
    info: directorySnapshotIndexInfo180,
    render(query, rev = revision) {
      const body = input(query, rev),
        hint = cache.peekForClaim196(f.claim, {
          url: body.url,
          cursorCrypto: f.crypto,
          keyGeneration,
        });
      return cache.render196(
        f.key,
        { token: state()?.token, head: head(sequence), keyGeneration },
        { ...body, expectedSelected196: hint?.proofs || [] },
      );
    },
    close() {
      cache.clear();
      budget.clear();
      f.close();
    },
  };
}
function comparable(value, crypto) {
  return {
    ...value,
    nextCursor: value.nextCursor ? crypto.decode(Buffer.from(value.nextCursor, 'base64url')) : null,
  };
}
module.exports = { logical196, head, comparable, current };
