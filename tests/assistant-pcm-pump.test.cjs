const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');
const source = fs.readFileSync('src/client/workers/assistant-pcm-pump.js', 'utf8');
const url =
  '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43) + '&accountContext=a&organizationContext=o';
const request = { url, accountContext: { accountId: 'a', organizationId: 'o' } };
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
};
function fixture(
  t,
  {
    chunks = [new Uint8Array([1, 0, 2, 0])],
    status = 200,
    headers = {},
    fetchImpl,
    autoProgress = true,
  } = {},
) {
  const messages = [],
    buffers = [],
    calls = [];
  let reads = 0,
    cancelled = 0,
    signal;
  const channel = new MessageChannel();
  t.after(() => {
    context.self.onmessage({ data: { type: 'cancel', id: 1 } });
    channel.port1.close();
    channel.port2.close();
  });
  const response = {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (n) =>
        ({
          'content-type': 'audio/pcm',
          'x-audio-sample-rate': '24000',
          'x-audio-channels': '1',
          'x-audio-sample-format': 's16le',
          ...headers,
        })[n] || null,
    },
    body: {
      cancel: async () => {
        cancelled++;
      },
      getReader: () => ({
        read: async () => {
          reads++;
          return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
        },
        cancel: async () => {
          cancelled++;
        },
      }),
    },
  };
  const context = {
    self: {
      location: { origin: 'https://synthetic.invalid' },
      postMessage: (m) => messages.push(m),
    },
    URL,
    AbortController,
    Uint8Array,
    Int16Array,
    DataView,
    Number,
    Math,
    setTimeout,
    clearTimeout,
    fetch: async (u, o) => {
      calls.push({ u, o });
      signal = o.signal;
      return fetchImpl ? fetchImpl(response, o) : response;
    },
  };
  vm.runInNewContext(source, context);
  let consumed = 0;
  channel.port1.onmessage = ({ data }) => {
    if (data.type === 'buffer') {
      buffers.push({ id: data.id, group: data.arrivalGroup, samples: Array.from(data.samples) });
      if (autoProgress) {
        consumed += data.samples.length;
        channel.port1.postMessage({ type: 'progress', id: 1, consumed });
      }
    }
  };
  context.self.onmessage({ data: { type: 'prepare', protocol: 1, id: 1, port: channel.port2 } });
  channel.port1.postMessage({ type: 'ready', protocol: 1, id: 1 });
  return {
    messages,
    buffers,
    calls,
    response,
    send: (data) => context.self.onmessage({ data: { id: 1, ...data } }),
    progress: (n) => channel.port1.postMessage({ type: 'progress', id: 1, consumed: n }),
    reads: () => reads,
    cancelled: () => cancelled,
    signal: () => signal,
  };
}
async function until(f, type) {
  for (let i = 0; i < 100 && !f.messages.some((m) => m.type === type); i++) await flush();
  assert.ok(
    f.messages.some((m) => m.type === type),
    type + ' message absent',
  );
}
test('worker waits for main header authorization before any PCM read and preserves odd-byte order', async (t) => {
  const f = fixture(t, {
    chunks: [new Uint8Array([1]), new Uint8Array([0, 2, 0, 3]), new Uint8Array([0])],
  });
  await until(f, 'prepared');
  f.send({ type: 'start', ...request });
  await until(f, 'headers');
  assert.equal(f.reads(), 0);
  assert.equal(f.buffers.length, 0);
  f.send({ type: 'accept' });
  await until(f, 'end');
  assert.deepEqual(
    f.buffers.flatMap((b) => b.samples),
    [1, 2, 3],
  );
  assert.deepEqual(
    f.buffers.map((b) => b.group),
    [2, 3],
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].o.credentials, 'same-origin');
  assert.equal(f.calls[0].o.redirect, 'error');
  assert.equal(f.calls[0].o.cache, 'no-store');
  assert.equal(f.calls[0].o.mode, 'same-origin');
  assert.equal(f.calls[0].o.headers['X-Cartoteca-Account-Id'], 'a');
});
test('one large read retains one arrival group through direct-port backpressure then next read changes group', async (t) => {
  const bytes = new Uint8Array(120000),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < 60000; i++) view.setInt16(i * 2, (i % 30000) + 1, true);
  const f = fixture(t, { chunks: [bytes, new Uint8Array(40)], autoProgress: false });
  await until(f, 'prepared');
  f.send({ type: 'start', ...request });
  await until(f, 'headers');
  f.send({ type: 'accept' });
  await flush();
  let sent = f.buffers.reduce((n, b) => n + b.samples.length, 0);
  assert.ok(sent <= 48000 && sent > 40000);
  assert.ok(f.buffers.every((b) => b.group === 1));
  assert.equal(f.reads(), 1);
  assert.ok(!f.messages.some((m) => m.type === 'end'));
  f.progress(30000);
  await until(f, 'end');
  const values = f.buffers.flatMap((b) => b.samples);
  assert.equal(values.length, 60020);
  for (let i = 0; i < 60000; i++) assert.equal(values[i], (i % 30000) + 1);
  assert.equal(f.buffers.at(-1).group, 2);
  assert.equal(f.calls.length, 1);
});
test('invalid consumed progress aborts rather than releasing unearned capacity', async (t) => {
  const f = fixture(t);
  await until(f, 'prepared');
  f.progress(1);
  await until(f, 'error');
  assert.equal(f.calls.length, 0);
});
test('worker rejects URL/context changes before fetch and never retries', async (t) => {
  for (const bad of [
    { ...request, url: 'https://other.invalid' + url },
    { ...request, url: url + '&ticket=bad' },
    { ...request, url: url + '#fragment' },
    { ...request, accountContext: { accountId: 'other', organizationId: 'o' } },
    { ...request, url: '/api/assistant/speak' },
  ]) {
    const f = fixture(t);
    await until(f, 'prepared');
    f.send({ type: 'start', ...bad });
    await until(f, 'error');
    assert.equal(f.calls.length, 0);
  }
});
test('403 and428 headers reach main without reading refusal bodies; cancel discards body', async (t) => {
  for (const status of [403, 428]) {
    const f = fixture(t, { status });
    await until(f, 'prepared');
    f.send({ type: 'start', ...request });
    await until(f, 'headers');
    assert.equal(f.messages.find((m) => m.type === 'headers').meta.status, status);
    assert.equal(f.reads(), 0);
    f.send({ type: 'cancel' });
    await flush();
    assert.equal(f.cancelled(), 1);
    assert.ok(f.signal().aborted);
    assert.equal(f.buffers.length, 0);
  }
});
test('empty, odd EOF, oversized and wrong PCM metadata fail without retry', async (t) => {
  for (const options of [
    { chunks: [] },
    { chunks: [new Uint8Array([1])] },
    { chunks: [new Uint8Array(4 * 1024 * 1024 + 1)] },
    { headers: { 'x-audio-sample-rate': '48000' } },
  ]) {
    const f = fixture(t, options);
    await until(f, 'prepared');
    f.send({ type: 'start', ...request });
    await until(f, 'headers');
    f.send({ type: 'accept' });
    await until(f, 'error');
    assert.equal(f.calls.length, 1);
    assert.ok(!f.messages.some((m) => m.type === 'end'));
  }
});
test('cancel aborts pending fetch and ignores its late response', async (t) => {
  let resolve;
  const f = fixture(t, {
    fetchImpl: (response) =>
      new Promise((r) => {
        resolve = () => r(response);
      }),
  });
  await until(f, 'prepared');
  f.send({ type: 'start', ...request });
  await flush();
  assert.equal(f.calls.length, 1);
  f.send({ type: 'cancel' });
  assert.ok(f.signal().aborted);
  resolve();
  await flush();
  assert.equal(f.cancelled(), 1);
  assert.ok(!f.messages.some((m) => m.type === 'headers' || m.type === 'end'));
  assert.equal(f.buffers.length, 0);
});
test('a second start after the first GET fails without a second paid GET', async (t) => {
  const f = fixture(t);
  await until(f, 'prepared');
  f.send({ type: 'start', ...request });
  await until(f, 'headers');
  f.send({ type: 'start', ...request });
  await until(f, 'error');
  assert.equal(f.calls.length, 1);
  assert.equal(f.reads(), 0);
});
