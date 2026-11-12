const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  ownedBytes,
  retainValueBytes,
  readValueBytes,
} = require('../src/server/infrastructure/retained-value-bytes138.cjs');
const { createReadCacheBudget } = require('../src/server/infrastructure/read-cache-budget.cjs');
const { createServiceReadCache } = require('../src/server/infrastructure/service-read-cache.cjs');
const {
  createCalendarProjection,
} = require('../src/server/infrastructure/calendar-projection.cjs');
const { cachedRows, directoryPage } = require('../src/server/modules/cabinet/directory.cjs');
const {
  correlatedClientMatches,
} = require('../src/server/modules/assistant/language/names/name-correlated-directory.cjs');

function directoryFixture(maxBytes = 1024 * 1024, count = 80) {
  const owner = { organizationId: randomUUID(), accountId: 'owner', role: 'owner' };
  const budget = createReadCacheBudget({ maxBytes });
  let revision = 1,
    decodes = 0,
    reads = 0;
  const rows = Array.from({ length: count }, (_, n) => ({
    id: 'p' + String(n).padStart(3, '0'),
    name: 'Имя' + n + ' Фамилия' + (count - n),
    phone: '+7918000' + String(n).padStart(4, '0'),
    designation: n === 5 ? 'тренер' : '',
    createdBy: n % 2 ? 'staff-a' : 'staff-b',
    visitCount: 0,
    lastVisit: null,
    appointments: n % 3 ? [] : [{ id: 'a' + n, date: '2030-01-01', time: '10:00' }],
  }));
  const storage = {
    filename: '/synthetic/' + randomUUID() + '/cabinet.sqlite',
    readCacheBudget: budget,
    encode: (value) => Buffer.from(JSON.stringify(value)),
    decode: (value) => {
      decodes++;
      return JSON.parse(Buffer.from(value));
    },
    get: () => revision,
    readOnlySnapshot: (callback) => callback(),
    indexes: {
      summaryRows(current) {
        reads++;
        return rows
          .filter((row) => current.role !== 'cosmetologist' || row.createdBy === current.accountId)
          .map((row) => ({ patient_id: row.id, value: Buffer.from(JSON.stringify(row)) }));
      },
    },
  };
  const page = (values = {}, user = owner) =>
    directoryPage(
      storage,
      user,
      new URL(
        'http://synthetic/?' + new URLSearchParams({ today: '2030-01-01', limit: 20, ...values }),
      ),
    );
  return {
    rows,
    owner,
    storage,
    budget,
    page,
    stats: () => ({ reads, decodes }),
    advance() {
      revision++;
    },
  };
}

test('retained values own unpooled bytes and never share returned object graphs', () => {
  const source = Buffer.from('owned'),
    bytes = ownedBytes(source);
  assert.equal(bytes.buffer.byteLength, bytes.byteLength);
  source.fill(0);
  assert.equal(bytes.toString(), 'owned');
  const value = {
    items: [{ name: 'исходное', flags: [true] }],
    missing: undefined,
    data: Buffer.from('x'),
  };
  const encoded = retainValueBytes(value);
  value.items[0].name = 'changed';
  const a = readValueBytes(encoded);
  a.items[0].flags[0] = false;
  a.data[0] = 0;
  const b = readValueBytes(encoded);
  assert.equal(b.items[0].name, 'исходное');
  assert.equal(b.items[0].flags[0], true);
  assert.equal(b.data.toString(), 'x');
  assert.ok(Object.hasOwn(b, 'missing'));
});

test('service cache rechecks SQL ciphertext, returns fresh values and drops deleted/owned entries', () => {
  const budget = createReadCacheBudget({ maxBytes: 8192 }),
    owner = {};
  let rows = [
      { id: 's', value: Buffer.from(JSON.stringify({ name: 'one', config: { price: 10 } })) },
    ],
    reads = 0,
    decodes = 0;
  const cache = createServiceReadCache({
    db: {
      prepare() {
        return {
          all() {
            reads++;
            return rows;
          },
        };
      },
    },
    decode(bytes) {
      assert.ok(Buffer.isBuffer(bytes));
      decodes++;
      return JSON.parse(bytes);
    },
    budget,
    owner,
  });
  const a = cache.read();
  a[0].config.price = 99;
  assert.equal(cache.read()[0].config.price, 10);
  assert.equal(decodes, 1);
  assert.equal(reads, 2);
  rows[0].value = Buffer.from(JSON.stringify({ name: 'two', config: { price: 20 } }));
  assert.equal(cache.read()[0].config.price, 20);
  assert.equal(decodes, 2);
  budget.releaseOwner(owner);
  assert.equal(budget.stats().bytes, 0);
  cache.read();
  assert.equal(decodes, 3);
  rows = [];
  assert.deepEqual(cache.read(), []);
  assert.equal(budget.stats().bytes, 0);
});

