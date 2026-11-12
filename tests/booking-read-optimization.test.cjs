const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { createServiceReadCache } = require('../src/server/infrastructure/service-read-cache.cjs');
const { createBookingPublicLimits } = require('../src/server/modules/booking/public-limits.cjs');
const { publicInfo, publicDates, publicAvailability, publicSubmit } = require('../src/server/modules/booking/public-service.cjs');
const { dateInZone } = require('../src/server/modules/booking/schedule-state.cjs');

test('service cache checks current ciphertext, clones drafts, prunes deletes and bounds retention', () => {
  let rows = [{ id: 's', value: Buffer.from(JSON.stringify({ id: 's', name: 'Synthetic', nested: ['safe'] })) }];
  let reads = 0, decodes = 0;
  const reader = createServiceReadCache({ db: { prepare: () => ({ all: () => { reads++; return rows; } }) },
    decode: value => { decodes++; return JSON.parse(value); }, maxEntries: 1 });
  const first = reader.read(); first[0].nested[0] = 'draft';
  assert.equal(reader.read()[0].nested[0], 'safe'); assert.equal(decodes, 1); assert.equal(reads, 2);
  rows[0].value = Buffer.from(JSON.stringify({ id: 's', name: 'Changed' }));
  assert.equal(reader.read()[0].name, 'Changed'); assert.equal(decodes, 2);
  rows = []; assert.deepEqual(reader.read(), []);
  rows = [{ id: 's', value: Buffer.from(JSON.stringify({ id: 's', name: 'Changed' })) }];
  reader.read(); assert.equal(decodes, 3);
  reader.clear(); reader.read(); assert.equal(decodes, 4);
  rows.push({ id: 'second', value: Buffer.from(JSON.stringify({ id: 'second', name: 'Another service' })) });
  reader.read(); const before = decodes;
  assert.equal(reader.read().length, 2); assert.equal(decodes - before, 2);
  rows = rows.slice(0, 1);
  const bounded = createServiceReadCache({ db: { prepare: () => ({ all: () => rows }) },
    decode: value => { decodes++; return JSON.parse(value); }, maxBytes: 1 });
  const withoutCache = decodes;
  bounded.read(); bounded.read(); assert.equal(decodes - withoutCache, 2);
});

test('catalog cache observes another connection and never shares its mutable result', async t => {
  const f = await bookingFixture();
  const shadow = createStorage(f.storage.directory);
  t.after(() => { shadow.close(); f.close(); });
  const draft = f.storage.readServices(); draft[0].name = 'Unsaved draft';
  assert.equal(f.storage.readServices()[0].name, 'Тестовая услуга');
  const state = shadow.read(); state.services[0].name = 'Updated from another connection';
  shadow.write(state);
  assert.equal(f.storage.readServices()[0].name, 'Updated from another connection');
  const deleted = shadow.read(); deleted.services = []; shadow.write(deleted);
  assert.deepEqual(f.storage.readServices(), []);
});

test('public reads reuse one provider snapshot, keep tokens private and leave writer admission intact', async t => {
  const f = await bookingFixture(); t.after(f.close); f.setMode('classic');
  let writers = 0, snapshots = 0;
  const write = f.platform.withWriteLock, snapshot = f.platform.onlineBooking.providerSnapshot;
  f.platform.withWriteLock = callback => { writers++; return write(callback); };
  f.platform.onlineBooking.providerSnapshot = org => { snapshots++; return snapshot(org); };
  const phases = [];
  f.context.recordTiming = (name, elapsed) => { phases.push(name); assert.ok(elapsed >= 0); };
  const info = publicInfo(f.context, f.org, f.now);
  assert.equal(snapshots, 1); assert.equal(writers, 0);
  assert.deepEqual(info.services[0].staffIds, [f.owner.accountId]);
  assert.notEqual(publicInfo(f.context, f.org, f.now).challenge, info.challenge);
  assert.ok(!('settings' in info) && !('specialties' in info));
  const available = publicAvailability(f.context, f.org,
    { date: f.date, serviceIds: ['s'], staffId: f.owner.accountId }, f.now);
  assert.equal(snapshots, 3); assert.equal(writers, 0);
  assert.ok(available.slots.length && available.slots.every(slot => !('roomId' in slot)));
  assert.ok(publicDates(f.context, f.org, '2030-01', f.owner.accountId).dates.includes(f.date));
  assert.equal(writers, 0);
  f.context.recordTiming = () => { throw Error('Synthetic diagnostic sink failure'); };
  assert.equal(publicInfo(f.context, f.org, f.now).health.available, true);
  assert.equal(publicSubmit(f.context, f.org, f.input(), f.now).status, 'booked');
  assert.ok(writers > 0);
  assert.ok(phases.includes('booking-readiness') && phases.includes('booking-availability'));
});

