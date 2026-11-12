const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeCommandProxy } = require('../src/server/http/native-command-proxy.cjs');
const {
  nativeCommandOwnerCount,
} = require('../src/server/infrastructure/native-command-routes.cjs');
const { startNativeApplication } = require('../src/server/infrastructure/native-application.cjs');
const tick = () => new Promise(setImmediate);
function proxyFixture(now = () => 0) {
  const calls = [],
    active = [0, 0],
    pending = new Set(),
    leases = [];
  const proxy = createNativeCommandProxy({
    endpoint: (index) => ({ index }),
    now,
    reserve(index, ticket) {
      let complete;
      const completed = new Promise((resolve) => {
        complete = resolve;
      });
      const lease = { ticket, running: false, finish: complete };
      leases[index] = lease;
      return {
        ready: Promise.resolve(),
        completed,
        cancel() {
          if (!lease.running) complete();
        },
      };
    },
    createProxy: ({ endpoint, activeLimit, pendingLimit }) => {
      assert.equal(activeLimit, 1);
      assert.equal(pendingLimit, 0);
      const index = endpoint().index;
      return {
        run(req) {
          assert.equal(active[index], 0, 'no owner receives two active requests');
          active[index]++;
          leases[index].running = true;
          return new Promise((resolve, reject) => {
            const call = {
              index,
              id: req.id,
              finish(error, complete = true) {
                if (!pending.delete(call)) return;
                active[index]--;
                if (complete) leases[index].finish();
                error ? reject(error) : resolve();
              },
            };
            calls.push(call);
            pending.add(call);
          });
        },
        close() {
          for (const call of [...pending]) if (call.index === index) call.finish(Error('closed'));
        },
        stats: () => ({ active: active[index], activeLimit: 1, pending: 0, pendingLimit: 0 }),
      };
    },
  });
  const run = (id) => {
    const req = new EventEmitter(),
      res = new EventEmitter();
    req.id = id;
    req.pause = () => {
      req.paused = true;
    };
    return {
      req,
      res,
      result: proxy.run(req, res).then(
        () => ({ ok: true }),
        (error) => ({ error }),
      ),
    };
  };
  return { proxy, calls, run, leases };
}
test('v3 uses exactly two command owners while legacy profiles keep their topology', () => {
  assert.equal(
    nativeCommandOwnerCount({ storageBackend: 'postgres', postgresRevisionProfile: 3 }),
    2,
  );
  assert.equal(
    nativeCommandOwnerCount({ storageBackend: 'postgres', postgresRevisionProfile: 2 }),
    1,
  );
  assert.equal(
    nativeCommandOwnerCount({ storageBackend: 'sqlite', nativeCommandIsolation: true }),
    1,
  );
  assert.equal(
    nativeCommandOwnerCount({
      storageBackend: 'postgres',
      postgresRevisionProfile: 3,
      nativeCommandIsolation: false,
    }),
    0,
  );
});
test('shared FIFO picks a free owner while its sibling stays busy, retains paused bodies and forwards each request once', async () => {
  const f = proxyFixture(),
    requests = Array.from({ length: 4 }, (_, id) => f.run(id));
  await tick();
  assert.deepEqual(
    f.calls.map((c) => [c.index, c.id]),
    [
      [0, 0],
      [1, 1],
    ],
  );
  assert.equal(f.proxy.stats().pending, 2);
  assert.ok(requests.every((r) => r.req.paused));
  f.calls[1].finish();
  await tick();
  assert.deepEqual([f.calls[2].index, f.calls[2].id], [1, 2]);
  f.calls[2].finish();
  await tick();
  assert.deepEqual([f.calls[3].index, f.calls[3].id], [1, 3]);
  f.calls[3].finish();
  f.calls[0].finish();
  assert.ok((await Promise.all(requests.map((r) => r.result))).every((r) => r.ok));
  assert.equal(f.calls.length, 4);
  f.proxy.close();
});
test('the global pending bound is sixteen and canceled or expired entries never reach an owner', async () => {
  let now = 0;
  const f = proxyFixture(() => now),
    requests = Array.from({ length: 19 }, (_, id) => f.run(id));
  await tick();
  assert.equal(f.proxy.stats().active, 2);
  assert.equal(f.proxy.stats().pending, 16);
  assert.equal((await requests[18].result).error.status, 503);
  requests[2].req.aborted = true;
  requests[2].req.emit('aborted');
  assert.equal((await requests[2].result).error.status, 499);
  assert.equal(f.proxy.stats().pending, 15);
  now = 6000;
  f.calls[0].finish();
  await tick();
  assert.equal(f.proxy.stats().pending, 0);
  assert.equal(f.calls.length, 2);
  f.calls[1].finish();
  await Promise.all(requests.map((r) => r.result));
  f.proxy.close();
});
test('an interrupted outcome is never retried on the free sibling and close rejects all pending requests', async () => {
  const f = proxyFixture(),
    requests = Array.from({ length: 4 }, (_, id) => f.run(id));
  await tick();
  f.calls[0].finish(Object.assign(Error('unknown'), { outcomeUnknown: true }));
  await tick();
  assert.equal((await requests[0].result).error.outcomeUnknown, true);
  assert.equal(f.calls.filter((c) => c.id === 0).length, 1);
  f.proxy.close();
  await Promise.all(requests.map((r) => r.result));
  assert.equal(
    f.calls.some((c) => c.id === 3),
    false,
  );
  assert.equal(f.proxy.stats().pending, 0);
});
test('an aborted transport keeps its physical owner occupied until the actual handler completion ACK', async () => {
  const f = proxyFixture(),
    first = f.run(0),
    second = f.run(1),
    third = f.run(2);
  await tick();
  f.calls[0].finish(Object.assign(Error('client disconnected'), { status: 499 }), false);
  await first.result;
  await tick();
  assert.equal(f.proxy.stats().active, 2);
  assert.equal(f.proxy.stats().pending, 1);
  assert.equal(f.calls.length, 2, 'the unknown PID is not reused while its handler is running');
  f.leases[0].finish();
  await tick();
  assert.deepEqual([f.calls[2].index, f.calls[2].id], [0, 2]);
  f.calls[2].finish();
  f.calls[1].finish();
  await Promise.all([second.result, third.result]);
  f.proxy.close();
});
test('a reservation ACK deadline cancels an unstarted ticket without forwarding or losing the owner', async () => {
  let forwarded = 0,
    canceled = 0,
    complete;
  const proxy = createNativeCommandProxy({
    endpoint: () => ({}),
    waitMs: 20,
    reserve() {
      return {
        ready: new Promise(() => {}),
        completed: new Promise((resolve) => {
          complete = resolve;
        }),
        cancel() {
          canceled++;
          complete();
        },
      };
    },
    createProxy: () => ({
      run() {
        forwarded++;
        return Promise.resolve();
      },
      close() {},
      stats: () => ({ active: 0 }),
    }),
  });
  const req = new EventEmitter(),
    res = new EventEmitter();
  req.pause = () => {};
  const result = proxy.run(req, res).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await result).status, 504);
  assert.equal(forwarded, 0);
  assert.equal(canceled, 1);
  assert.equal(proxy.stats().active, 0);
  proxy.close();
});
function fakeOwner({ failSecond = false, holdFirst = false, diagnostic = null } = {}) {
  const children = [],
    heaps = [];
  let sequence = 1700;
  const spawn = (_file, _args, options) => {
    const child = new EventEmitter();
    child.pid = sequence++;
    child.connected = true;
    heaps.push(options.execArgv[0]);
    child.send = (message, callback) => {
      callback?.();
      if (message === 'stop') {
        child.connected = false;
        return process.nextTick(() => child.emit('exit', 0, null));
      }
      if (message.type !== 'start') {
        child.observed = message;
        return;
      }
      child.start = message;
      const announce = () =>
        child.emit('message', {
          ...message,
          type: failSecond && message.commandIndex === 1 ? 'failed' : 'ready',
          ...(diagnostic ? { diagnostic } : {}),
          pid: child.pid,
          port: message.role === 'background' ? null : child.pid,
          backgroundActive: message.role === 'background',
          providers: {
            providers: { telegram: { configured: false }, max: { configured: false } },
            telegram: {},
          },
        });
      if (holdFirst && message.role === 'command' && message.commandIndex === 0)
        child.announce = announce;
      else process.nextTick(announce);
    };
    child.kill = () => process.nextTick(() => child.emit('exit', null, 'SIGKILL'));
    children.push(child);
    return child;
  };
  return { children, heaps, spawn };
}
test('the second command constructor starts only after the first is ready; steady-state still owns both', async () => {
  const f = fakeOwner({ holdFirst: true });
  const ready = startNativeApplication({
    config: { production: false, storageBackend: 'postgres', postgresRevisionProfile: 3 },
    spawn: f.spawn,
  });
  await tick();
  assert.deepEqual(
    f.children.map((child) => child.start.role),
    ['background', 'web', 'command'],
  );
  assert.equal(f.children[2].start.commandIndex, 0);
  f.children[2].announce();
  const owner = await ready;
  assert.equal(f.children.length, 4);
  assert.equal(f.children[3].start.commandIndex, 1);
  assert.ok(owner.stats().commands.every((record) => record.ready));
  await owner.close();
});
test('v3 readiness owns all four PIDs with distinct command capabilities; status reaches both and death never restarts', async () => {
  const f = fakeOwner();
  const owner = await startNativeApplication({
    config: { production: false, storageBackend: 'postgres', postgresRevisionProfile: 3 },
    spawn: f.spawn,
  });
  try {
    assert.equal(f.children.length, 4);
    assert.equal(owner.stats().commands.length, 2);
    assert.equal(new Set(owner.stats().commands.map((r) => r.pid)).size, 2);
    assert.deepEqual(f.heaps, [
      '--max-old-space-size=256',
      '--max-old-space-size=768',
      '--max-old-space-size=768',
      '--max-old-space-size=768',
    ]);
    assert.notEqual(
      owner.commandEndpoint(0).transportToken,
      owner.commandEndpoint(1).transportToken,
    );
    assert.equal(owner.commandEndpoints().length, 2);
    assert.ok(
      owner
        .commandEndpoints()
        .every((endpoint) => !JSON.stringify(owner.stats()).includes(endpoint.transportToken)),
    );
    const web = f.children.find((child) => child.start.role === 'web');
    web.emit('message', {
      ...web.start,
      type: 'status',
      providers: { providers: { telegram: {}, max: {} }, telegram: {} },
    });
    assert.ok(
      f.children
        .filter((child) => child.start.role === 'command')
        .every((child) => child.observed?.type === 'providers'),
    );
    const failed = new Promise((resolve) => owner.once('failed', resolve));
    f.children[3].emit('exit', null, 'SIGKILL');
    await failed;
    await owner.close();
    assert.equal(f.children.length, 4);
    assert.ok(owner.stats().commands.every((record) => record.exited));
  } finally {
    await owner.close();
  }
});
test('parent accepts completion only from the reserved PID, lifetime nonce and exact per-forward ticket', async () => {
  const { randomUUID } = require('node:crypto');
  const f = fakeOwner();
  const owner = await startNativeApplication({
    config: { production: false, storageBackend: 'postgres', postgresRevisionProfile: 3 },
    spawn: f.spawn,
  });
  try {
    const child = f.children[2],
      ticket = randomUUID(),
      lease = owner.reserveCommand(0, ticket);
    const message = {
      protocol: child.start.protocol,
      nonce: child.start.nonce,
      role: 'command',
      pid: child.pid,
      ticket,
    };
    child.emit('message', { ...message, type: 'command-reserved', accepted: true });
    await lease.ready;
    let completed = false;
    lease.completed.then(() => {
      completed = true;
    });
    for (const invalid of [{ pid: child.pid + 1 }, { nonce: 'wrong' }, { ticket: randomUUID() }])
      child.emit('message', { ...message, ...invalid, type: 'command-finished' });
    await tick();
    assert.equal(completed, false);
    child.emit('message', { ...message, type: 'command-finished' });
    await lease.completed;
    assert.equal(completed, true);
    const next = owner.reserveCommand(0, randomUUID());
    child.emit('message', { ...message, type: 'command-finished' });
    await tick();
    await owner.close();
    await assert.rejects(next.ready);
  } finally {
    await owner.close();
  }
});
test('parent startup failure exposes only the actual role and closed diagnostic categories', async () => {
  const privateText = 'synthetic-key SELECT private FROM records';
  const f = fakeOwner({
    failSecond: true,
    diagnostic: {
      role: 'web',
      phase: 'composition',
      cause: 'POSTGRES_BUSY',
      sql: privateText,
      stack: privateText,
    },
  });
  await assert.rejects(
    startNativeApplication({
      config: { production: false, storageBackend: 'postgres', postgresRevisionProfile: 3 },
      spawn: f.spawn,
    }),
    (error) => {
      assert.deepEqual(error.diagnostic, {
        role: 'command',
        phase: 'composition',
        cause: 'POSTGRES_BUSY',
      });
      assert.equal(JSON.stringify(error).includes(privateText), false);
      return true;
    },
  );
  assert.ok(f.children.every((child) => !child.connected));
});
test('failure of the second command child denies readiness and closes every sibling', async () => {
  const f = fakeOwner({ failSecond: true });
  await assert.rejects(
    startNativeApplication({
      config: { production: false, storageBackend: 'postgres', postgresRevisionProfile: 3 },
      spawn: f.spawn,
    }),
    /unavailable/,
  );
  assert.equal(f.children.length, 4);
  assert.ok(f.children.every((child) => !child.connected));
});
