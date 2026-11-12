const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPushDeliveryAdmission,
  limits,
} = require('../src/server/modules/notifications/push-delivery-admission.cjs');
test('Push admission bounds live provider slots by device, organization and global total', () => {
  const a = createPushDeliveryAdmission({ monotonic: () => 0 });
  const job = (device, org) => ({ device_id: device, organization_id: org });
  const done = [a.hold(job('a1', 'a')), a.hold(job('a2', 'a'))];
  assert.deepEqual(a.exclusions(), { excludeDevices: ['a1', 'a2'], excludeOrganizations: ['a'] });
  assert.throws(() => a.hold(job('a3', 'a')), /admission/);
  assert.throws(() => a.hold(job('a1', 'b')), /admission/);
  done.push(a.hold(job('b1', 'b')), a.hold(job('c1', 'c')));
  assert.throws(() => a.hold(job('d1', 'd')), /admission/);
  assert.deepEqual(a.stats(), {
    active: 4,
    peakActive: 4,
    activeOrganizations: 3,
    syncWorkMs: 0,
    budgetYields: 0,
  });
  done[0]();
  done[0]();
  const replacement = a.hold(job('a1', 'a'));
  done[0]();
  assert.equal(a.active, 4, 'an old completion cannot release a reused device slot');
  replacement();
  done.slice(1).forEach((finish) => finish());
  assert.equal(a.active, 0);
  assert.deepEqual(a.exclusions(), { excludeDevices: [], excludeOrganizations: [] });
  assert.deepEqual(limits, { active: 4, organization: 2, starts: 10, burstMs: 8, cpuShare: 0.25 });
});
test('one expensive synchronous claim carries CPU debt across turns; idle credit never exceeds8ms', () => {
  let now = 0;
  const a = createPushDeliveryAdmission({ monotonic: () => now });
  assert.equal(a.delay(), 0);
  assert.equal(
    a.measure(() => {
      now += 20;
      return 'same result';
    }),
    'same result',
  );
  assert.equal(a.delay(), 29);
  a.yield();
  now += 28;
  assert.equal(a.delay(), 1);
  now += 1;
  assert.equal(a.delay(), 0);
  assert.throws(
    () =>
      a.measure(() => {
        now += 12;
        throw Error('native failure');
      }),
    /native failure/,
  );
  assert.ok(a.delay() > 0, 'failed native work consumes its real synchronous budget too');
  now += 100000;
  a.measure(() => {
    now += 12;
  });
  assert.ok(a.delay() > 0, 'long idle cannot buy an unbounded burst');
  assert.deepEqual(a.stats(), {
    active: 0,
    peakActive: 0,
    activeOrganizations: 0,
    syncWorkMs: 44,
    budgetYields: 1,
  });
});
test('CPU accounting observes synchronous start only, without awaiting or modifying provider promises', async () => {
  let now = 0,
    accept;
  const a = createPushDeliveryAdmission({ monotonic: () => now });
  const promise = new Promise((resolve) => {
    accept = resolve;
  });
  assert.equal(
    a.measure(() => promise),
    promise,
  );
  now += 10000;
  accept();
  await promise;
  assert.equal(a.stats().syncWorkMs, 0, 'network wait is not synchronous CPU work');
});
