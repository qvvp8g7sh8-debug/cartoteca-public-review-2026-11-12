// PREPARED WORK-only regression. Root runs RED/GREEN; this file starts no process/server/provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.existsSync(path.join(__dirname, 'helpers/passive-view-fixture.cjs'))
  ? path.resolve(__dirname, '..') : path.resolve(__dirname, '../../..');
const { fixture, deferred } = require(path.join(root, 'tests/helpers/passive-view-fixture.cjs'));
const route = '/api/cabinet/time-zone';
const zoneFixture = (t) => fixture(t, { view: 'services' });
const replaceAccount = (f, changes = {}) => {
  f.state.account = { ...f.state.account, ...changes };
};
function assertClock(f, zone, date) {
  assert.equal(f.state.timeZone, zone, 'live confirmed zone belongs to the latest valid authority');
  assert.equal(f.actions.cabinetToday(), date, 'live clock must agree with the current zone');
  assert.equal(f.date(), date, 'an anchor following today must agree before any background pump');
  assert.deepEqual(f.errors, [], 'obsolete reads must not create a toast');
  f.assertNoMutation();
}

test('zone ABA A1 to B to fresh A3 keeps A3 live zone and anchor after old A1 settles', async (t) => {
  const f = zoneFixture(t), first = deferred(), middle = deferred(), latest = deferred();
  const gates = [first, middle, latest];
  let reads = 0;
  f.handle(route, () => gates[reads++].promise);
  const a1 = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  replaceAccount(f, { organizationId: 'other-org' });
  const b = f.actions.refreshCabinetTimeZone();
  await f.flush();
  replaceAccount(f, { organizationId: 'org' });
  const a3 = f.actions.refreshCabinetTimeZone();
  await f.flush();
  latest.resolve({ timeZone: 'Europe/Samara' });
  await a3;
  middle.reject(Error('Synthetic obsolete B failure'));
  await b;
  first.resolve({ timeZone: 'Europe/Moscow' });
  await a1; await f.flush();
  assert.equal(reads, 3, 'each changed scope must own its source read');
  assertClock(f, 'Europe/Samara', '2026-10-06');
});

test('forced refresh for a replacement account object with identical IDs does not join its predecessor', async (t) => {
  const f = zoneFixture(t), old = deferred(), current = deferred();
  let reads = 0;
  f.handle(route, () => (++reads === 1 ? old.promise : current.promise));
  const oldTask = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  replaceAccount(f);
  const currentTask = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  const startedBeforeSettlement = reads;
  old.resolve({ timeZone: 'Europe/Moscow' });
  current.resolve({ timeZone: 'Europe/Samara' });
  await Promise.all([oldTask, currentTask]); await f.flush();
  assert.equal(startedBeforeSettlement, 2, 'force is a current identity read, not a join to old object authority');
  assertClock(f, 'Europe/Samara', '2026-10-06');
});

test('old rejected same-ID owner cannot clear the new pending request or create a replacement read', async (t) => {
  const f = zoneFixture(t), old = deferred(), current = deferred();
  let reads = 0;
  f.handle(route, () => (++reads === 1 ? old.promise : current.promise));
  const oldTask = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  replaceAccount(f);
  const currentTask = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  const currentStarts = reads;
  old.reject(Error('Synthetic obsolete HTTP rejection'));
  await oldTask; await f.flush();
  const joined = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  const startsAfterOldFinally = reads;
  current.resolve({ timeZone: 'Europe/Samara' });
  await Promise.all([currentTask, joined]); await f.flush();
  assert.equal(currentStarts, 2);
  assert.equal(startsAfterOldFinally, 2, 'late finally must not detach the current pending owner');
  assertClock(f, 'Europe/Samara', '2026-10-06');
});

test('a newer validated public timezone application invalidates an older HTTP answer', async (t) => {
  for (const mode of ['changed', 'same-zone', 'initial']) {
    await t.test(mode, async (t) => {
      const f = zoneFixture(t), gate = deferred();
      f.handle(route, () => gate.promise);
      const pending = f.actions.refreshCabinetTimeZone({ force: true });
      await f.flush();
      const expectedZone = mode === 'changed' ? 'Europe/Samara' : 'Europe/Moscow';
      const expectedDate = mode === 'changed' ? '2026-10-06' : '2026-10-05';
      if (mode === 'initial') f.state.calendarAnchorDate = f.actions.parseDate('2030-01-17');
      f.actions.applyCabinetTimeZone(expectedZone, { initial: mode === 'initial' });
      gate.resolve({ timeZone: mode === 'changed' ? 'Europe/Moscow' : 'Europe/Samara' });
      await pending; await f.flush();
      assert.equal(f.readCalls(route).length, 1);
      assertClock(f, expectedZone, expectedDate);
      assert.equal([...f.timers.values()].filter((timer) => timer.due === Date.parse('2026-10-05T20:30:12Z')).length, 0,
        'the settled read must dispose its own 12 second timeout');
    });
  }
});

