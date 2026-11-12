const test = require('node:test');
const assert = require('node:assert/strict');
const { logical196, comparable } = require('./helpers/directory-logical196-fixture.cjs');
const { patientSearchText } = require('../src/shared/patient-names.cjs');
const {
  renderDirectorySnapshotProven196,
} = require('../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');
function verify(f) {
  for (const today of ['2026-10-01', '2026-10-30', '2027-02-01'])
    for (const q of ['', 'Client', 'Ёж', '89990000001'])
      for (const sort of ['first', 'last'])
        for (const filter of ['all', 'appointment', 'recent', 'inactive']) {
          const base =
            'today=' +
            today +
            '&q=' +
            encodeURIComponent(q) +
            '&sort=' +
            sort +
            '&filter=' +
            filter +
            '&limit=1';
          let query = base;
          for (let page = 0; page <= f.model.size; page++) {
            const actual = JSON.parse(f.render(query)),
              expected = f.expected(query);
            assert.deepEqual(comparable(actual, f.f.crypto), comparable(expected, f.f.crypto));
            if (!actual.nextCursor) break;
            query = base + '&cursor=' + encodeURIComponent(actual.nextCursor);
          }
        }
}
test('196 cold base adds only a bounded ID order, without eager all-ID digest storage', () => {
  const f = logical196({ count: 1500 });
  try {
    assert.equal(f.info(f.bootstrapIndex).charge - f.info(f.legacyIndex).charge, 1500 * 4 + 3072);
    const id = [...f.model.keys()][0],
      options = { keyGeneration: f.keyGeneration };
    const resolved = f.cache.resolve196(
      f.f.key,
      f.state(),
      [{ identityDigest: f.identity(id), patientId: id }],
      options,
    );
    assert.equal(resolved[0].id, id);
    assert.equal(f.decodeCalls(), 1500, 'journal resolution does not re-decode clinical rows');
  } finally {
    f.close();
  }
});
test('196 bounded overlays preserve legacy counts/search/date/order/pages for updates, inserts, tombstones and reverts', () => {
  const f = logical196();
  try {
    verify(f);
    const ids = [...f.model.keys()],
      original = structuredClone(f.model.get(ids[0]));
    assert.ok(
      f.accept([
        {
          id: ids[0],
          summary: {
            ...original,
            name: 'Ааа Client',
            firstName: 'Ааа',
            lastName: 'Client',
            phone: '89990000001',
            lastVisit: { date: '2026-10-29', procedure: 'Synthetic196' },
            appointments: [
              {
                id: 'new196',
                date: '2026-10-31',
                time: '10:00',
                service: 'Synthetic196',
                duration: 30,
              },
            ],
          },
        },
      ]),
    );
    verify(f);
    const inserted = {
      ...structuredClone(original),
      id: 'generic196-новый',
      name: 'Ёж Client',
      firstName: 'Ёж',
      lastName: 'Client',
    };
    assert.ok(
      f.accept([
        { id: inserted.id, summary: inserted },
        { id: ids[1], summary: null },
      ]),
    );
    verify(f);
    assert.ok(
      f.accept([
        { id: ids[0], summary: original },
        { id: inserted.id, summary: null },
        {
          id: ids[1],
          summary: { ...structuredClone(original), id: ids[1], firstName: 'Z', name: 'Z' },
        },
      ]),
    );
    verify(f);
    assert.ok(f.accept([{ id: inserted.id, summary: inserted }]));
    verify(f);
  } finally {
    f.close();
  }
});
test('196 actual changed-row patch preserves warmed base selection without N-pointer copy or N-search', () => {
  const f = logical196({ count: 1500 }),
    originalIncludes = String.prototype.includes,
    originalMap = Array.prototype.map,
    texts = new Set([...f.model.values()].map(patientSearchText));
  let searched = 0,
    largeMaps = 0;
  try {
    f.render('q=Client&limit=60');
    String.prototype.includes = function (...args) {
      if (texts.has(String(this))) searched++;
      return originalIncludes.apply(this, args);
    };
    Array.prototype.map = function (...args) {
      if (this.length >= 1500) largeMaps++;
      return originalMap.apply(this, args);
    };
    const id = [...f.model.keys()][0];
    const changed = f.accept([{ id, summary: { ...f.model.get(id), phone: 'changed196' } }]);
    assert.ok(changed);
    const page = JSON.parse(f.render('q=Client&limit=60'));
    assert.equal(page.directory.length, 60);
    assert.equal(largeMaps, 0, 'no N-pointer map copies during patch/render');
    assert.equal(
      searched,
      2,
      'hint and final proof-bound render check changed-row eligibility; no N-search',
    );
    assert.equal(f.decodeCalls(), 1500);
    assert.ok(f.info(changed).charge >= f.info(f.bootstrapIndex).charge);
    assert.equal(f.cache.stats196().bootstraps, 1);
    assert.equal(f.cache.stats196().patches, 1);
  } finally {
    String.prototype.includes = originalIncludes;
    Array.prototype.map = originalMap;
    f.close();
  }
});
test('196 independently owned day/LRU state shares immutable columns, current JSON and selected HMAC are not stale', () => {
  const f = logical196();
  try {
    const id = [...f.model.keys()][0],
      summaryA = { ...f.model.get(id), phone: 'state-A' },
      indexA = f.accept([{ id, summary: summaryA }]),
      modelA = structuredClone(f.model),
      revisionA = f.revision();
    const firstA = JSON.parse(f.info(indexA).render(f.input('limit=1', revisionA)));
    const indexB = f.accept([{ id, summary: { ...summaryA, phone: 'state-B' } }]);
    assert.ok(indexB);
    for (let n = 0; n < 10; n++) {
      f.info(indexB).render(f.input('today=2020-01-01&q=v' + n, f.revision()));
      const actualA = JSON.parse(f.info(indexA).render(f.input('limit=100', revisionA)));
      assert.deepEqual(
        comparable(actualA, f.f.crypto),
        comparable(f.expected('limit=100', revisionA, modelA), f.f.crypto),
      );
    }
    const bodyB = JSON.parse(f.render('limit=100'));
    assert.equal(bodyB.directory.find((r) => r.id === id).phone, 'state-B');
    const peek = f.cache.peekForClaim196(f.f.claim, {
      url: f.input('limit=100').url,
      cursorCrypto: f.f.crypto,
      keyGeneration: f.keyGeneration,
    });
    assert.equal(peek.proofs.find((r) => r.id === id).fullHash, f.fullHashes.get(id));
    assert.throws(() => f.render('limit=1&cursor=' + encodeURIComponent(firstA.nextCursor)), {
      status: 409,
    });
  } finally {
    f.close();
  }
});
test('196 collation-equal generic IDs retain stable legacy rank across overlay update and delete/readd', () => {
  const f = logical196({ count: 1 });
  try {
    const id = [...f.model.keys()][0],
      original = structuredClone(f.model.get(id)),
      alias = id.toUpperCase();
    assert.ok(f.accept([{ id: alias, summary: { ...original, id: alias } }]));
    assert.ok(f.accept([{ id, summary: { ...original, phone: 'updated196' } }]));
    for (const sort of ['first', 'last']) {
      const query = 'sort=' + sort + '&limit=100';
      assert.deepEqual(
        JSON.parse(f.render(query)).directory.map((r) => r.id),
        f.expected(query).directory.map((r) => r.id),
      );
    }
    assert.ok(f.accept([{ id, summary: null }]));
    assert.ok(f.accept([{ id, summary: original }]));
    for (const sort of ['first', 'last']) {
      const query = 'sort=' + sort + '&limit=100';
      assert.deepEqual(
        JSON.parse(f.render(query)).directory.map((r) => r.id),
        f.expected(query).directory.map((r) => r.id),
      );
    }
  } finally {
    f.close();
  }
});
test('196 final selection is bound in one render across midnight, query mutation and proof hash/order/count changes', () => {
  const f = logical196(),
    RealDate = global.Date;
  let now = RealDate.UTC(2026, 10, 1, 20, 59, 59, 500);
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
  try {
    const input = f.input('filter=appointment&limit=100');
    input.url.searchParams.delete('today');
    const hint = f.cache.peekForClaim196(f.f.claim, { url: input.url });
    assert.ok(hint.proofs.length > 0);
    const ticket = { token: hint.token, head: hint.head, keyGeneration: f.keyGeneration };
    now += 1000;
    assert.equal(
      f.cache.render196(f.f.key, ticket, { ...input, expectedSelected196: hint.proofs }),
      null,
      'new-day selected rows were not in the SQL-proved old selection',
    );
    assert.equal(
      renderDirectorySnapshotProven196(f.bootstrapIndex, input, hint.proofs),
      null,
      'RR final helper has the same bound',
    );
    const fresh = f.cache.peekForClaim196(f.f.claim, { url: input.url });
    assert.equal(fresh.proofs.length, 0);
    assert.deepEqual(
      JSON.parse(
        f.cache.render196(f.f.key, ticket, { ...input, expectedSelected196: fresh.proofs }),
      ).directory,
      [],
    );
    input.url.searchParams.set('today', '2026-11-01');
    const explicit = f.cache.peekForClaim196(f.f.claim, { url: input.url });
    now += 86400000;
    assert.ok(
      f.cache.render196(f.f.key, ticket, { ...input, expectedSelected196: explicit.proofs }),
    );
    const wrongHash = explicit.proofs.map((row, i) =>
      i ? row : { ...row, fullHash: '0'.repeat(64) },
    );
    for (const expected of [
      wrongHash,
      [...explicit.proofs].reverse(),
      [],
      [...explicit.proofs, explicit.proofs[0]],
    ])
      assert.equal(renderDirectorySnapshotProven196(f.bootstrapIndex, input, expected), null);
    input.url.searchParams.set('q', 'no-match-196');
    assert.equal(renderDirectorySnapshotProven196(f.bootstrapIndex, input, explicit.proofs), null);
  } finally {
    global.Date = RealDate;
    f.close();
  }
});
