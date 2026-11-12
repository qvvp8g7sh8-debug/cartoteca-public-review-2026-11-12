const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProcessingQueue,
} = require('../src/server/infrastructure/photos/processing-queue.cjs');
const { createPhotoReader } = require('../src/server/infrastructure/photos/photo-reader.cjs');
const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('one organization cannot occupy both decoder slots or all waiting slots', async () => {
  const queue = createProcessingQueue({ maxActivePerScope: 1, maxPendingPerScope: 2 });
  const gates = Object.fromEntries(['A0', 'A1', 'A2', 'B0', 'B1'].map((id) => [id, deferred()]));
  const calls = [],
    jobs = [];
  const run = (id) =>
    queue.run(
      () => {
        calls.push(id);
        return gates[id].promise;
      },
      { scopeKey: `org:${id[0]}` },
    );
  for (const id of ['A0', 'A1', 'A2']) jobs.push(run(id));
  await assert.rejects(
    queue.run(() => assert.fail('A exceeded waiting budget'), { scopeKey: 'org:A' }),
    { status: 503 },
  );
  jobs.push(run('B0'), run('B1'));
  await turn();
  assert.deepEqual(calls, ['A0', 'B0']);
  assert.deepEqual(queue.snapshot(), { active: 2, queued: 3, concurrency: 2, capacity: 4 });
  gates.A0.resolve();
  gates.B0.resolve();
  await turn();
  assert.deepEqual(calls, ['A0', 'B0', 'A1', 'B1']);
  assert.equal(queue.snapshot().active, 2);
  gates.A1.resolve();
  gates.B1.resolve();
  await turn();
  assert.deepEqual(calls, ['A0', 'B0', 'A1', 'B1', 'A2']);
  gates.A2.resolve();
  await Promise.all(jobs);
  await turn();
  assert.equal(queue.scopeSnapshot().scopes, 0);
});

test('pending scopes rotate instead of draining one organizations whole queue', async () => {
  const queue = createProcessingQueue({ concurrency: 1, capacity: 4 });
  const gate = deferred(),
    calls = [];
  const active = queue.run(() => gate.promise, { scopeKey: 'org:initial' });
  const jobs = [];
  for (const id of ['A1', 'A2', 'B1', 'B2'])
    jobs.push(queue.run(() => calls.push(id), { scopeKey: id[0] }));
  gate.resolve();
  await active;
  await Promise.all(jobs);
  await turn();
  assert.deepEqual(calls, ['A1', 'B1', 'A2', 'B2']);
  assert.equal(queue.scopeSnapshot().scopes, 0);
});

test('a waiting timeout does not release its organizations running decoder early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const queue = createProcessingQueue({ waitMs: 5, maxActivePerScope: 1, now: () => clock });
  const gate = deferred();
  const active = queue.run(() => gate.promise, { scopeKey: 'org:A' });
  const expired = assert.rejects(
    queue.run(() => assert.fail('expired'), { scopeKey: 'org:A' }),
    { status: 503 },
  );
  await turn();
  clock = 5;
  t.mock.timers.tick(5);
  await expired;
  assert.equal(queue.snapshot().active, 1);
  assert.equal(queue.snapshot().queued, 0);
  let started = false;
  const sameScope = queue.run(
    () => {
      started = true;
    },
    { scopeKey: 'org:A' },
  );
  assert.equal(
    await queue.run(() => 'another organization', { scopeKey: 'org:B' }),
    'another organization',
  );
  assert.equal(started, false);
  gate.resolve();
  await active;
  await sameScope;
  await turn();
  assert.equal(started, true);
  assert.equal(queue.scopeSnapshot().scopes, 0);
});

