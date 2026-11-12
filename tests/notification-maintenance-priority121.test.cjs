const test = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
const turn = () => new Promise(setImmediate);
const status = (f) =>
  f.c.db.prepare("SELECT status FROM notification_channel_jobs WHERE id='synthetic-gated'").get()
    .status;
async function settled(f) {
  for (let i = 0; i < 4 && f.maintenance.stats().busy; i++) await turn();
  assert.equal(f.maintenance.stats().busy, false);
}
function waitingSend(f) {
  f.client('synthetic-gated', { status: 'sending', lease: f.clock() });
}

test('managed Q1 start admits the real probe and writer unit outside SQL transactions', async (t) => {
  const f = await maintenanceFixture(t, { intervalMs: 10 });
  waitingSend(f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release,
    calls = 0;
  const runWork = (callback, scope, owned) => {
    assert.equal(f.c.db.isTransaction, false);
    assert.equal(scope, '');
    assert.equal(owned(), true);
    if (calls++ === 0)
      return new Promise((resolve) => {
        release = () => resolve(callback());
      });
    return callback();
  };
  f.maintenance.start(() => true, runWork);
  t.mock.timers.tick(10);
  assert.equal(typeof release, 'function');
  assert.equal(f.transactions(), 0);
  assert.equal(status(f), 'sending');
  assert.equal(f.c.db.isTransaction, false);
  release();
  await settled(f);
  assert.equal(status(f), 'uncertain');
  assert.equal(f.transactions(), 1);
  assert.ok(calls > 1, 'subsequent empty probes also use actual shared admission');
  assert.equal(f.c.db.isTransaction, false);
  f.maintenance.stop();
});

test('stop while common admission waits prevents even the first mutation and ends the old generation', async (t) => {
  const f = await maintenanceFixture(t, { intervalMs: 10 });
  waitingSend(f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, ownership;
  f.maintenance.start(
    () => true,
    (callback, scope, owned) =>
      new Promise((resolve) => {
        ownership = owned;
        release = () => resolve(callback());
      }),
  );
  t.mock.timers.tick(10);
  assert.equal(ownership(), true);
  f.maintenance.stop();
  assert.equal(ownership(), false);
  release();
  await settled(f);
  assert.equal(status(f), 'sending');
  assert.equal(f.transactions(), 0);
  assert.equal(f.maintenance.stats().running, false);
  t.mock.timers.tick(100);
  assert.equal(f.transactions(), 0);
});

test('fresh channel revocation while admitted work waits leaves the durable job unchanged', async (t) => {
  const f = await maintenanceFixture(t);
  waitingSend(f);
  let release,
    calls = 0;
  const pending = f.maintenance.tick({
    canRun: () => true,
    runWork(callback) {
      assert.equal(f.c.db.isTransaction, false);
      if (calls++ === 0)
        return new Promise((resolve) => {
          release = () => resolve(callback());
        });
      return callback();
    },
  });
  f.c.notificationChannels.enabled = () => false;
  release();
  await pending;
  assert.equal(status(f), 'sending');
  assert.equal(f.transactions(), 0);
});

test('the independently queued writer rechecks ownership after shared work admission', async (t) => {
  const f = await maintenanceFixture(t);
  waitingSend(f);
  let releaseWriter,
    admitted = 0;
  f.c.asyncTransaction = (callback) =>
    new Promise((resolve) => {
      releaseWriter = () => resolve(f.c.transaction(callback));
    });
  const pending = f.maintenance.tick({
    canRun: () => true,
    runWork(callback) {
      admitted++;
      assert.equal(f.c.db.isTransaction, false);
      return callback();
    },
  });
  assert.equal(admitted, 1);
  assert.equal(f.c.db.isTransaction, false);
  f.maintenance.stop();
  releaseWriter();
  await pending;
  assert.equal(status(f), 'sending');
  assert.equal(f.maintenance.stats().slices, 0);
  assert.equal(f.c.db.isTransaction, false);
});

test('manual tick retains its original direct contract even when managed start has a hook', async (t) => {
  const f = await maintenanceFixture(t);
  waitingSend(f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  f.maintenance.start(
    () => true,
    () => {
      calls++;
      assert.fail('timer was not fired');
    },
  );
  const result = await f.maintenance.tick({ canRun: () => true });
  assert.equal(result.changed, 1);
  assert.equal(status(f), 'uncertain');
  assert.equal(calls, 0);
  f.maintenance.stop();
});

test('shared admission failure preserves durable work for a later bounded maintenance pass', async (t) => {
  const f = await maintenanceFixture(t);
  waitingSend(f);
  await assert.rejects(
    f.maintenance.tick({
      canRun: () => true,
      runWork: () => Promise.reject(Object.assign(Error('synthetic capacity'), { status: 503 })),
    }),
    { status: 503 },
  );
  assert.equal(status(f), 'sending');
  assert.equal(f.transactions(), 0);
  assert.equal(f.maintenance.stats().errors, 1);
  for (let i = 0; i < 24 && status(f) === 'sending'; i++)
    await f.maintenance.tick({ canRun: () => true });
  assert.equal(status(f), 'uncertain');
});
