const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, current } = require('./helpers/directory-snapshot180-fixture.cjs');
const { incremental185 } = require('./helpers/directory-incremental185-fixture.cjs');
const { patientSearchText } = require('../src/shared/patient-names.cjs');
const {
  createDirectorySnapshotIndex180,
  directorySnapshotIndexInfo180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');

function comparable(value, crypto) {
  return {
    ...value,
    nextCursor: value.nextCursor ? crypto.decode(Buffer.from(value.nextCursor, 'base64url')) : null,
  };
}
function observeSearch(rows) {
  const texts = new Set(rows.map(patientSearchText)),
    original = String.prototype.includes;
  let comparisons = 0;
  String.prototype.includes = function (...args) {
    if (texts.has(String(this))) comparisons++;
    return original.apply(this, args);
  };
  return {
    count: () => comparisons,
    reset() {
      comparisons = 0;
    },
    close() {
      String.prototype.includes = original;
    },
  };
}
function check(f, url, rendered = f.render(url)) {
  assert.deepEqual(comparable(JSON.parse(rendered), f.crypto), comparable(f.legacy(url), f.crypto));
}
test('192 compiled views preserve all counts, locale/phone AND search, dates and every page', () => {
  const f = fixture();
  try {
    for (const today of ['2026-10-01', '2026-10-30', '2026-11-01', '2027-02-01'])
      for (const q of ['', 'Client', 'Synthetic Client', '8 (999) 000-00-01', 'Ёж', 'İ'])
        for (const sort of ['first', 'last'])
          for (const filter of ['all', 'appointment', 'recent', 'inactive']) {
            const url = f.url(
              'q=' + encodeURIComponent(q) + '&sort=' + sort + '&filter=' + filter + '&limit=1',
            );
            url.searchParams.set('today', today);
            let rendered;
            do {
              rendered = f.render(url);
              check(f, url, rendered);
              const cursor = JSON.parse(rendered).nextCursor;
              if (!cursor) break;
              url.searchParams.set('cursor', cursor);
            } while (true);
          }
  } finally {
    f.close();
  }
});
test('192 repeated selection and cursor pages perform no full-row search; empty views stop at64', () => {
  const f = fixture(),
    watch = observeSearch(f.rows);
  try {
    const first = JSON.parse(f.render(f.url('q=Client&limit=1')));
    assert.equal(watch.count(), f.rows.length);
    watch.reset();
    const next = f.url('q=Client&limit=1&cursor=' + encodeURIComponent(first.nextCursor));
    f.render(next);
    f.render(f.url('q=Client&limit=100'));
    assert.equal(watch.count(), 0, 'limit/offset do not re-scan or duplicate a selection');
    for (let n = 0; n < 63; n++) f.render(f.url('q=v' + n));
    watch.reset();
    f.render(f.url('q=Client'));
    assert.equal(watch.count(), 0);
    f.render(f.url('q=v63'));
    watch.reset();
    f.render(f.url('q=Client'));
    assert.equal(watch.count(), 0, 'recently touched view survives capacity eviction');
    f.render(f.url('q=v0'));
    assert.equal(
      watch.count(),
      f.rows.length,
      '65th distinct view evicted the oldest metadata record',
    );
    watch.reset();
    const historical = f.url('q=Client');
    historical.searchParams.set('today', '2020-01-01');
    f.render(historical);
    assert.equal(watch.count(), f.rows.length, 'explicit day replacement invalidates selections');
    watch.close();
    check(f, historical);
  } finally {
    watch.close();
    f.close();
  }
});
test('192 derived storage is fully prepaid, isolated per index, and cannot bypass cursor scope', () => {
  const f = fixture(),
    info = directorySnapshotIndexInfo180(f.snapshot),
    charge = info.charge,
    watch = observeSearch(f.rows);
  try {
    const result = JSON.parse(f.render(f.url('q=Client&limit=1')));
    assert.throws(() => f.render(f.url('q=Client&limit=2&cursor=' + result.nextCursor)), {
      status: 400,
    });
    assert.throws(
      () =>
        f.render(f.url('q=Client&limit=1&cursor=' + result.nextCursor), {
          ...current,
          accountId: 'another-account',
        }),
      { status: 400 },
    );
    const second = createDirectorySnapshotIndex180(f.rows, {
      revision: f.revision,
      timeZone: f.timeZone,
    });
    watch.reset();
    directorySnapshotIndexInfo180(second).render({
      current,
      url: f.url('q=Client'),
      cursorCrypto: f.crypto,
    });
    assert.equal(watch.count(), f.rows.length, 'independent index has no borrowed selections');
    for (let n = 0; n < 40; n++) f.render(f.url('q=' + n + 'x'.repeat(150)));
    assert.equal(directorySnapshotIndexInfo180(f.snapshot).charge, charge);
    assert.ok(charge > info.jsonBytes + 8 * f.rows.length * 4 + 8 * 1024);
  } finally {
    watch.close();
    f.close();
  }
});
test('192 already-proved incremental rebuild preserves derived results across notes and reordered SQL rows', async () => {
  const b = incremental185();
  let watch;
  try {
    assert.equal((await b.read('q=Client&limit=100')).status, 200);
    b.commit();
    const oldRender = b.info().render,
      id = b.f.rows[0].id,
      oldCursor = JSON.parse(
        oldRender({ current, url: b.f.url('q=Client&limit=1'), cursorCrypto: b.f.crypto }),
      ).nextCursor;
    b.change(id, { visitCount: 17 });
    b.afterSQL((rows) => rows.reverse());
    watch = observeSearch(b.f.rows);
    const reply = await b.read('q=Client&limit=100');
    assert.equal(reply.status, 200);
    assert.equal(b.counts.full, b.records.size + 1, 'current changed full summary is decoded');
    assert.equal(
      watch.count(),
      0,
      'fresh hashes allow derivation reuse despite SQL row permutation',
    );
    b.commit();
    watch.close();
    assert.deepEqual(reply.body, b.expected('q=Client&limit=100'));
    assert.throws(
      () =>
        b.info().render({
          current,
          url: b.f.url('q=Client&limit=1&cursor=' + encodeURIComponent(oldCursor)),
          cursorCrypto: b.f.crypto,
        }),
      { status: 409 },
    );
    const historical = b.f.url('q=Client');
    historical.searchParams.set('today', '2020-01-01');
    oldRender({ current, url: historical, cursorCrypto: b.f.crypto });
    watch = observeSearch(b.f.rows);
    b.info().render({ current, url: b.f.url('q=Client&limit=100'), cursorCrypto: b.f.crypto });
    assert.equal(watch.count(), 0, 'prior renderer day/LRU mutations cannot alter new renderer');
    watch.close();
    const all = JSON.parse(
      b.info().render({
        current,
        url: b.f.url('limit=100'),
        cursorCrypto: b.f.crypto,
      }),
    );
    assert.equal(all.directory.find((row) => row.id === id).visitCount, 17);
    const oldPage = JSON.parse(
      oldRender({
        current,
        url: b.f.url('limit=100'),
        cursorCrypto: b.f.crypto,
      }),
    );
    assert.equal(
      oldPage.directory.find((row) => row.id === id).visitCount,
      0,
      'old immutable graph unchanged',
    );
  } finally {
    watch?.close();
    b.close();
  }
});
test('192 changed search/date/sort/membership inputs invalidate prior derived selections', async () => {
  for (const kind of ['phone', 'name', 'date', 'remove', 'add']) {
    const b = incremental185();
    let watch;
    try {
      await b.read('q=Client&limit=100');
      b.commit();
      const id = b.f.rows[0].id;
      if (kind === 'phone') b.change(id, { phone: '+79991920000' });
      if (kind === 'name') b.change(id, { firstName: 'Client', lastName: 'Changed' });
      if (kind === 'date')
        b.change(id, { lastVisit: { date: '2026-10-30', procedure: 'Synthetic' } });
      if (kind === 'remove') b.remove(id);
      if (kind === 'add')
        b.add({ ...b.f.rows[0], id: 'new192', name: 'Client New', firstName: 'Client' });
      watch = observeSearch(b.f.rows);
      const reply = await b.read('q=Client&limit=100');
      assert.equal(reply.status, 200);
      assert.ok(watch.count() > 0, kind + ' must re-evaluate selection');
      b.commit();
      watch.close();
      assert.deepEqual(reply.body, b.expected('q=Client&limit=100'));
    } finally {
      watch?.close();
      b.close();
    }
  }
});
test('192 compact rare results retain30 queries within8N positions; date masks are built once', () => {
  const f = fixture(),
    rows = Array.from({ length: 1500 }, (_, n) => ({
      id: 'synthetic192-' + n,
      firstName: 'Synthetic',
      lastName: 'Client ' + String(n).padStart(4, '0'),
      visitCount: 0,
      lastVisit: null,
      appointments: [],
    })),
    index = createDirectorySnapshotIndex180(rows, { revision: 1, timeZone: 'UTC' }),
    info = directorySnapshotIndexInfo180(index),
    watch = observeSearch(rows),
    parse = Date.parse;
  let parses = 0;
  Date.parse = function (...args) {
    parses++;
    return parse.apply(this, args);
  };
  const render = (q) =>
    info.render({ current, url: f.url('q=' + encodeURIComponent(q)), cursorCrypto: f.crypto });
  try {
    for (let n = 0; n < 30; n++) {
      const page = JSON.parse(render('Client ' + String(n).padStart(4, '0')));
      assert.equal(page.matched, 1);
      assert.equal(page.directory[0].id, 'synthetic192-' + n);
    }
    assert.equal(
      parses,
      32,
      'one parameter date validation per query, only two day-boundary computations',
    );
    watch.reset();
    for (let n = 0; n < 30; n++) render('Client ' + String(n).padStart(4, '0'));
    assert.equal(watch.count(), 0, '30 narrow queries keep compact matched-only buffers');
    assert.equal(parses, 62);
  } finally {
    Date.parse = parse;
    watch.close();
    f.close();
  }
});
test('192 broad result retention is limited to8N positions regardless of64 metadata slots', () => {
  const f = fixture(),
    rows = f.rows.map((row, n) => ({
      ...row,
      firstName: Array.from({ length: 10 }, (_, i) => 'b' + i).join(' '),
      lastName: 'Synthetic ' + n,
    })),
    index = createDirectorySnapshotIndex180(rows, { revision: 1, timeZone: 'UTC' }),
    info = directorySnapshotIndexInfo180(index),
    watch = observeSearch(rows);
  const render = (q) => info.render({ current, url: f.url('q=' + q), cursorCrypto: f.crypto });
  try {
    for (let n = 0; n < 8; n++) assert.equal(JSON.parse(render('b' + n)).matched, rows.length);
    watch.reset();
    render('b0');
    assert.equal(watch.count(), 0);
    render('b8');
    watch.reset();
    render('b0');
    assert.equal(watch.count(), 0, 'recently touched broad view survives byte eviction');
    render('b1');
    assert.equal(
      watch.count(),
      rows.length,
      'ninth full result evicts oldest even below64 entries',
    );
  } finally {
    watch.close();
    f.close();
  }
});