test('queued cancellation and fresh authorization prevent any worker start and return scoped budgets', async () => {
  const queue = createProcessingQueue({ maxActivePerScope: 1 });
  const gate = deferred();
  const active = queue.run(() => gate.promise, { scopeKey: 'org:A' });
  let cancelled = false,
    authorized = true;
  const revoked = assert.rejects(
    queue.run(() => assert.fail('cancelled worker start'), {
      scopeKey: 'org:A',
      cancelled: () => cancelled,
    }),
    { status: 408 },
  );
  const unauthorized = assert.rejects(
    queue.run(
      () => {
        if (!authorized) throw Object.assign(Error('fresh denied'), { status: 403 });
        assert.fail('revoked worker');
      },
      { scopeKey: 'org:A' },
    ),
    { status: 403 },
  );
  cancelled = true;
  authorized = false;
  gate.resolve();
  await Promise.all([active, revoked, unauthorized]);
  await turn();
  assert.equal(queue.snapshot().active, 0);
  assert.equal(queue.snapshot().queued, 0);
  assert.equal(queue.scopeSnapshot().scopes, 0);
});

test('failed work releases its scope and unscoped legacy work preserves global concurrency', async () => {
  const queue = createProcessingQueue({ maxActivePerScope: 1 });
  const gate = deferred(),
    calls = [];
  const first = queue.run(() => {
    calls.push('one');
    return gate.promise;
  });
  const second = queue.run(() => {
    calls.push('two');
    throw Error('synthetic decode failure');
  });
  const rejected = assert.rejects(second, /synthetic decode failure/);
  await turn();
  assert.deepEqual(calls, ['one', 'two']);
  await rejected;
  assert.equal(await queue.run(() => 'next', { scopeKey: 'org:A' }), 'next');
  gate.resolve();
  await first;
  await turn();
  assert.equal(queue.scopeSnapshot().scopes, 0);
  assert.doesNotMatch(JSON.stringify(queue.scopeSnapshot()), /org:A/);
});

test('invalid scope and bounds reject before retaining work', async () => {
  const queue = createProcessingQueue();
  for (const scopeKey of ['', {}, 'a'.repeat(257)])
    await assert.rejects(
      queue.run(() => assert.fail('invalid'), { scopeKey }),
      TypeError,
    );
  assert.equal(queue.scopeSnapshot().scopes, 0);
  assert.throws(() => createProcessingQueue({ maxActivePerScope: 3 }), /configuration/);
  assert.throws(() => createProcessingQueue({ maxPendingPerScope: 5 }), /configuration/);
});

test('real photo-reader IO starts at most two reads per organization, rechecks access and releases byte budgets', async () => {
  const names = ['A1', 'A2', 'A3', 'B1', 'B2'];
  const gates = Object.fromEntries(names.map((id) => [id, deferred()]));
  const opened = [],
    packed = Buffer.alloc(40, 5);
  const io = {
    async open(filename) {
      opened.push(filename);
      return {
        async stat() {
          return { isFile: () => true, size: packed.length };
        },
        async read(target) {
          await gates[filename].promise;
          packed.copy(target);
          return { bytesRead: packed.length };
        },
        async close() {},
      };
    },
  };
  const reader = createPhotoReader({ io });
  let allowed = true;
  const read = (name) =>
    reader.read({
      filename: name,
      mime: 'image/png',
      scopeKey: `organization:${name[0]}`,
      decode: () => Buffer.from('synthetic authenticated image'),
      authorize: () => {
        if (name === 'A3' && !allowed) throw Object.assign(Error('revoked'), { status: 403 });
      },
    });
  const jobs = names.map(read);
  const rejected = assert.rejects(jobs[2], { status: 403 });
  await turn();
  assert.deepEqual(opened, ['A1', 'A2', 'B1', 'B2']);
  assert.equal(reader.stats().active, 4);
  assert.equal(reader.stats().queued, 1);
  gates.B1.resolve();
  gates.B2.resolve();
  await Promise.all([jobs[3], jobs[4]]);
  await turn();
  assert.equal(opened.includes('A3'), false);
  allowed = false;
  gates.A1.resolve();
  await jobs[0];
  await rejected;
  gates.A2.resolve();
  await jobs[1];
  await turn();
  assert.equal(opened.includes('A3'), false);
  assert.equal(reader.stats().jobs, 0);
  assert.equal(reader.stats().bytes, 0);
  assert.equal(reader.stats().scopes, 0);
});
