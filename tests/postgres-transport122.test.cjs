const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const filename = path.join(__dirname, 'helpers/postgres-transport122.cjs');
function fixture(t, options = {}) {
  const transport = createTransport({ filename, timeoutMs: 1000, ...options });
  t.after(() => transport.close());
  return transport;
}

test(
  'physical sync RPC receives inline and transferred large v8 frames with exact typed values',
  { timeout: 15000 },
  async (t) => {
    const transport = fixture(t);
    await transport.ready();
    const small = { integer: 9007199254740993n, bytes: Buffer.from('synthetic cipher'), nil: null };
    assert.deepEqual(transport.request({ op: 'echo', value: small }), small);
    const large = Buffer.alloc(180000, 17);
    assert.deepEqual(transport.request({ op: 'echo', value: large }), large);
    assert.deepEqual(transport.stats(), {
      ready: true,
      closed: false,
      exited: false,
      poisoned: false,
      active: 0,
      calls: 2,
    });
    transport.closeSync();
    await transport.close();
    assert.equal(transport.stats().exited, true);
  },
);

test(
  'oversized commands fail before worker admission and the channel remains usable',
  { timeout: 15000 },
  async (t) => {
    const transport = fixture(t, { maxCommandBytes: 1024 });
    await transport.ready();
    assert.throws(() => transport.request({ op: 'echo', value: Buffer.alloc(2048) }), {
      code: 'POSTGRES_COMMAND_TOO_LARGE',
    });
    assert.equal(transport.stats().calls, 0);
    assert.equal(transport.request({ op: 'echo', value: 1 }), 1);
  },
);

test(
  'wrong request identifier poisons channel and never admits another command',
  { timeout: 15000 },
  async (t) => {
    const transport = fixture(t);
    await transport.ready();
    assert.throws(() => transport.request({ op: 'wrong-id' }, { mutating: true }), {
      code: 'POSTGRES_PROTOCOL_ERROR',
      outcomeUnknown: true,
    });
    assert.equal(transport.stats().poisoned, true);
    assert.throws(() => transport.request({ op: 'echo', value: 1 }), {
      code: 'POSTGRES_PROTOCOL_ERROR',
    });
    assert.equal(transport.stats().calls, 1);
  },
);

test(
  'active mutation RPC timeout retains physical activity until actual worker exit and does not replay',
  { timeout: 15000 },
  async (t) => {
    const transport = fixture(t, { timeoutMs: 50, startupMs: 3000 });
    await transport.ready();
    assert.throws(() => transport.request({ op: 'hang', mutating: true }, { mutating: true }), {
      code: 'POSTGRES_RPC_TIMEOUT',
      outcomeUnknown: true,
    });
    assert.equal(transport.stats().active, 1);
    assert.equal(transport.stats().exited, false);
    await transport.close();
    assert.equal(transport.stats().active, 0);
    assert.equal(transport.stats().calls, 1);
  },
);

test(
  'startup timeout rejects readiness before an uncooperative fake worker exits',
  { timeout: 15000 },
  async () => {
    let worker;
    const transport = createTransport({
      startupMs: 25,
      workerFactory(file, options) {
        worker = new EventEmitter();
        worker.postMessage = () => {};
        worker.terminate = () => new Promise(() => {});
        worker.once('exit', () => options.workerData.replyPort.close());
        return worker;
      },
    });
    try {
      await assert.rejects(transport.ready(), { code: 'POSTGRES_STARTUP_TIMEOUT' });
      await assert.rejects(transport.ready(), { code: 'POSTGRES_STARTUP_TIMEOUT' });
      assert.equal(transport.stats().exited, false);
      const closing = transport.close();
      let finished = false;
      closing.then(() => {
        finished = true;
      });
      await Promise.resolve();
      assert.equal(finished, false);
      worker.emit('exit', 1);
      await closing;
      assert.equal(transport.stats().exited, true);
    } finally {
      worker.emit('exit', 1);
      await transport.close();
    }
  },
);

test(
  'fatal callback is deferred until the RPC stack unwinds, emitted once, and contains no payload',
  { timeout: 15000 },
  async (t) => {
    const events = [];
    const transport = fixture(t, { onFatal: (event) => events.push(event) });
    await transport.ready();
    assert.throws(
      () =>
        transport.request(
          { op: 'wrong-id', secret: 'synthetic-private-payload' },
          { mutating: true },
        ),
      { code: 'POSTGRES_PROTOCOL_ERROR' },
    );
    assert.equal(events.length, 0);
    assert.throws(() => transport.request({ op: 'echo' }), { code: 'POSTGRES_PROTOCOL_ERROR' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(events, [{ code: 'POSTGRES_PROTOCOL_ERROR', outcomeUnknown: true }]);
    assert.equal(JSON.stringify(events).includes('synthetic-private-payload'), false);
  },
);
