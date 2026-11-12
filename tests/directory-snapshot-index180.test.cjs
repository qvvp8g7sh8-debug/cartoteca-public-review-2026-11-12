const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, summaries, current } = require('./helpers/directory-snapshot180-fixture.cjs');
const {
  createDirectorySnapshotIndex180,
  directorySnapshotIndexInfo180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-index180.cjs');
const {
  snapshotRequest180,
  directorySnapshotKey180,
} = require('../src/server/infrastructure/postgres/directory-snapshot-key180.cjs');
function normalized(value, crypto) {
  return {
    ...value,
    nextCursor: value.nextCursor ? crypto.decode(Buffer.from(value.nextCursor, 'base64url')) : null,
  };
}
test('180 private index matches existing locale/phone/AND/date/duplicate-param page semantics', () => {
  const f = fixture();
  try {
    for (const q of [
      '',
      'ЁЖ',
      '8 (999) 000-00-01',
      'Legacy Client',
      'İ',
      'Synthetic  Client',
      '$&',
    ])
      for (const sort of ['first', 'last'])
        for (const filter of ['all', 'recent', 'inactive', 'appointment']) {
          const url = f.url(
            'q=' + encodeURIComponent(q) + '&sort=' + sort + '&filter=' + filter + '&limit=2',
          );
          const result = JSON.parse(f.render(url));
          assert.deepEqual(
            normalized(result, f.crypto),
            normalized(f.legacy(url), f.crypto),
            `${q}/${sort}/${filter}`,
          );
          if (result.nextCursor) {
            url.searchParams.set('cursor', result.nextCursor);
            assert.deepEqual(
              normalized(JSON.parse(f.render(url)), f.crypto),
              normalized(f.legacy(url), f.crypto),
            );
          }
        }
    const duplicate = f.url('q=Legacy&q=wrong&sort=last&sort=first&limit=1&unknown=opaque');
    assert.deepEqual(
      normalized(JSON.parse(f.render(duplicate)), f.crypto),
      normalized(f.legacy(duplicate), f.crypto),
    );
    const implicit = f.url('q=Client');
    implicit.searchParams.delete('today');
    assert.deepEqual(
      normalized(JSON.parse(f.render(implicit)), f.crypto),
      normalized(f.legacy(implicit), f.crypto),
    );
  } finally {
    f.close();
  }
});
test('180 private JSON rendering neither borrows caller objects nor parses cached full summaries', () => {
  const f = fixture();
  try {
    const url = f.url('limit=100'),
      expected = f.render(url);
    f.rows[0].name = 'Caller mutation';
    f.rows[0].appointments[0].date = '2099-01-01';
    const parse = JSON.parse;
    JSON.parse = () => {
      throw Error('Cached clinical summaries must not be parsed');
    };
    try {
      assert.equal(f.render(url), expected);
    } finally {
      JSON.parse = parse;
    }
    const copy = JSON.parse(expected);
    copy.directory[0].name = 'Response mutation';
    assert.equal(f.render(url), expected);
    assert.match(expected, /\$&/);
    assert.deepEqual(Object.keys(f.snapshot), []);
  } finally {
    f.close();
  }
});
test('180 cursor errors/revision binding and parameter errors preserve ordinary directory contract', () => {
  const f = fixture();
  try {
    const first = JSON.parse(f.render(f.url('q=Client&limit=1')));
    assert.ok(first.nextCursor);
    const bad = f.url('q=Different&limit=1&cursor=' + encodeURIComponent(first.nextCursor));
    assert.throws(() => f.render(bad), { status: 400 });
    const decoded = f.crypto.decode(Buffer.from(first.nextCursor, 'base64url'));
    decoded.revision--;
    const stale = f.url(
      'q=Client&limit=1&cursor=' + f.crypto.encode(decoded).toString('base64url'),
    );
    assert.throws(() => f.render(stale), { status: 409 });
    for (const query of [
      'sort=bad',
      'filter=bad',
      'limit=101',
      'today=2026-02-29',
      'q=' + 'İ'.repeat(160),
    ]) {
      const url = f.url(query);
      if (query.startsWith('today=')) url.searchParams.set('today', '2026-02-29');
      assert.throws(() => f.render(url), { status: 400 });
      assert.throws(() => f.legacy(url), { status: 400 });
    }
    assert.equal(snapshotRequest180(f.url('picker=1')), false);
    assert.notEqual(
      directorySnapshotKey180({ epoch: 'e', storeId: 's', current }),
      directorySnapshotKey180({
        epoch: 'e',
        storeId: 's',
        current: { ...current, sessionId: 'new-session' },
      }),
    );
  } finally {
    f.close();
  }
});
test('180 snapshot declines noncanonical statuses, accessors and oversized responses', () => {
  for (const status of ['cancelled', 'rescheduled', 'no_show']) {
    const rows = summaries();
    rows[0].appointments[0].status = status;
    assert.equal(createDirectorySnapshotIndex180(rows, { revision: 1, timeZone: 'UTC' }), null);
  }
  const scheduled = summaries();
  scheduled[0].appointments[0].status = 'scheduled';
  assert.ok(createDirectorySnapshotIndex180(scheduled, { revision: 1, timeZone: 'UTC' }));
  const accessor = summaries();
  Object.defineProperty(accessor[0], 'name', {
    get() {
      throw Error('getter');
    },
  });
  assert.equal(createDirectorySnapshotIndex180(accessor, { revision: 1, timeZone: 'UTC' }), null);
  const f = fixture(),
    large = summaries().map((row) => ({
      ...row,
      name: 'x'.repeat(4096),
      designation: 'd'.repeat(4096),
      phone: 'p'.repeat(4096),
    }));
  try {
    const index = createDirectorySnapshotIndex180(large, { revision: 1, timeZone: 'UTC' });
    assert.ok(index);
    const info = directorySnapshotIndexInfo180(index);
    assert.ok(info.charge > info.jsonBytes);
    assert.equal(info.render({ current, url: f.url('limit=100'), cursorCrypto: f.crypto }), null);
  } finally {
    f.close();
  }
});
