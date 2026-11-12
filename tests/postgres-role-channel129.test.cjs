const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const v8 = require('node:v8');
const { Int32Array, Atomics } = globalThis;
const {
  createProcessRoleChannel,
} = require('../src/server/infrastructure/postgres/process-role-channel.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const { digest } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
const uuid = (n) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const OWNER = uuid(1),
  TOKEN = uuid(2);
const marker = Object.freeze({
  version: 1,
  backend: 'postgres',
  platformStoreId: uuid(3),
  migrationId: uuid(4),
});
const busy = (fields = {}) =>
  Object.assign(Error('Synthetic closed technical error.'), {
    code: 'POSTGRES_ROLE_AUTHORITY_BUSY',
    leaseUnchanged: true,
    transactionOpen: false,
    outcomeUnknown: false,
    channelPoisoned: false,
    ...fields,
  });
function clockOf(t) {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  return {
    set(value) {
      now = value;
    },
    advance(value) {
      now += value;
    },
  };
}
async function fixture(t, clock, options = {}) {
  const control = {
    ready: true,
    closed: false,
    exited: false,
    poisoned: false,
    calls: [],
    closeSyncCalls: 0,
    closeCalls: 0,
  };
  let settings;
  const closing = Promise.resolve();
  const transport = {
    ready: () => (options.startupError ? Promise.reject(options.startupError) : Promise.resolve()),
    request(command, flags) {
      control.calls.push({ command: { ...command }, flags: { ...flags } });
      if (control.run) return control.run(command);
      return command.op === 'acquire' ? TOKEN : true;
    },
    stats: () => ({
      ready: control.ready,
      closed: control.closed,
      exited: control.exited,
      poisoned: control.poisoned,
      calls: control.calls.length,
    }),
    closeSync() {
      control.closeSyncCalls++;
      control.closed = true;
      control.ready = false;
    },
    close() {
      control.closeCalls++;
      control.closed = true;
      control.ready = false;
      return closing;
    },
  };
  const channel = await createProcessRoleChannel({
    connection: { host: '127.0.0.1', password: 'synthetic-only' },
    marker,
    createTransport(value) {
      settings = value;
      return transport;
    },
  });
  t.after(() => channel.close());
  return { channel, control, settings, clock, transport };
}

test('role channel sends a compact immutable lineage profile and closed commands without SQL/scope overrides', async (t) => {
  const clock = clockOf(t),
    f = await fixture(t, clock);
  assert.deepEqual(f.settings.roleProfile, {
    platformStoreId: marker.platformStoreId,
    migrationId: marker.migrationId,
    markerHash: digest(marker),
  });
  assert.equal(Object.isFrozen(f.settings.roleProfile), true);
  assert.equal(f.settings.maxCommandBytes, 8192);
  assert.equal(f.settings.maxReplyBytes, 16384);
  assert.equal(f.settings.resourceLimits.maxOldGenerationSizeMb, 32);
  assert.equal(Object.hasOwn(f.settings, 'onFatal'), false);
  assert.match(f.settings.filename, /process-role-worker\.cjs$/);
  assert.equal(f.channel.durationMs, 60000);
  assert.equal(f.channel.isCurrent(), false);
  assert.equal(f.channel.acquire('background', OWNER), TOKEN);
  assert.equal(f.channel.renew(OWNER, TOKEN), true);
  assert.equal(f.channel.release(OWNER, TOKEN), true);
  assert.deepEqual(f.control.calls, [
    { command: { op: 'acquire', role: 'background', owner: OWNER }, flags: { mutating: true } },
    { command: { op: 'renew', owner: OWNER, token: TOKEN }, flags: { mutating: true } },
    { command: { op: 'release', owner: OWNER, token: TOKEN }, flags: { mutating: true } },
  ]);
  const stats = JSON.stringify(f.channel.stats());
  assert.equal(stats.includes(OWNER), false);
  assert.equal(stats.includes(TOKEN), false);
  assert.equal(stats.includes('synthetic-only'), false);
});

test('acquire confirmation begins before RPC and expires monotonically despite a backwards wall clock', async (t) => {
  const clock = clockOf(t),
    f = await fixture(t, clock);
  t.mock.method(Date, 'now', () => -1000000);
  f.control.run = () => {
    clock.advance(1200);
    return TOKEN;
  };
  assert.equal(f.channel.acquire('background', OWNER), TOKEN);
  assert.equal(f.channel.stats().monotonicRemainingMs, 58800);
  clock.set(60999);
  const before = f.control.calls.length;
  assert.equal(f.channel.isCurrent(), true);
  clock.set(61000);
  assert.equal(f.channel.isCurrent(), false);
  assert.equal(f.control.calls.length, before, 'isCurrent never performs RPC');
  assert.equal(f.channel.renew(OWNER, TOKEN), false);
  assert.equal(f.control.calls.length, before, 'expired proof cannot renew/reacquire');
  assert.throws(() => f.channel.acquire('background', OWNER), {
    code: 'POSTGRES_ROLE_AUTHORITY_LOST',
  });
});

test('successful renew uses pre-RPC time and matching acquire never extends existing proof', async (t) => {
  const clock = clockOf(t),
    f = await fixture(t, clock);
  f.channel.acquire('combined', OWNER);
  clock.set(11000);
  assert.equal(f.channel.acquire('combined', OWNER), TOKEN);
  assert.equal(f.channel.stats().monotonicRemainingMs, 50000);
  f.control.run = () => {
    clock.advance(1500);
    return true;
  };
  assert.equal(f.channel.renew(OWNER, TOKEN), true);
  assert.equal(f.channel.stats().monotonicRemainingMs, 58500);
  clock.set(70999);
  assert.equal(f.channel.isCurrent(), true);
  clock.set(71000);
  assert.equal(f.channel.isCurrent(), false);
});

test('only exact clean BUSY retains old deadline without retrying or extending the lease', async (t) => {
  const clock = clockOf(t),
    f = await fixture(t, clock);
  f.channel.acquire('background', OWNER);
  clock.set(11000);
  const error = busy();
  f.control.run = () => {
    clock.advance(250);
    throw error;
  };
  assert.throws(
    () => f.channel.renew(OWNER, TOKEN),
    (value) => value === error,
  );
  assert.equal(f.channel.isCurrent(), true);
  assert.equal(f.channel.stats().monotonicRemainingMs, 49750);
  assert.equal(f.control.calls.length, 2, 'no internal mutation retry');
  clock.set(61000);
  assert.equal(f.channel.isCurrent(), false);
  assert.equal(f.channel.renew(OWNER, TOKEN), false);
  assert.equal(f.control.calls.length, 2);
});

test('missing or contradictory BUSY proof and unknown outcomes invalidate current authority', async (t) => {
  const clock = clockOf(t);
  const variants = [
    { leaseUnchanged: undefined },
    { transactionOpen: true },
    { outcomeUnknown: undefined },
    { outcomeUnknown: true },
    { channelPoisoned: true },
    { code: 'POSTGRES_BUSY' },
  ];
  for (const fields of variants) {
    clock.set(1000);
    const f = await fixture(t, clock);
    f.channel.acquire('background', OWNER);
    const error = busy(fields);
    f.control.run = () => {
      throw error;
    };
    assert.throws(
      () => f.channel.renew(OWNER, TOKEN),
      (value) => value === error,
    );
    assert.equal(f.channel.isCurrent(), false);
    assert.equal(f.channel.renew(OWNER, TOKEN), false);
    assert.equal(f.control.calls.length, 2);
  }
});

test('wrong live owner/token cannot disturb a valid lease or submit SQL commands', async (t) => {
  const clock = clockOf(t),
    f = await fixture(t, clock);
  f.channel.acquire('background', OWNER);
  const remaining = f.channel.stats().monotonicRemainingMs;
  for (const method of ['renew', 'release']) {
    assert.equal(f.channel[method](uuid(9), TOKEN), false);
    assert.equal(f.channel[method](OWNER, uuid(10)), false);
  }
  assert.equal(f.control.calls.length, 1);
  assert.equal(f.channel.isCurrent(), true);
  assert.equal(f.channel.stats().monotonicRemainingMs, remaining);
  assert.equal(f.channel.renew(OWNER, TOKEN), true);
});

test('transport poison/loss is visible without IO and prevents subsequent renewal', async (t) => {
  const clock = clockOf(t);
  for (const field of ['poisoned', 'exited']) {
    const f = await fixture(t, clock);
    f.channel.acquire('background', OWNER);
    f.control[field] = true;
    assert.equal(f.channel.isCurrent(), false);
    assert.equal(f.channel.renew(OWNER, TOKEN), false);
    assert.equal(f.control.calls.length, 1);
  }
});

test('late positive renew ACK cannot revive an already expired local deadline', async (t) => {
  const clock = clockOf(t),
    f = await fixture(t, clock);
  f.channel.acquire('background', OWNER);
  clock.set(60000);
  f.control.run = () => {
    clock.advance(1000);
    return true;
  };
  assert.equal(f.channel.renew(OWNER, TOKEN), false);
  assert.equal(f.channel.isCurrent(), false);
  assert.equal(f.control.calls.length, 2);
  assert.equal(f.channel.renew(OWNER, TOKEN), false);
  assert.equal(f.control.calls.length, 2);
});

test('false renewal ACK and invalid acquire token fail closed with no replay', async (t) => {
  const clock = clockOf(t),
    f = await fixture(t, clock);
  f.channel.acquire('background', OWNER);
  f.control.run = () => false;
  assert.equal(f.channel.renew(OWNER, TOKEN), false);
  assert.equal(f.channel.isCurrent(), false);
  const bad = await fixture(t, clock);
  bad.control.run = () => ({ token: TOKEN, sql: 'not-a-wire-result' });
  assert.throws(() => bad.channel.acquire('background', OWNER), {
    code: 'POSTGRES_ROLE_CHANNEL_PROTOCOL',
  });
  assert.equal(bad.channel.isCurrent(), false);
  assert.equal(bad.control.calls.length, 1);
});

test('normal closeSync and emergency close discard local proof before transport shutdown', async (t) => {
  const clock = clockOf(t),
    normal = await fixture(t, clock);
  normal.channel.acquire('background', OWNER);
  normal.channel.closeSync();
  normal.channel.closeSync();
  assert.equal(normal.control.closeSyncCalls, 1);
  assert.equal(normal.channel.isCurrent(), false);
  await normal.channel.close();
  assert.equal(normal.control.closeCalls, 1);
  const emergency = await fixture(t, clock);
  emergency.channel.acquire('background', OWNER);
  const pending = emergency.channel.close();
  assert.equal(emergency.channel.isCurrent(), false);
  assert.equal(emergency.control.closeSyncCalls, 0);
  await pending;
  assert.equal(emergency.control.closeCalls, 1);
  assert.equal(emergency.control.calls.length, 1, 'close alone never emits a release mutation');
});

test('startup rejection closes its transport and preserves the original closed error', async () => {
  const error = Object.assign(Error('Synthetic startup failure.'), {
    code: 'POSTGRES_ROLE_SCHEMA_INVALID',
  });
  let closed = 0;
  await assert.rejects(
    createProcessRoleChannel({
      connection: { host: '127.0.0.1' },
      marker,
      createTransport: () => ({
        ready: () => Promise.reject(error),
        close: () => {
          closed++;
          return Promise.resolve();
        },
      }),
    }),
    (value) => value === error,
  );
  assert.equal(closed, 1);
});

// Exercise the production v8/SAB decoder; only the physical worker is replaced.
function protocol(t, error) {
  let worker;
  const transport = createTransport({
    timeoutMs: 1000,
    startupMs: 1000,
    workerFactory(file, options) {
      worker = new EventEmitter();
      const state = new Int32Array(options.workerData.mailbox, 0, 4),
        inline = new Uint8Array(options.workerData.mailbox, 16);
      let exited = false;
      const exit = () => {
        if (exited) return;
        exited = true;
        options.workerData.replyPort.close();
        worker.emit('exit', 0);
      };
      worker.terminate = () => {
        queueMicrotask(exit);
        return Promise.resolve(0);
      };
      worker.postMessage = (message) => {
        if (message.close === true) {
          queueMicrotask(exit);
          return;
        }
        const command = v8.deserialize(Buffer.from(message.bytes));
        const reply =
          command.op === 'renew'
            ? { id: message.id, ok: false, error }
            : { id: message.id, ok: true, value: null };
        const bytes = v8.serialize(reply);
        assert.ok(bytes.length <= inline.length);
        inline.set(bytes);
        Atomics.store(state, 2, message.id);
        Atomics.store(state, 1, bytes.length);
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
        if (command.op === 'shutdown') queueMicrotask(exit);
      };
      queueMicrotask(() => worker.emit('message', { type: 'ready' }));
      return worker;
    },
  });
  t.after(() => transport.close());
  return transport;
}

test('real SAB protocol preserves explicit false clean-BUSY flags and stays usable', async (t) => {
  const transport = protocol(t, {
    code: 'POSTGRES_ROLE_AUTHORITY_BUSY',
    leaseUnchanged: true,
    transactionOpen: false,
    outcomeUnknown: false,
    channelPoisoned: false,
  });
  await transport.ready();
  assert.throws(
    () => transport.request({ op: 'renew' }, { mutating: true }),
    (error) => {
      assert.equal(error.postgres, true);
      assert.equal(error.code, 'POSTGRES_ROLE_AUTHORITY_BUSY');
      assert.equal(error.leaseUnchanged, true);
      assert.equal(error.transactionOpen, false);
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.channelPoisoned, false);
      assert.notEqual(error.retryableBeforeBegin, true);
      return true;
    },
  );
  assert.equal(transport.stats().poisoned, false);
  assert.equal(transport.request({ op: 'technical-probe' }), null);
  transport.closeSync();
  await transport.close();
  assert.equal(transport.stats().exited, true);
});

test('real SAB protocol does not mint unchanged proof for another code or an incomplete BUSY reply', async (t) => {
  for (const fields of [
    { code: 'POSTGRES_BUSY' },
    { transactionOpen: undefined },
    { leaseUnchanged: undefined },
  ]) {
    const transport = protocol(t, {
      code: 'POSTGRES_ROLE_AUTHORITY_BUSY',
      leaseUnchanged: true,
      transactionOpen: false,
      outcomeUnknown: false,
      channelPoisoned: false,
      ...fields,
    });
    await transport.ready();
    assert.throws(
      () => transport.request({ op: 'renew' }, { mutating: true }),
      (error) => {
        assert.notEqual(error.leaseUnchanged, true);
        assert.notEqual(error.outcomeUnknown, false);
        return true;
      },
    );
    transport.closeSync();
    await transport.close();
  }
});
