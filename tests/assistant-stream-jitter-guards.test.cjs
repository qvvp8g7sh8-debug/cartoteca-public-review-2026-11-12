const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createSpeechGeneration,
} = require('../src/server/modules/assistant/speech/speech-generation.cjs');
const {
  createSpeechOutput,
  streamTimewebSpeech,
} = require('../src/server/modules/assistant/providers/timeweb/timeweb-speech-stream.cjs');
function fixture() {
  const req = new EventEmitter(),
    res = new EventEmitter();
  const state = { allowed: true, guards: 0, reads: 0, cancelCalls: 0 };
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    chunks: [],
    writeHead() {
      this.headersSent = true;
    },
    write(bytes) {
      this.chunks.push(Buffer.from(bytes));
      return true;
    },
    end() {
      this.writableFinished = true;
    },
  });
  const output = createSpeechOutput(
    { req, res },
    () => {
      state.guards++;
      if (!state.allowed) throw Object.assign(Error('Synthetic scope revoked'), { status: 403 });
    },
    2000,
    'pcm',
  );
  return {
    state,
    req,
    res,
    output,
    run(read) {
      return streamTimewebSpeech({
        provider: { model: 'synthetic', voice: 'synthetic' },
        key: 'synthetic',
        payload: {},
        format: 'pcm',
        output,
        fetchImpl: async () => ({
          ok: true,
          headers: { get: (name) => (name === 'content-type' ? 'audio/pcm' : null) },
          body: {
            getReader: () => ({
              async read() {
                state.reads++;
                return read(state.reads);
              },
              async cancel() {
                state.cancelCalls++;
              },
            }),
          },
        }),
      });
    },
  };
}
const chunk = () => ({ value: Buffer.alloc(480, 1), done: false });
const end = () => ({ done: true });
test('the same PCM audio needs bounded guards independent of one-byte network fragmentation', async () => {
  async function measure(fragment) {
    const f = fixture(),
      bytes = Buffer.alloc(48000, 1);
    let offset = 0;
    const started = Date.now();
    try {
      await f.run(() => {
        if (offset === bytes.length) return end();
        const value = bytes.subarray(offset, offset + fragment);
        offset += value.length;
        return { done: false, value };
      });
      assert.deepEqual(Buffer.concat(f.res.chunks), bytes);
      assert.ok(f.res.chunks.every((part) => part.length <= Math.max(4096, fragment)));
      return { guards: f.state.guards, elapsed: Date.now() - started, writes: f.res.chunks.length };
    } finally {
      f.output.dispose();
    }
  }
  const whole = await measure(48000),
    hundred = await measure(480),
    tiny = await measure(1);
  assert.ok(hundred.guards < 30, JSON.stringify({ whole, hundred }));
  // The old stream performed309 guards for100 chunks of this same audio.
  assert.ok(hundred.guards < 30, JSON.stringify(hundred));
  // Tiny fragments may exhaust the 20ms flush window before filling4096B.
  // Those time-bound flushes are allowed; one SQL-backed guard per raw byte is not.
  assert.ok(tiny.writes <= 14 + Math.ceil(tiny.elapsed / 20), JSON.stringify(tiny));
  assert.ok(tiny.guards < 200, JSON.stringify({ whole, hundred, tiny }));
});
test('scope revoked while provider read is pending prevents its bytes from reaching the client', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.run(async (read) => {
        if (read === 1) return chunk();
        await Promise.resolve();
        f.state.allowed = false;
        return chunk();
      }),
      { status: 403 },
    );
    assert.equal(f.res.chunks.length, 1);
    assert.ok(f.state.cancelCalls > 0);
  } finally {
    f.output.dispose();
  }
});
test('revocation during HTTP backpressure prevents any later packet, including EOF completion', async () => {
  const f = fixture();
  f.res.write = (bytes) => {
    f.res.chunks.push(Buffer.from(bytes));
    queueMicrotask(() => {
      f.state.allowed = false;
      f.res.emit('drain');
    });
    return false;
  };
  try {
    await assert.rejects(
      f.run((read) => (read < 3 ? chunk() : end())),
      { status: 403 },
    );
    assert.equal(f.res.chunks.length, 1);
    assert.ok(f.state.cancelCalls > 0);
  } finally {
    f.output.dispose();
  }
});
test('revocation at EOF still fails fresh authorization before reporting successful completion', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.run((read) => {
        if (read === 1) return chunk();
        f.state.allowed = false;
        return end();
      }),
      { status: 403 },
    );
    assert.equal(f.res.chunks.length, 1);
  } finally {
    f.output.dispose();
  }
});
test('fragmented partial samples still check access before accepting another byte', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.run((read) => {
        if (read === 1) return { done: false, value: Buffer.from([1]) };
        f.state.allowed = false;
        return { done: false, value: Buffer.from([2]) };
      }),
      { status: 403 },
    );
    assert.equal(f.res.chunks.length, 0);
  } finally {
    f.output.dispose();
  }
});

