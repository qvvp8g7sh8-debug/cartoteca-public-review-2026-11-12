const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');

test('durable pre-intent survives outer rollback after owning tenant commit and reconciles current data', (t) => {
  const f = scheduleFixture(t);
  f.link();
  f.coordinator.schedule();
  const s = f.platform.notificationSchedule;
  const intent = s.beginIntent('org', 'synthetic-operation', f.clock());
  assert.throws(
    () =>
      f.database.transaction(() => {
        s.assertIntent(intent, f.clock());
        // Owning tenant commit survives the later platform failure.
        f.appointment.date = '2030-01-10';
        s.markDirty('org', 'client', 'p');
        s.assertIntent(intent, f.clock());
        s.ackIntent(intent);
        throw Error('synthetic platform commit failure');
      }),
    /synthetic platform/,
  );
  assert.ok(f.database.db.prepare('SELECT 1 FROM notification_schedule_intents').get());
  f.advance(120001);
  f.coordinator.schedule();
  assert.equal(
    f.database.db.prepare('SELECT 1 FROM notification_schedule_intents').get(),
    undefined,
  );
  assert.equal(
    f.database.db.prepare("SELECT due_at FROM notification_schedule WHERE kind='client'").get()
      .due_at,
    Date.parse('2030-01-09T10:00Z'),
  );
});

test('expired writer cannot commit after recovery has consumed its intent; stale ack cannot clear a new intent', (t) => {
  const f = scheduleFixture(t),
    s = f.platform.notificationSchedule;
  const expired = s.beginIntent('org', 'first', f.clock());
  f.advance(120001);
  let reads = 0;
  assert.equal(
    s.recoverExpired(() => {
      reads++;
    }, f.clock()),
    1,
  );
  assert.equal(reads, 1);
  const next = s.beginIntent('org', 'second', f.clock());
  assert.throws(
    () => f.database.transaction(() => s.assertIntent(expired, f.clock())),
    (e) => e.status === 409,
  );
  assert.throws(() => f.database.transaction(() => s.ackIntent(expired)), /intent lost/);
  f.database.transaction(() => {
    s.assertIntent(next, f.clock());
    s.ackIntent(next);
  });
  assert.equal(
    f.database.db.prepare('SELECT count(*) n FROM notification_schedule_intents').get().n,
    0,
  );
});

test('failed recovery retains durable intent and dirty writes roll back; async transaction work is forbidden', (t) => {
  const f = scheduleFixture(t),
    s = f.platform.notificationSchedule;
  const intent = s.beginIntent('org', 'first', f.clock());
  f.advance(120001);
  assert.throws(
    () =>
      s.recoverExpired(() => {
        throw Error('synthetic read error');
      }, f.clock()),
    /synthetic read/,
  );
  assert.ok(
    f.database.db.prepare('SELECT 1 FROM notification_schedule_intents WHERE id=?').get(intent.id),
  );
  assert.throws(() => s.recoverExpired(() => Promise.resolve(), f.clock()), /Asynchronous intent/);
  assert.throws(() => f.database.transaction(() => s.beginIntent('org')), /before mutation/);
  assert.throws(() => s.assertIntent(intent), /requires platform/);
});

test('task and dirty fencing prevent stale completion from clearing a replacement', (t) => {
  const f = scheduleFixture(t),
    s = f.platform.notificationSchedule;
  f.link();
  f.coordinator.schedule();
  const old = f.database.db.prepare('SELECT * FROM notification_schedule LIMIT 1').get();
  f.dirty();
  const staleDirty = s.nextDirty('client');
  f.dirty();
  f.database.transaction(() => assert.equal(s.finishDirty(staleDirty), false));
  f.coordinator.schedule();
  assert.equal(s.finishTask(old), false);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM notification_schedule').get().n, 1);
});
