const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestDispatcher } = require('../src/server/infrastructure/request-dispatcher.cjs');

function fixture(options = {}) {
  let clock = 0,
    next = 0;
  const scheduled = new Map();
  const dispatcher = createRequestDispatcher({
    now: () => clock,
    schedule(callback) {
      const id = ++next;
      scheduled.set(id, callback);
      return id;
    },
    cancelScheduled: (id) => scheduled.delete(id),
    ...options,
  });
  return {
    dispatcher,
    advance: (ms) => {
      clock += ms;
    },
    step() {
      const [id, callback] = scheduled.entries().next().value;
      scheduled.delete(id);
      callback();
    },
    drain() {
      while (scheduled.size) this.step();
    },
  };
}

test('trusted foreground overtakes bulk while normal and background make bounded progress', async () => {
  const f = fixture(),
    order = [],
    jobs = [];
  for (const [priority, count] of [
    ['background', 4],
    ['normal', 4],
    ['interactive', 8],
  ])
    for (let i = 0; i < count; i++)
      jobs.push(f.dispatcher.run(() => order.push(priority), { priority }));
  f.step();
  assert.deepEqual(order.slice(0, 7), [
    'interactive',
    'interactive',
    'interactive',
    'interactive',
    'normal',
    'normal',
    'background',
  ]);
  assert.equal(order.length, 8, 'one turn still starts at most eight synchronous units');
  f.drain();
  await Promise.all(jobs);
  assert.equal(order.filter((x) => x === 'background').length, 4);
  assert.equal(order.filter((x) => x === 'normal').length, 4);
  assert.equal(f.dispatcher.stats().pending, 0);
});

test('a busy organization cannot place all its starts ahead of another organization', async () => {
  const f = fixture(),
    order = [],
    jobs = [];
  for (let i = 0; i < 6; i++)
    jobs.push(
      f.dispatcher.run(() => order.push(`A${i}`), {
        priority: 'interactive',
        scopeKey: 'org:synthetic-A',
      }),
    );
  for (let i = 0; i < 2; i++)
    jobs.push(
      f.dispatcher.run(() => order.push(`B${i}`), {
        priority: 'interactive',
        scopeKey: 'org:synthetic-B',
      }),
    );
  f.drain();
  await Promise.all(jobs);
  assert.deepEqual(order, ['A0', 'B0', 'A1', 'B1', 'A2', 'A3', 'A4', 'A5']);
  assert.equal(f.dispatcher.workStats().scopes, 0);
  assert.doesNotMatch(JSON.stringify(f.dispatcher.workStats()), /synthetic|org:/);
});

test('bulk cannot consume global slots reserved for calendar and manual saves', async () => {
  const f = fixture({ maxPending: 8 }),
    order = [],
    jobs = [];
  for (let i = 0; i < 4; i++)
    jobs.push(f.dispatcher.run(() => order.push('bulk'), { priority: 'normal' }));
  await assert.rejects(
    f.dispatcher.run(() => order.push('unexpected'), { priority: 'normal' }),
    (e) => e.status === 503 && e.retryAfter === 1,
  );
  for (let i = 0; i < 4; i++)
    jobs.push(f.dispatcher.run(() => order.push('save'), { priority: 'interactive' }));
  await assert.rejects(
    f.dispatcher.run(() => order.push('unexpected'), { priority: 'interactive' }),
    (e) => e.status === 503,
  );
  f.drain();
  await Promise.all(jobs);
  assert.equal(order.length, 8);
  assert.equal(order[0], 'save');
  assert.equal(f.dispatcher.workStats().interactiveReserve, 4);
});

test('per-organization reservations protect its foreground and preserve capacity for others', async () => {
  const f = fixture({ maxPending: 32, maxPendingPerScope: 4, scopeInteractiveReserve: 1 });
  const a = { scopeKey: 'org:A', priority: 'normal' },
    jobs = [];
  for (let i = 0; i < 3; i++) jobs.push(f.dispatcher.run(() => 'A', a));
  await assert.rejects(
    f.dispatcher.run(() => assert.fail('no fifth A start'), a),
    (e) => e.status === 503,
  );
  jobs.push(f.dispatcher.run(() => 'A-save', { ...a, priority: 'interactive' }));
  await assert.rejects(
    f.dispatcher.run(() => assert.fail('full scoped queue'), { ...a, priority: 'interactive' }),
    (e) => e.status === 503,
  );
  jobs.push(f.dispatcher.run(() => 'B', { scopeKey: 'org:B' }));
  assert.equal(f.dispatcher.workStats().scopes, 2);
  f.drain();
  assert.deepEqual(await Promise.all(jobs), ['A', 'A', 'A', 'A-save', 'B']);
  assert.equal(f.dispatcher.workStats().scopeRefused, 2);
  assert.equal(f.dispatcher.workStats().scopes, 0);
});

test('cancellation and elapsed deadlines prevent admitted background callbacks and release scoped slots', async () => {
  const f = fixture({ timeoutMs: 10 }),
    order = [];
  let cancelled = false;
  const cancel = assert.rejects(
    f.dispatcher.run(() => order.push('revoked'), {
      priority: 'background',
      scopeKey: 'org:A',
      cancelled: () => cancelled,
    }),
    (e) => e.status === 499,
  );
  const expires = assert.rejects(
    f.dispatcher.run(() => order.push('expired'), {
      priority: 'background',
      scopeKey: 'org:B',
    }),
    (e) => e.status === 503,
  );
  cancelled = true;
  f.advance(10);
  f.drain();
  await Promise.all([cancel, expires]);
  assert.deepEqual(order, []);
  assert.equal(f.dispatcher.workStats().scopes, 0);
  assert.equal(f.dispatcher.stats().cancelled, 1);
  assert.equal(f.dispatcher.stats().timedOut, 1);
});