test('force after an explicit setter starts a fresh read and old completion cannot detach it', async (t) => {
  const f = zoneFixture(t), old = deferred(), current = deferred();
  let reads = 0;
  f.handle(route, () => (++reads === 1 ? old.promise : current.promise));
  const oldTask = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  f.actions.applyCabinetTimeZone('Europe/Samara');
  const currentTask = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  const startsAfterApply = reads;
  old.resolve({ timeZone: 'Europe/Moscow' });
  await oldTask; await f.flush();
  const intermediateZone = f.state.timeZone;
  const joined = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  const startsAfterOldFinally = reads;
  current.resolve({ timeZone: 'Asia/Kamchatka' });
  await Promise.all([currentTask, joined]); await f.flush();
  assert.equal(startsAfterApply, 2);
  assert.equal(intermediateZone, 'Europe/Samara');
  assert.equal(startsAfterOldFinally, 2);
  assertClock(f, 'Asia/Kamchatka', '2026-10-06');
});

test('two forced refreshes for the same current account and generation still coalesce once', async (t) => {
  const f = zoneFixture(t), gate = deferred();
  f.handle(route, () => gate.promise);
  const first = f.actions.refreshCabinetTimeZone({ force: true });
  const second = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  const starts = f.readCalls(route).length;
  gate.resolve({ timeZone: 'Europe/Samara' });
  const values = await Promise.all([first, second]); await f.flush();
  assert.equal(starts, 1);
  assert.deepEqual(values, [undefined, undefined], 'the existing public completion result is unchanged');
  assertClock(f, 'Europe/Samara', '2026-10-06');
});

test('confirmed same-ID organization TTL stays 60 seconds even when a session account object is replaced', async (t) => {
  const f = zoneFixture(t);
  f.handle(route, () => ({ timeZone: 'Europe/Moscow' }));
  await f.actions.refreshCabinetTimeZone({ force: true });
  replaceAccount(f);
  await f.actions.refreshCabinetTimeZone();
  assert.equal(f.readCalls(route).length, 1, 'object replacement alone must not expand the source read budget');
  await f.advance(59999);
  await f.actions.refreshCabinetTimeZone();
  assert.equal(f.readCalls(route).length, 1, 'confirmed scope TTL remains in force before 60 seconds');
  await f.advance(1);
  await f.actions.refreshCabinetTimeZone();
  assert.equal(f.readCalls(route).length, 2, 'the exact existing deadline still allows a fresh read');
  assertClock(f, 'Europe/Moscow', '2026-10-05');
});

test('confirmed old organization TTL still cannot postpone a first read of the new organization', async (t) => {
  const f = zoneFixture(t);
  f.handle(route, (call) => ({ timeZone: call.scope.endsWith('|org') ? 'Europe/Moscow' : 'Europe/Samara' }));
  await f.actions.refreshCabinetTimeZone({ force: true });
  replaceAccount(f, { organizationId: 'other-org' });
  await f.actions.refreshCabinetTimeZone();
  assert.equal(f.readCalls(route).length, 2);
  assertClock(f, 'Europe/Samara', '2026-10-06');
});

test('an invalid explicit timezone does not retire a valid current pending HTTP answer', async (t) => {
  const f = zoneFixture(t), gate = deferred();
  f.handle(route, () => gate.promise);
  const pending = f.actions.refreshCabinetTimeZone({ force: true });
  await f.flush();
  assert.throws(() => f.actions.applyCabinetTimeZone('Synthetic/Invalid'), { name: 'RangeError' });
  gate.resolve({ timeZone: 'Europe/Samara' });
  await pending; await f.flush();
  assert.equal(f.readCalls(route).length, 1);
  assertClock(f, 'Europe/Samara', '2026-10-06');
});

test('hidden, single-user and absent-account entry guards start no timezone HTTP', async (t) => {
  const f = zoneFixture(t);
  f.hidden(true, false);
  await f.actions.refreshCabinetTimeZone({ force: true });
  f.hidden(false, false);
  f.state.multiUser = false;
  await f.actions.refreshCabinetTimeZone({ force: true });
  f.state.multiUser = true;
  f.state.account = null;
  await f.actions.refreshCabinetTimeZone({ force: true });
  assert.equal(f.readCalls(route).length, 0);
  f.assertNoMutation();
});
