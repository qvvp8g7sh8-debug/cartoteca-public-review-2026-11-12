const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const {
  READY_KEY,
  projectionKey,
  compact,
  encodeProjection,
  createDirectoryProjectionWriter164,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');
const { directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const encode = (value) => Buffer.from(JSON.stringify(value));
const decode = (value) => JSON.parse(Buffer.from(value).toString());
const hash = (value) =>
  createHmac('sha256', 'synthetic-directory164-key').update(value).digest('hex');
function summary(id, extra = {}) {
  return {
    id,
    name: 'Анна Иванова',
    firstName: 'Анна',
    lastName: 'Иванова',
    middleName: 'Сергеевна',
    phone: '+7 (900) 123-45-67',
    designation: 'Тест',
    visitCount: 9,
    lastVisit: { date: '2035-01-01', procedure: 'PRIVATE procedure' },
    appointments: [
      {
        id: 'private-a',
        date: '2035-01-12',
        time: '11:00',
        service: 'PRIVATE appointment',
        duration: 90,
      },
      { date: '2035-01-12' },
      { date: '2034-12-25' },
    ],
    notes: 'PRIVATE profile',
    ...extra,
  };
}
test('164 compact directory payload retains exact search/order/filter results without appointment payload', () => {
  const rows = [
    summary('one'),
    summary('two', {
      firstName: 'Юлия',
      lastName: 'Яковлева',
      designation: 'Phone',
      phone: '89009876543',
      lastVisit: null,
      appointments: [{ date: '2030-01-01' }],
    }),
    summary('three', {
      firstName: '',
      lastName: '',
      middleName: '',
      name: '',
      phone: '+374 99 123456',
      appointments: [],
    }),
  ];
  const light = rows.map(compact);
  assert.doesNotMatch(
    JSON.stringify(light),
    /PRIVATE|private-a|11:00|duration|service|procedure|notes/,
  );
  const current = { accountId: 'owner', organizationId: 'org', role: 'owner' };
  const storage = (tag) => ({
    directory: tag,
    filename: tag,
    encode,
    decode,
    readCacheVersion: tag,
    readOnlySnapshot: (fn) => fn(),
  });
  const fullStorage = storage('directory164-full'),
    lightStorage = storage('directory164-light');
  for (const q of [
    '',
    'яков',
    'Сергеевна Анна',
    '900123',
    '+7 (900) 123-45-67',
    '89001234567',
    'phone',
    '123456',
  ])
    for (const filter of ['all', 'recent', 'inactive', 'appointment'])
      for (const sort of ['first', 'last']) {
        const url = new URL(
          'http://test/?' +
            new URLSearchParams({ q, filter, sort, today: '2035-01-10', limit: '100' }),
        );
        const full = directoryPage(fullStorage, current, url, { revision: 1, directory: rows });
        const actual = directoryPage(lightStorage, current, url, { revision: 1, directory: light });
        assert.deepEqual(
          {
            ids: actual.directory.map((p) => p.id),
            counts: actual.counts,
            total: actual.total,
            matched: actual.matched,
          },
          {
            ids: full.directory.map((p) => p.id),
            counts: full.counts,
            total: full.total,
            matched: full.matched,
          },
        );
      }
  const large = summary('large', {
    appointments: Array.from({ length: 2500 }, (_, i) => ({
      id: 'private-' + i,
      date: '2035-01-12',
      service: 'PRIVATE'.repeat(100),
    })),
  });
  assert.equal(compact(large).appointments.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(compact(large))) < 512);
});
test('164 sidecars are bound to the exact source cipher and only explicit store readiness enables writes', () => {
  const writes = [],
    state = new Map();
  const prepare = (sql) => ({
    get: (key) => (state.has(key) ? { value: state.get(key) } : undefined),
    run: (...args) => {
      writes.push({ sql, args });
      state.set(args[0], args[1]);
    },
  });
  const create = () => createDirectoryProjectionWriter164({ prepare, encode, decode, hash });
  const source = summary('patient'),
    cipher = Buffer.from('synthetic encrypted summary');
  const unprepared = create();
  assert.equal(unprepared.ready, false);
  unprepared.write(source, '*', cipher);
  assert.equal(writes.length, 0);
  state.set(READY_KEY, encode({ version: 1 }));
  const prepared = create();
  assert.equal(prepared.ready, true);
  prepared.write(source, '*', cipher);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[0], projectionKey(source.id, '*'));
  const projection = decode(writes[0].args[1]);
  assert.equal(projection.sourceHash, hash(cipher));
  assert.equal(projection.id, source.id);
  assert.equal(projection.audience, '*');
  assert.deepEqual(projection.row, compact(source));
  assert.notEqual(projectionKey(source.id, '*'), projectionKey(source.id, 'staff'));
  assert.notEqual(
    decode(encodeProjection(source, '*', Buffer.from('different'), { encode, hash })).sourceHash,
    projection.sourceHash,
  );
  state.set(READY_KEY, encode({ version: 2 }));
  assert.throws(create, { status: 503 });
  unprepared.write(source, '*', cipher);
  assert.equal(writes.length, 1, 'an earlier unprepared connection never silently activates');
});

test('164 read-only operation adapters do not look up a writer marker or perform SQL during index construction', () => {
  const { createCabinetIndexes } = require('../src/server/infrastructure/cabinet-indexes.cjs');
  let calls = 0;
  const indexes = createCabinetIndexes({
    db: { dialect: 'postgres', transactionIntent: 'READONLY' },
    schemaVersion: 2,
    encode,
    decode,
    hash,
    prepare() {
      calls++;
      throw Error('Read-only projection attempted an unprefetched writer marker');
    },
  });
  assert.equal(calls, 0);
  assert.equal(indexes.directoryProjection164.ready, false);
});
