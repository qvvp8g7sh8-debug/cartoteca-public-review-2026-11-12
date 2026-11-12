const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduleFixture } = require('./helpers/notification-schedule-fixture.cjs');
const { createPushSchedule } = require('../src/server/modules/notifications/push-events.cjs');

function fixture(t) {
  const f = scheduleFixture(t);
  const original = f.platform.workSchedules.futureDays;
  let reads = 0;
  f.platform.workSchedules.futureDays = (...args) => {
    reads++;
    return original(...args);
  };
  const scheduler = createPushSchedule(f.platform, f.tenantStore, f.platform.staffPush, f.clock);
  const day = (date, time = '10:00', staff = 'owner', status = 'working') =>
    f.database.db
      .prepare('INSERT OR REPLACE INTO work_schedule_days VALUES(?,?,?,?)')
      .run('org', staff, date, f.database.seal({ status, intervals: [[time, '12:00']] }));
  return { ...f, scheduler, day, reads: () => reads };
}
const tasks = (f) =>
  f.database.db.prepare("SELECT * FROM notification_schedule WHERE kind='workday'").all();
const jobs = (f) => f.database.db.prepare('SELECT * FROM staff_push_jobs').all();

test('workday plan jumps to next explicitly scheduled day and idle passes do not read any calendar', async (t) => {
  const f = fixture(t);
  f.device();
  f.day('2030-01-03');
  f.day('2030-06-01', '09:00');
  assert.equal(await f.scheduler.scheduleBatched(), true);
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-03T09:30Z'));
  const reads = f.reads();
  for (let i = 0; i < 20; i++) f.scheduler.schedule();
  assert.equal(f.reads(), reads);
  assert.equal(jobs(f).length, 0);
  f.setNow(Date.parse('2030-01-03T09:30Z'));
  f.scheduler.schedule();
  assert.equal(jobs(f).length, 1);
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-06-01T08:30Z'));
  f.scheduler.schedule();
  assert.equal(jobs(f).length, 1);
  assert.equal(
    f.metrics.appointmentReads + f.metrics.profileReads,
    0,
    'workday planner needs no clinical data',
  );
});

test('closures, device preferences and disconnection invalidate only affected organization plans', (t) => {
  const f = fixture(t);
  f.device();
  f.day('2030-01-03');
  f.day('2030-01-04');
  f.scheduler.schedule();
  f.day('2030-01-03', '10:00', 'organization', 'closed');
  f.scheduler.schedule();
  assert.equal(tasks(f)[0].entity, '2030-01-04');
  f.device('device', 'owner', 120);
  f.scheduler.schedule();
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-04T08:00Z'));
  f.database.db.prepare("DELETE FROM staff_push_devices WHERE id='device'").run();
  f.scheduler.schedule();
  assert.equal(tasks(f).length, 0);
  assert.equal(jobs(f).length, 0);
});

test('fresh role/account state and changed start prevent stale workday enqueue', (t) => {
  const f = fixture(t);
  f.device();
  f.day('2030-01-03');
  f.scheduler.schedule();
  f.setNow(Date.parse('2030-01-03T09:30Z'));
  f.database.db.prepare("UPDATE accounts SET status='suspended' WHERE id='owner'").run();
  f.scheduler.schedule();
  assert.equal(jobs(f).length, 0);
  f.database.db.prepare("UPDATE accounts SET status='active' WHERE id='owner'").run();
  f.day('2030-01-03', '11:00');
  f.scheduler.schedule();
  assert.equal(jobs(f).length, 0);
  assert.equal(tasks(f)[0].due_at, Date.parse('2030-01-03T10:30Z'));
});