test('a partial packet flushes while the same upstream read remains pending and cancellation closes it', async () => {
  const f = fixture();
  let release;
  const stalled = new Promise((resolve) => {
    release = resolve;
  });
  let firstWrite;
  const wrote = new Promise((resolve) => {
    firstWrite = resolve;
  });
  f.res.write = (bytes) => {
    f.res.chunks.push(Buffer.from(bytes));
    if (f.res.chunks.length === 2) firstWrite();
    return true;
  };
  const running = f
    .run((read) => (read < 3 ? chunk() : stalled))
    .then(
      () => null,
      (e) => e,
    );
  try {
    await wrote;
    assert.equal(f.state.reads, 3, 'no second reader.read while the old read is pending');
    assert.equal(Buffer.concat(f.res.chunks).length, 960);
    f.req.emit('aborted');
    assert.equal((await running).status, 499);
    assert.equal(f.state.cancelCalls, 1);
    release(chunk());
    await Promise.resolve();
    assert.equal(f.res.chunks.length, 2, 'late bytes cannot escape after cancellation');
  } finally {
    release(end());
    f.output.dispose();
  }
});
test('revocation during the packet flush timer prevents buffered bytes from being written', async () => {
  const f = fixture();
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const running = f.run((read) => {
    if (read < 3) return chunk();
    started();
    return new Promise(() => {});
  });
  try {
    await waiting;
    f.state.allowed = false;
    await assert.rejects(running, { status: 403 });
    assert.equal(f.res.chunks.length, 1);
    assert.ok(f.state.cancelCalls > 0);
  } finally {
    f.output.dispose();
  }
});

test('shared generic synthesis also authorizes bounded writes instead of every upstream fragment', async () => {
  async function measure(fragment) {
    const f = fixture(),
      bytes = Buffer.alloc(48000, 1);
    let offset = 0;
    const generation = createSpeechGeneration({
      timeoutMs: 2000,
      run: (output) => {
        return streamTimewebSpeech({
          provider: { model: 'synthetic', voice: 'synthetic' },
          key: 'synthetic',
          payload: {},
          format: 'pcm',
          output,
          collect: true,
          fetchImpl: async () => ({
            ok: true,
            headers: new Headers({ 'content-type': 'audio/pcm' }),
            body: {
              getReader: () => ({
                async read() {
                  if (offset === bytes.length) return end();
                  const value = bytes.subarray(offset, offset + fragment);
                  offset += value.length;
                  return { done: false, value };
                },
                async cancel() {},
              }),
            },
          }),
        });
      },
      complete() {},
      failed(error) {
        throw error;
      },
    });
    const client = f.output,
      waiter = generation.attach(client, true);
    try {
      generation.start();
      const result = await waiter.wait();
      assert.deepEqual(Buffer.concat(f.res.chunks), bytes);
      assert.deepEqual(result.bytes, bytes);
      return f.state.guards;
    } finally {
      waiter.dispose();
      client.dispose();
    }
  }
  const whole = await measure(48000),
    hundred = await measure(480);
  assert.ok(whole < 20, JSON.stringify({ whole, hundred }));
  assert.ok(hundred < 50, 'old shared generic path performed513 guards for100 fragments');
});

test('already large provider packets pass through without multiplying fresh SQL-backed guards', async () => {
  for (const size of [48000, 65536]) {
    const f = fixture(),
      bytes = Buffer.alloc(size, 1);
    try {
      await f.run((read) => (read === 1 ? { done: false, value: bytes } : end()));
      assert.deepEqual(Buffer.concat(f.res.chunks), bytes);
      assert.equal(f.res.chunks.length, 1);
      assert.ok(f.state.guards < 12, String(f.state.guards));
    } finally {
      f.output.dispose();
    }
  }
});