test('calendar bytes preserve revision/range/audience invalidation and frozen fresh results', () => {
  const owner = {},
    budget = createReadCacheBudget({ maxBytes: 8192 });
  let calls = 0;
  const projection = createCalendarProjection({
    budget,
    owner,
    indexes: {
      appointments(from, to, options) {
        calls++;
        return [
          { date: '2030-01-02', staffId: options.staffId || 'a', roomId: 'r' },
          { date: '2029-12-31', staffId: 'a' },
        ];
      },
    },
  });
  const a = projection(1, '2030-01-01', '2030-01-31'),
    b = projection(1, '2030-01-01', '2030-01-31');
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.ok(Object.isFrozen(b) && Object.isFrozen(b[0]));
  assert.equal(calls, 1);
  assert.equal(projection(2, '2030-01-01', '2030-01-31', 'b')[0].staffId, 'b');
  assert.equal(calls, 2);
  budget.releaseOwner(owner);
  projection(2, '2030-01-01', '2030-01-31', 'b');
  assert.equal(calls, 3);
});

test('directory hits retain bytes and index views while returned rows/counts stay private', () => {
  const f = directoryFixture();
  const first = f.page();
  const charged = f.budget.stats().bytes;
  first.directory[0].name = 'mutated';
  first.directory[0].appointments.push({ id: 'injected' });
  first.counts.all = -1;
  const second = f.page();
  assert.equal(second.total, 80);
  assert.equal(second.counts.all, 80);
  assert.ok(
    second.directory.every(
      (row) => row.name !== 'mutated' && row.appointments.every((a) => a.id !== 'injected'),
    ),
  );
  assert.equal(f.stats().decodes, 80);
  assert.equal(f.stats().reads, 1);
  f.page({ q: 'тренер', sort: 'last' });
  assert.ok(f.budget.stats().bytes > charged, 'derived search/sort indices are charged');
  assert.ok(f.budget.stats().bytes <= f.budget.stats().maxBytes);
  const all = cachedRows(f.storage, f.owner);
  all.rows[0].name = 'other mutation';
  assert.notEqual(cachedRows(f.storage, f.owner).rows[0].name, 'other mutation');
  f.budget.releaseOwner(f.storage.encode);
  assert.equal(f.budget.stats().bytes, 0);
});

test('directory revision/ciphertext/reopen/staff checks preserve fresh scope without decrypting unchanged rows', () => {
  const f = directoryFixture();
  f.page();
  f.rows[5].designation = 'новая отметка';
  f.advance();
  assert.equal(f.page({ q: 'новая отметка' }).matched, 1);
  assert.equal(f.stats().decodes, 81);
  const staff = { ...f.owner, accountId: 'staff-b', role: 'cosmetologist' };
  assert.equal(f.page({}, staff).total, 40);
  assert.equal(f.page({ q: 'новая отметка' }, staff).matched, 0);
  const initial = f.page();
  assert.ok(initial.nextCursor);
  assert.throws(
    () => f.page({ cursor: initial.nextCursor }, { ...f.owner, accountId: 'another' }),
    (error) => error.status === 400,
  );
  f.storage.encode = (value) => Buffer.from(JSON.stringify(value));
  const before = f.stats().decodes;
  f.page();
  assert.equal(f.stats().decodes, before + 80, 'reopened key identity forces fresh decode');
});

test('derived cache pressure never resurrects evicted base; day counts remain attached to their view', () => {
  const f = directoryFixture(13000, 25);
  for (let n = 0; n < 30; n++)
    f.page({
      q: String(n),
      sort: n % 2 ? 'first' : 'last',
      today: n % 2 ? '2030-01-01' : '2030-01-02',
    });
  assert.ok(f.budget.stats().bytes <= 13000);
  const jan1 = f.page({ filter: 'appointment', today: '2030-01-01' });
  const jan2 = f.page({ filter: 'appointment', today: '2030-01-02' });
  assert.equal(jan1.matched, 9);
  assert.equal(jan2.matched, 0);
  assert.equal(f.page({ filter: 'appointment', today: '2030-01-01' }).counts.appointment, 9);
  f.budget.releaseOwner(f.storage.encode);
  assert.equal(f.budget.stats().bytes, 0);
  assert.equal(f.page().total, 25);
  assert.ok(f.budget.stats().bytes <= 13000);
});

test('fresh directory wrappers preserve key identity for guarded assistant name correlation', () => {
  const f = directoryFixture(1024 * 1024, 2);
  f.rows[0].name = 'Анна Иванова';
  const current = { ...f.owner, sessionId: 'synthetic-session' };
  const c = { current, assertCurrent() {}, tenantStore: () => f.storage };
  const cold = cachedRows(f.storage, current);
  const warm = cachedRows(f.storage, current);
  assert.equal(cold.encode, f.storage.encode);
  assert.equal(warm.encode, f.storage.encode);
  assert.equal(cold.revision, 1);
  assert.notEqual(cold, warm);
  assert.notEqual(cold.rows, warm.rows);
  assert.equal(correlatedClientMatches(c, 'Анна Иванова').matches[0].id, f.rows[0].id);
  assert.equal(correlatedClientMatches(c, 'Анна Иванова').matches[0].id, f.rows[0].id);
  f.storage.encode = (value) => Buffer.from(JSON.stringify(value));
  assert.equal(cachedRows(f.storage, current).encode, f.storage.encode);
  assert.equal(correlatedClientMatches(c, 'Анна Иванова').matches[0].id, f.rows[0].id);
  f.budget.releaseOwner(f.storage.encode);
});
