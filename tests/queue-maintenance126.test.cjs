const test = require('node:test');
const assert = require('node:assert/strict');
const { batchFixture } = require('./helpers/queue-maintenance126-fixture.cjs');
const {
  createQueueCompatibilityMaintenance,
} = require('../src/server/modules/notifications/queue-compatibility-maintenance.cjs');
const {
  createQueueMaintenanceStore,
} = require('../src/server/modules/notifications/queue-maintenance-store.cjs');
const NOW = 1000000000,
  DAY = 86400000;
const compatibility = (f, table, channels) =>
  createQueueCompatibilityMaintenance(f, table, channels);
function mixed(f, table) {
  f.seed(table, 'a-expired', { expires: NOW });
  f.seed(table, 'b-recover', {
    status: 'sending',
    lease: NOW,
    expires: NOW - 8 * DAY,
    leaseId: 'old',
  });
  f.seed(table, 'c-old', { status: 'sent', expires: NOW - 7 * DAY - 1 });
  f.seed(table, 'd-boundary', { status: 'sent', expires: NOW - 7 * DAY });
  f.seed(table, 'e-live', { status: 'sending', lease: NOW + 1, leaseId: 'live' });
}
test('PG compatibility batches mixed CAS updates and retention, preserving SQLite results and strict boundary', (t) => {
  const pg = batchFixture(t),
    sqlite = batchFixture(t, false),
    table = 'staff_max_jobs';
  for (const f of [pg, sqlite]) {
    mixed(f, table);
    const clean = compatibility(f, table);
    assert.deepEqual(
      f.transaction(() => clean.sweep(NOW)),
      { examined: 5, changed: 3 },
    );
    assert.equal(f.rows(table).find((row) => row.id === 'b-recover').status, 'uncertain');
    assert.equal(
      f.rows(table).some((row) => row.id === 'b-recover'),
      true,
      'newly uncertain rows are not retained in the same page',
    );
  }
  assert.deepEqual(pg.rows(table), sqlite.rows(table));
  assert.equal(pg.writes().length, 2);
  assert.equal(sqlite.writes().length, 3);
  assert.match(pg.writes()[0].plan.text, /IS NOT DISTINCT FROM/);
  pg.assertCompiled();
});
test('PG compatibility keeps physical 64-row pages, cursor wrap and eight-row channel recovery', (t) => {
  const f = batchFixture(t),
    table = 'notification_channel_jobs';
  for (let n = 0; n < 70; n++) f.seed(table, 'a-' + String(n).padStart(3, '0'), { expires: NOW });
  f.seed(table, 'z-other', { channel: 'max', expires: NOW });
  const clean = compatibility(f, table, ['telegram']);
  assert.deepEqual(
    f.transaction(() => clean.sweep(NOW)),
    { examined: 64, changed: 64 },
  );
  assert.deepEqual(
    f.transaction(() => clean.sweep(NOW)),
    { examined: 7, changed: 6 },
  );
  assert.equal(f.rows(table).at(-1).status, 'pending');
  f.seed(table, '0-wrap', { expires: NOW });
  assert.equal(f.transaction(() => clean.sweep(NOW)).changed, 1);
  for (let n = 0; n < 12; n++)
    f.seed(table, 'r-' + n, { status: 'reserved', lease: NOW, due: NOW - 1 });
  f.seed(table, 'u-unknown', { status: 'sending', lease: NOW });
  assert.deepEqual(
    f.transaction(() => clean.recover(NOW)),
    { examined: 8, changed: 8 },
  );
  assert.equal(f.rows(table).find((row) => row.id === 'u-unknown').status, 'uncertain');
  assert.equal(clean.blocks(NOW, NOW), true);
  f.transaction(() => clean.recover(NOW));
  assert.equal(clean.blocks(NOW, NOW), false);
  f.assertCompiled();
});
test('PG compatibility CAS rejects status, expiry, lease time and lease-id replacements including null', (t) => {
  const f = batchFixture(t),
    table = 'staff_max_jobs';
  for (const id of ['expiry', 'lease', 'lease-id', 'status', 'unchanged'])
    f.seed(table, id, { expires: NOW });
  let first = true;
  f.before(({ sql, method }) => {
    if (!first || method !== 'run' || !sql.startsWith('UPDATE')) return;
    first = false;
    f.native.prepare(`UPDATE ${table} SET expires_at=? WHERE id='expiry'`).run(NOW + 1);
    f.native.prepare(`UPDATE ${table} SET lease_until=? WHERE id='lease'`).run(NOW + 1);
    f.native.exec(
      `UPDATE ${table} SET lease_id='replacement' WHERE id='lease-id'; UPDATE ${table} SET status='sent' WHERE id='status'`,
    );
  });
  assert.deepEqual(
    f.transaction(() => compatibility(f, table).sweep(NOW)),
    { examined: 5, changed: 1 },
  );
  assert.equal(f.rows(table).filter((row) => row.status === 'cancelled').length, 1);
  assert.equal(f.rows(table).find((row) => row.id === 'lease-id').lease_id, 'replacement');
  f.assertCompiled();
});
test('a failure inside one PG compatibility batch rolls back its full caller transaction', (t) => {
  const f = batchFixture(t),
    table = 'staff_push_jobs';
  f.seed(table, 'a', { expires: NOW });
  f.seed(table, 'b', { expires: NOW });
  f.native.exec(
    `CREATE TRIGGER fail_batch BEFORE UPDATE ON ${table} WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'synthetic batch failure'); END`,
  );
  const clean = compatibility(f, table);
  assert.throws(() => f.transaction(() => clean.sweep(NOW)), /synthetic batch failure/);
  assert.deepEqual(
    f.rows(table).map((row) => row.status),
    ['pending', 'pending'],
  );
  f.native.exec('DROP TRIGGER fail_batch');
  assert.deepEqual(
    f.transaction(() => clean.sweep(NOW)),
    { examined: 2, changed: 2 },
    'cursor is not advanced by a failed page',
  );
});
test('Q1 PG phases preserve 128 examined rows with at most 64 selected identities per mutation', (t) => {
  const f = batchFixture(t),
    table = 'notification_channel_jobs';
  for (let n = 0; n < 130; n++) f.seed(table, 'expired-' + n, { expires: NOW });
  f.seed(table, 'other-channel', { channel: 'max', expires: NOW });
  const store = createQueueMaintenanceStore(f);
  assert.deepEqual(
    f.transaction(() => store.phases[2].run(NOW, 128)),
    { examined: 128, changed: 128, lagMs: 0 },
  );
  assert.equal(f.writes().length, 2);
  assert.ok(f.writes().every(({ args }) => args.length === 66));
  assert.equal(f.rows(table).find((row) => row.id === 'other-channel').status, 'pending');
  f.assertCompiled();
});
test('Q1 PG mixed client recovery and MAX expiry match SQLite without replaying unknown sends', (t) => {
  const pg = batchFixture(t),
    sqlite = batchFixture(t, false);
  for (const f of [pg, sqlite]) {
    f.seed('notification_channel_jobs', 'unknown', { status: 'sending', lease: NOW });
    f.seed('notification_channel_jobs', 'reserved-live', { status: 'reserved', lease: NOW });
    f.seed('notification_channel_jobs', 'reserved-dead', {
      status: 'reserved',
      lease: NOW,
      expires: NOW,
    });
    f.seed('notification_channel_jobs', 'other', {
      channel: 'max',
      status: 'reserved',
      lease: NOW,
    });
    f.seed('staff_max_jobs', 'unknown', { status: 'sending', lease: NOW, expires: NOW });
    f.seed('staff_max_jobs', 'known-expired', { status: 'sending', lease: NOW + 1, expires: NOW });
    f.seed('staff_max_jobs', 'pending', { expires: NOW });
    const store = createQueueMaintenanceStore(f);
    assert.deepEqual(
      f.transaction(() => store.recoverClient(NOW, ['telegram'])),
      { examined: 3, changed: 3 },
    );
    assert.deepEqual(
      f.transaction(() => store.phases[10].run(NOW, 128)),
      { examined: 3, changed: 3, lagMs: 0 },
    );
    assert.equal(f.rows('staff_max_jobs').find((row) => row.id === 'unknown').status, 'uncertain');
  }
  for (const table of ['notification_channel_jobs', 'staff_max_jobs'])
    assert.deepEqual(pg.rows(table), sqlite.rows(table));
  assert.equal(pg.writes().length, 3);
  pg.assertCompiled();
});
test('Q1 PG selected writes recheck predicates and MAX per-row lease CAS', (t) => {
  const f = batchFixture(t),
    table = 'staff_max_jobs';
  f.seed(table, 'replaced', { status: 'sending', lease: NOW, expires: NOW });
  f.seed(table, 'expired', { expires: NOW });
  let first = true;
  f.before(({ sql, method }) => {
    if (!first || method !== 'run' || !sql.startsWith('UPDATE')) return;
    first = false;
    f.native.prepare(`UPDATE ${table} SET lease_until=? WHERE id='replaced'`).run(NOW + 1);
  });
  const phase = createQueueMaintenanceStore(f).phases[10];
  assert.deepEqual(
    f.transaction(() => phase.run(NOW, 128)),
    { examined: 2, changed: 1, lagMs: 0 },
  );
  assert.equal(f.rows(table).find((row) => row.id === 'replaced').status, 'sending');
  f.assertCompiled();
});
test('Q1 PG failure in a later chunk rolls back earlier chunks and retention preserves live leases', (t) => {
  const f = batchFixture(t),
    table = 'staff_push_jobs';
  for (let n = 0; n < 70; n++) f.seed(table, 'a-' + String(n).padStart(3, '0'), { expires: NOW });
  f.native.exec(
    `CREATE TRIGGER fail_batch BEFORE UPDATE ON ${table} WHEN NEW.id='a-069' BEGIN SELECT RAISE(ABORT,'synthetic later chunk failure'); END`,
  );
  const store = createQueueMaintenanceStore(f);
  assert.throws(
    () => f.transaction(() => store.phases[13].run(NOW, 128)),
    /synthetic later chunk failure/,
  );
  assert.equal(f.rows(table).filter((row) => row.status === 'pending').length, 70);
  f.native.exec('DROP TRIGGER fail_batch');
  f.seed(table, 'old', { status: 'sent', expires: NOW - 7 * DAY - 1 });
  f.seed(table, 'boundary', { status: 'sent', expires: NOW - 7 * DAY });
  f.seed(table, 'live', { status: 'sending', expires: NOW - 8 * DAY, lease: NOW + 1 });
  assert.deepEqual(
    f.transaction(() => store.phases[14].run(NOW, 128)),
    { examined: 1, changed: 1, lagMs: 1 },
  );
  assert.equal(f.rows(table).find((row) => row.id === 'live').lease_until, NOW + 1);
  f.assertCompiled();
});
