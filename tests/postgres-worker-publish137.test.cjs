// Inspect the actual driver publication function in a pure VM; no SQL, workers or providers.
'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm'),
  v8 = require('node:v8');
const source = fs.readFileSync(
  path.join(__dirname, '../src/server/infrastructure/postgres/driver-worker.cjs'),
  'utf8',
);
const first = source.indexOf('function publish('),
  last = source.indexOf('function errorShape(');
assert.ok(first >= 0 && last > first);
const body = source.slice(first, last);

function fixture({
  port = false,
  maxReplyBytes = 8192,
  failSerialize = false,
  failPost = false,
  onNotify,
} = {}) {
  const state = new Int32Array(new SharedArrayBuffer(16)),
    inline = new Uint8Array(port ? 8 : 8192),
    payload = { mutating: true, plan: { values: [Buffer.alloc(1024 * 1024, 7)] } },
    events = [],
    transfers = [];
  const context = {
    active: { id: 7, finished: false, command: payload },
    memorySampling: { publishIfDue: () => events.push(['memory', context.active.command]) },
    state,
    inline,
    transaction: true,
    Uint8Array,
    v8: {
      serialize: (value) => {
        events.push(['serialize', context.active.command]);
        if (failSerialize) throw Error('synthetic serialize failure');
        return v8.serialize(value);
      },
    },
    workerData: {
      maxReplyBytes,
      replyPort: {
        postMessage: (value, transfer) => {
          events.push(['post', context.active.command]);
          if (failPost) throw Error('synthetic post failure');
          transfers.push({ value, transfer });
        },
      },
    },
    Atomics: {
      store: (...args) => {
        events.push(['store', context.active.command]);
        return Atomics.store(...args);
      },
      notify: (...args) => {
        events.push(['notify', context.active.command]);
        const result = Atomics.notify(...args);
        onNotify?.(context);
        return result;
      },
    },
  };
  vm.createContext(context);
  new vm.Script(body).runInContext(context);
  const published = () => {
    const bytes = Atomics.load(state, 1);
    return v8.deserialize(
      port ? Buffer.from(transfers[0].value.bytes) : Buffer.from(inline.subarray(0, bytes)),
    );
  };
  return { context, payload, events, transfers, published };
}

test('inline publication releases the last large payload only after notification; tombstone stays', () => {
  const f = fixture();
  f.context.publish(7, { ok: true, value: 42 });
  assert.equal(f.context.active.command, null);
  assert.equal(f.context.active.id, 7);
  assert.equal(f.context.active.finished, true);
  assert.ok(f.events.every(([, command]) => command === f.payload));
  assert.equal(f.events.at(-2)[0], 'memory');
  assert.equal(f.events.at(-1)[0], 'notify');
  assert.equal(f.published().value, 42);
});

test('transferred publication preserves reply and transfer ownership shape', () => {
  const f = fixture({ port: true });
  f.context.publish(7, { ok: true, value: 'reply'.repeat(30) });
  assert.equal(f.context.active.command, null);
  assert.equal(f.transfers.length, 1);
  assert.equal(f.transfers[0].transfer[0], f.transfers[0].value.bytes);
  assert.equal(f.published().value, 'reply'.repeat(30));
});

test('oversized mutating reply derives outcomeUnknown before clearing command', () => {
  const f = fixture({ maxReplyBytes: 1024 });
  f.context.publish(7, { ok: true, value: 'x'.repeat(4096) });
  const reply = f.published();
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'POSTGRES_REPLY_TOO_LARGE');
  assert.equal(reply.error.outcomeUnknown, true);
  assert.equal(reply.error.transactionOpen, true);
  assert.equal(f.context.active.command, null);
});

test('stale id leaves the live request and mailbox unchanged', () => {
  const f = fixture();
  f.context.publish(8, { ok: true });
  assert.equal(f.context.active.command, f.payload);
  assert.equal(f.context.active.finished, false);
  assert.equal(f.events.length, 0);
  assert.equal(Atomics.load(f.context.state, 0), 0);
});

test('duplicate publication does not publish twice or change tombstone', () => {
  const f = fixture();
  f.context.publish(7, { ok: true, value: 'first' });
  const count = f.events.length;
  f.context.publish(7, { ok: true, value: 'duplicate' });
  assert.equal(f.events.length, count);
  assert.equal(f.published().value, 'first');
  assert.equal(f.context.active.command, null);
});

test('a newer active RPC cannot be cleared by the completed publication', () => {
  const newer = { id: 8, finished: false, command: { mutating: false, marker: 'newer' } };
  const f = fixture({
    onNotify: (context) => {
      context.active = newer;
    },
  });
  f.context.publish(7, { ok: true });
  assert.equal(f.context.active, newer);
  assert.equal(f.context.active.command.marker, 'newer');
});

test('serialization failure retains error context and does not signal publication', () => {
  const f = fixture({ failSerialize: true });
  assert.throws(() => f.context.publish(7, { ok: true }), /synthetic serialize/);
  assert.equal(f.context.active.command, f.payload);
  assert.equal(Atomics.load(f.context.state, 0), 0);
  assert.equal(
    f.events.some(([name]) => name === 'notify'),
    false,
  );
});

test('post failure retains error context and does not signal publication or retry', () => {
  const f = fixture({ port: true, failPost: true });
  assert.throws(() => f.context.publish(7, { ok: true }), /synthetic post/);
  assert.equal(f.context.active.command, f.payload);
  assert.equal(Atomics.load(f.context.state, 0), 0);
  assert.equal(f.events.filter(([name]) => name === 'post').length, 1);
  assert.equal(
    f.events.some(([name]) => name === 'notify'),
    false,
  );
});