test('automatic closing still reconciles in a writer and never re-enables after the last working day', async t => {
  const f = await bookingFixture(); t.after(f.close);
  let writers = 0; const write = f.platform.withWriteLock;
  f.platform.withWriteLock = callback => { writers++; return write(callback); };
  const info = publicInfo(f.context, f.org, Date.parse('2031-01-01T00:00Z'));
  assert.equal(writers, 1); assert.equal(info.health.reason, 'no_working_days');
  assert.equal(f.platform.bookingPublication.view(f.token).enabled, false);
  assert.equal(publicInfo(f.context, f.org, f.now).health.reason, 'awaiting_activation');
  assert.equal(writers, 1);
});

test('read snapshot permits a concurrent settings commit but keeps its own coherent version', async t => {
  const f = await bookingFixture();
  const other = createPlatformStore(path.join(f.dir, 'platform'));
  t.after(() => { other.close(); f.close(); });
  f.platform.withReadSnapshot(() => {
    const old = f.platform.onlineBooking.settings(f.org);
    other.onlineBooking.save(f.token, { ...old, showPrices: false }, new Set(['s']));
    assert.equal(f.platform.onlineBooking.settings(f.org).showPrices, true);
  });
  assert.equal(publicInfo(f.context, f.org, f.now).showPrices, false);
});

test('bounded budget cleanup cannot weaken cross-worker limits or expiry at the exact deadline', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE login_limits(key TEXT PRIMARY KEY, failures INTEGER, window_started INTEGER, blocked_until INTEGER)');
  const transaction = callback => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  let sweeps = 0;
  const context = { db: { prepare(sql) {
    const statement = db.prepare(sql);
    return sql.startsWith('DELETE') ? { run(now) { sweeps++; return statement.run(now); } } : statement;
  } }, transaction, limitKey: (scope, value) => scope + ':' + value };
  const limits = createBookingPublicLimits(context), second = createBookingPublicLimits(context);
  for (let i = 0; i < 240; i++) limits.consume('read', '', 'synthetic', '', 0);
  assert.equal(sweeps, 1);
  assert.throws(() => limits.consume('read', '', 'synthetic', '', 10), { status: 429 });
  assert.throws(() => second.consume('read', '', 'synthetic', '', 10), { status: 429 });
  const insert = db.prepare('INSERT INTO login_limits VALUES(?,?,?,?)');
  for (let i = 0; i < 1000; i++) insert.run('booking-budget:000-' + String(i).padStart(4, '0'), 1, 0, 59999);
  insert.run('password:preserve', 1, 0, 0);
  limits.consume('read', '', 'synthetic', '', 60000);
  const current = db.prepare('SELECT * FROM login_limits WHERE key=?').get('booking-budget:read-address:synthetic');
  assert.equal(current.failures, 1); assert.equal(current.window_started, 60000);
  assert.equal(db.prepare("SELECT count(*) AS n FROM login_limits WHERE key LIKE 'booking-budget:000-%'").get().n, 500);
  assert.ok(db.prepare("SELECT 1 FROM login_limits WHERE key='password:preserve'").get());
  const before = sweeps; limits.consume('read', '', 'synthetic', '', 60001);
  assert.equal(sweeps, before);
});

test('date formatter caching preserves midnight, zone separation and invalid-zone errors', () => {
  assert.equal(dateInZone(Date.parse('2030-01-01T20:59:59Z'), 'Europe/Moscow'), '2030-01-01');
  assert.equal(dateInZone(Date.parse('2030-01-01T21:00:00Z'), 'Europe/Moscow'), '2030-01-02');
  assert.equal(dateInZone(Date.parse('2030-01-01T20:00:00Z'), 'Asia/Yerevan'), '2030-01-02');
  assert.throws(() => dateInZone(0, 'invalid/synthetic-zone'), RangeError);
});
