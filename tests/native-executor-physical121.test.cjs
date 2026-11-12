const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { setImmediate: turn } = require('node:timers/promises');
const { createNativeExecutor } = require('../src/server/infrastructure/native-executor.cjs');

function fixture(t) {
  const sent = [];
  const executor = createNativeExecutor({
    filename: path.join(__dirname, 'helpers/native-executor-worker.cjs'),
    concurrency: 2,
    maxPendingBytes: 1024,
    maxRequestBytes: 1024,
    maxResponseBytes: 1024,
    maxRetainedBytes: 4096,
    timeoutMs: 30000,
    workerFactory(filename, options) {
      const worker = new Worker(filename, options),
        post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        sent.push({ kind: message.kind, cancel: message.cancel });
        return post(message, transfer);
      };
      return worker;
    },
  });
  t.after(async () => {
    for (const message of sent) {
      const word = new Int32Array(message.cancel);
      Atomics.store(word, 0, 3);
      Atomics.notify(word, 0);
    }
    await executor.close({ force: true });
  });
  return { executor, sent };
}
async function entered(sent) {
  const until = performance.now() + 10000;
  for (;;) {
    const message = sent.find((row) => row.kind === 'blocking-read');
    if (message && Atomics.load(new Int32Array(message.cancel), 0) === 2)
      return new Int32Array(message.cancel);
    if (performance.now() >= until)
      throw Error('Real worker did not enter its controlled native wait');
    await turn();
  }
}
function request(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
        );
      })
      .on('error', reject);
  });
}

test(
  'actual blocked worker cannot block a synthetic HTTP gateway or the second read worker',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t);
    await f.executor.ready();
    const server = http.createServer((req, res) => res.end('gateway responsive'));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const first = f.executor.run({ kind: 'blocking-read' }, { affinityKey: 'same-org' });
    void first.catch(() => {});
    const word = await entered(f.sent);
    const second = f.executor.run({ kind: 'query' }, { affinityKey: 'same-org' });
    void second.catch(() => {});
    const [gateway, read] = await Promise.all([
      request(`http://127.0.0.1:${server.address().port}/synthetic`),
      second,
    ]);
    assert.deepEqual(gateway, { status: 200, body: 'gateway responsive' });
    assert.equal(read.body.toString(), '{"ok":true}');
    assert.equal(Atomics.load(word, 0), 2, 'the first real worker is still inside native wait');
    assert.equal(f.executor.stats().active, 1);
    read.release();
    Atomics.store(word, 0, 3);
    Atomics.notify(word, 0);
    const completed = await first;
    assert.equal(completed.body.toString(), '{"released":true}');
    completed.release();
  },
);

test(
  'actual read cancellation returns credit only after terminal worker settlement or exit',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t),
      abort = new AbortController();
    await f.executor.ready();
    const pending = assert.rejects(
      f.executor.run(
        { kind: 'blocking-read', payload: Buffer.from('raw') },
        { signal: abort.signal },
      ),
      (error) => error.code === 'NATIVE_CANCELLED' && !error.outcomeUnknown,
    );
    const word = await entered(f.sent);
    abort.abort();
    assert.equal(f.executor.stats().active, 1);
    assert.equal(f.executor.stats().inputBytes, 3);
    assert.equal(f.executor.stats().reservedBytes, 1024);
    Atomics.notify(word, 0);
    await pending;
    assert.equal(f.executor.stats().active, 0);
    assert.equal(f.executor.stats().inputBytes, 0);
    assert.equal(f.executor.stats().reservedBytes, 0);
    assert.equal(f.executor.stats().started, 1, 'no command was automatically replayed');
  },
);