test('a slow asynchronous operation owns no scoped start slot after admission', async () => {
  const f = fixture({ maxPending: 1, maxPendingPerScope: 1 });
  let finish;
  const first = f.dispatcher.run(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { scopeKey: 'org:A' },
  );
  f.step();
  assert.equal(f.dispatcher.workStats().scopes, 0);
  const second = f.dispatcher.run(() => 'calendar', { scopeKey: 'org:A', priority: 'interactive' });
  f.step();
  assert.equal(await second, 'calendar');
  finish('external provider');
  assert.equal(await first, 'external provider');
});

test('close rejects all priority lanes, clears scoped ownership and cannot restart callbacks', async () => {
  const f = fixture();
  const jobs = ['interactive', 'normal', 'background'].map((priority) =>
    assert.rejects(
      f.dispatcher.run(() => assert.fail('closed'), { priority, scopeKey: `org:${priority}` }),
      (e) => e.status === 503,
    ),
  );
  f.dispatcher.close();
  f.dispatcher.close();
  await Promise.all(jobs);
  assert.equal(f.dispatcher.stats().pending, 0);
  assert.equal(f.dispatcher.workStats().scopes, 0);
  assert.equal(f.dispatcher.stats().closed, true);
});

test('synchronous cost still yields before another organization instead of granting a fresh lane burst', async () => {
  const f = fixture(),
    order = [],
    jobs = [];
  for (const priority of ['interactive', 'normal', 'background'])
    jobs.push(
      f.dispatcher.run(
        () => {
          order.push(priority);
          f.advance(9);
        },
        { priority },
      ),
    );
  f.step();
  assert.deepEqual(order, ['interactive']);
  f.step();
  assert.deepEqual(order, ['interactive', 'normal']);
  f.step();
  assert.deepEqual(order, ['interactive', 'normal', 'background']);
  await Promise.all(jobs);
});

test('invalid or forged scheduling inputs cannot add a fourth priority or retain scope entries', async () => {
  const f = fixture();
  for (const options of [
    { priority: 'admin' },
    { scopeKey: '' },
    { scopeKey: {} },
    { scopeKey: 'x'.repeat(257) },
  ])
    await assert.rejects(
      f.dispatcher.run(() => assert.fail('invalid callback start'), options),
      TypeError,
    );
  assert.equal(f.dispatcher.stats().pending, 0);
  assert.equal(f.dispatcher.workStats().scopes, 0);
  assert.throws(
    () => createRequestDispatcher({ maxPending: 8, interactiveReserve: 8 }),
    /admission/,
  );
  assert.throws(() => createRequestDispatcher({ maxPendingPerScope: 0 }), /admission/);
});

test('background saturation leaves normal ingress capacity to reach authenticated interactive admission', async () => {
  const f = fixture({ maxPending: 8 }),
    calls = [],
    jobs = [];
  for (let i = 0; i < 2; i++)
    jobs.push(
      f.dispatcher.run(() => calls.push('background'), {
        priority: 'background',
        scopeKey: 'org:background-' + i,
      }),
    );
  await assert.rejects(
    f.dispatcher.run(() => assert.fail('background exhausted its sub-cap'), {
      priority: 'background',
      scopeKey: 'org:background-new',
    }),
    { status: 503 },
  );
  for (let i = 0; i < 2; i++) jobs.push(f.dispatcher.run(() => calls.push('ingress')));
  for (let i = 0; i < 4; i++)
    jobs.push(
      f.dispatcher.run(() => calls.push('calendar'), {
        priority: 'interactive',
        scopeKey: 'org:calendar',
      }),
    );
  assert.equal(f.dispatcher.stats().pending, 8);
  f.drain();
  await Promise.all(jobs);
  assert.equal(calls.filter((x) => x === 'ingress').length, 2);
  assert.equal(calls.filter((x) => x === 'calendar').length, 4);
  assert.equal(f.dispatcher.workStats().maxBackgroundPending, 2);
  assert.equal(f.dispatcher.workStats().scopes, 0);
});

test('an organizations background sub-cap also leaves its normal and interactive reservations available', async () => {
  const f = fixture({ maxPending: 32, maxPendingPerScope: 8 }),
    jobs = [];
  const scoped = { scopeKey: 'org:A' };
  for (let i = 0; i < 2; i++)
    jobs.push(f.dispatcher.run(() => 'A-background', { ...scoped, priority: 'background' }));
  await assert.rejects(
    f.dispatcher.run(() => assert.fail('scoped background capacity'), {
      ...scoped,
      priority: 'background',
    }),
    { status: 503 },
  );
  for (let i = 0; i < 2; i++) jobs.push(f.dispatcher.run(() => 'A-normal', scoped));
  for (let i = 0; i < 4; i++)
    jobs.push(f.dispatcher.run(() => 'A-calendar', { ...scoped, priority: 'interactive' }));
  jobs.push(f.dispatcher.run(() => 'B-background', { scopeKey: 'org:B', priority: 'background' }));
  f.drain();
  assert.equal((await Promise.all(jobs)).length, 9);
  assert.equal(f.dispatcher.workStats().maxBackgroundPendingPerScope, 2);
  assert.equal(f.dispatcher.workStats().scopes, 0);
});
