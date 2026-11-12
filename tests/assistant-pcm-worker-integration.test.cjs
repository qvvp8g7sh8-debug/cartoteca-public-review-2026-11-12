const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const text = fs.readFileSync(path.join(__dirname, 'assistant-pcm-playback.test.cjs'), 'utf8'),
  prefix = text
    .slice(0, text.indexOf('\ntest('))
    .replace('})(state, {})', '})(state, opts.actions || {})');
const { fixture, response, pcm, reply, flush } = new Function(
  'require',
  '__dirname',
  'process',
  prefix + '\nreturn {fixture,response,pcm,reply,flush};',
)(require, __dirname, process);
const metadata = {
  status: 200,
  ok: true,
  contentType: 'audio/pcm',
  sampleRate: '24000',
  channels: '1',
  sampleFormat: 's16le',
  serverTiming: '',
};
function transportFixture(t, config = {}) {
  const calls = {
      prepare: 0,
      start: 0,
      cancel: 0,
      release: 0,
      reads: 0,
      eof: 0,
      startResolved: 0,
      mainTypes: [],
    },
    ports = [];
  let f;
  const service = {
    async prepare(owner, options) {
      calls.prepare++;
      const originalPost = options.node.processor.port.postMessage;
      options.node.processor.port.postMessage = (data) => {
        calls.mainTypes.push(data.type);
        originalPost(data);
      };
      if (config.unavailable) return null;
      let ready;
      const waiting = new Promise((r) => (ready = r)),
        port = {
          closed: false,
          start() {},
          close() {
            this.closed = true;
          },
          postMessage(data) {
            if (data.type === 'ready') ready();
          },
        };
      ports.push(port);
      options.node.port.postMessage({ type: 'transport', id: options.id, port, protocol: 1 });
      await waiting;
      let acknowledge;
      const eofAck = new Promise((resolve) => (acknowledge = resolve));
      const handle = {
        async start() {
          calls.start++;
          await options.onHeaders({ ...metadata, ...config.meta });
          if (config.fail) throw Error('Synthetic single GET failure');
          if (config.wait) {
            await eofAck;
            calls.startResolved++;
            return;
          }
          calls.reads++;
          options.onFirstByte();
          port.onmessage({
            data: {
              type: 'buffer',
              id: options.id,
              samples: new Int16Array(2400).fill(1000),
              arrivalGroup: 1,
            },
          });
          port.onmessage({ data: { type: 'end', id: options.id } });
          await eofAck;
          calls.startResolved++;
        },
        eof() {
          calls.eof++;
          acknowledge();
        },
        cancel() {
          calls.cancel++;
          port.close();
        },
      };
      return handle;
    },
    release() {
      calls.release++;
    },
  };
  f = fixture(t, { actions: { assistantPcmTransport: () => service } });
  return { f, calls, ports };
}
test('GET transport uses direct data port and EOF main message precedes ended', async (t) => {
  const { f, calls } = transportFixture(t);
  await f.gesture();
  const done = f.api.play(reply());
  await flush(80);
  await f.drain(90);
  assert.equal(await done, true);
  assert.equal(calls.start, 1);
  assert.equal(calls.eof, 1);
  assert.equal(calls.startResolved, 1);
  assert.equal(calls.reads, 1);
  assert.equal(f.fetches.length, 0);
  const node = f.nodes[0];
  assert.ok(node.messages.some((x) => x.type === 'transport'));
  assert.equal(
    node.messages.some((x) => x.type === 'buffer' && x.id > 0),
    false,
  );
  assert.ok(calls.cancel >= 1);
  assert.ok(calls.mainTypes.indexOf('eof') >= 0);
  assert.ok(calls.mainTypes.indexOf('eof') < calls.mainTypes.indexOf('ended'));
});
test('unavailable preparation falls back before first GET only', async (t) => {
  const { f, calls } = transportFixture(t, { unavailable: true });
  await f.gesture();
  const done = f.api.play(reply());
  await flush(80);
  await f.drain(90);
  assert.equal(await done, true);
  assert.equal(f.fetches.length, 1);
  assert.equal(calls.start, 0);
});
for (const meta of [
  { status: 428, ok: false },
  { sampleRate: '16000' },
  { status: 403, ok: false },
])
  test(
    'strict worker response header rejection never reads audio or retries ' + JSON.stringify(meta),
    async (t) => {
      const { f, calls } = transportFixture(t, { meta });
      await f.gesture();
      const done = f.api.play(reply());
      await assert.rejects(done);
      assert.equal(calls.reads, 0);
      assert.equal(calls.start, 1);
      assert.equal(f.fetches.length, 0);
      if (meta.status === 428) assert.deepEqual(f.redirects, ['/']);
    },
  );
test('failure after Worker GET start never falls back to main GET', async (t) => {
  const { f, calls } = transportFixture(t, { fail: true });
  await f.gesture();
  await assert.rejects(f.api.play(reply()));
  assert.equal(calls.start, 1);
  assert.equal(f.fetches.length, 0);
});
test('active cancel closes exact direct port and ignores its late PCM', async (t) => {
  const { f, calls, ports } = transportFixture(t, { wait: true });
  await f.gesture();
  const done = f.api.play(reply());
  await flush(80);
  const old = f.nodes[0].processor.id,
    late = ports[0].onmessage;
  f.api.stop();
  await flush();
  assert.equal(await done, false);
  late({ data: { type: 'buffer', id: old, samples: new Int16Array(50).fill(1) } });
  assert.equal(f.nodes[0].processor.length, 0);
  assert.ok(ports[0].closed);
  assert.ok(calls.cancel);
});
test('direct POST never prepares Worker transport', async (t) => {
  const { f, calls } = transportFixture(t);
  f.state.assistantScope = { policyVersion: 7, capabilities: { tts: { directPcm: true } } };
  await f.gesture();
  f.setResponse(response([pcm(24)], { headers: { 'x-assistant-policy-version': '7' } }));
  const value = {
    ...reply(),
    policyVersion: 7,
    streamRequest: { text: 'Synthetic', policyVersion: 7, format: 'pcm' },
  };
  delete value.streamUrl;
  const done = f.api.play(value);
  await flush(80);
  await f.drain(90);
  assert.equal(await done, true);
  assert.equal(calls.prepare, 0);
  assert.equal(f.fetches[0].options.method, 'POST');
});
test('received count rejects impossible Worker accounting without loosening consumed guard', async (t) => {
  const { f } = transportFixture(t, { wait: true });
  await f.gesture();
  const done = f.api.play(reply());
  await flush(80);
  const p = f.nodes[0].processor;
  p.port.postMessage({ type: 'progress', id: p.id, consumed: 1, received: 0 });
  await assert.rejects(done);
  assert.equal(f.fetches.length, 0);
});
test('data channel cannot issue begin/pause controls and replacement closes old ownership', async (t) => {
  const { f, ports } = transportFixture(t, { wait: true });
  await f.gesture();
  const done = f.api.play(reply());
  await flush(80);
  const p = f.nodes[0].processor,
    id = p.id;
  ports[0].onmessage({ data: { type: 'begin', id: id + 1 } });
  ports[0].onmessage({ data: { type: 'pause', id } });
  assert.equal(p.id, id);
  assert.equal(p.paused, false);
  const old = ports[0].onmessage,
    replacement = { postMessage() {}, start() {}, close() {} };
  p.receive({ type: 'transport', id, port: replacement, protocol: 1 });
  assert.equal(ports[0].closed, true);
  old({ data: { type: 'buffer', id, samples: new Int16Array(20).fill(1) } });
  assert.equal(p.length, 0);
  f.api.stop();
  assert.equal(await done, false);
});

for (const received of [-1, 2097153, 1.5])
  test('Worker received accounting rejects invalid value ' + received, async (t) => {
    const { f } = transportFixture(t, { wait: true });
    await f.gesture();
    const done = f.api.play(reply());
    await flush(80);
    const p = f.nodes[0].processor;
    p.port.postMessage({ type: 'progress', id: p.id, consumed: 0, received });
    await assert.rejects(done);
    assert.equal(f.fetches.length, 0);
  });

test('invalid or stale MAIN EOF never acknowledges the transport', async (t) => {
  const { f, calls } = transportFixture(t, { wait: true });
  await f.gesture();
  const done = f.api.play(reply());
  await flush(80);
  const p = f.nodes[0].processor;
  p.port.postMessage({ type: 'eof', id: p.id - 1, received: 2400 });
  await flush();
  assert.equal(calls.eof, 0);
  p.port.postMessage({ type: 'eof', id: p.id, received: 0 });
  await assert.rejects(done);
  assert.equal(calls.eof, 0);
  assert.equal(calls.startResolved, 0);
});
test('one valid AW EOF resolves transport before any later Worker control and duplicate EOF is idempotent', async (t) => {
  const { f, calls, ports } = transportFixture(t, { wait: true });
  await f.gesture();
  const done = f.api.play(reply());
  await flush(80);
  const p = f.nodes[0].processor;
  ports[0].onmessage({
    data: { type: 'buffer', id: p.id, samples: new Int16Array(2400).fill(1000), arrivalGroup: 1 },
  });
  ports[0].onmessage({ data: { type: 'end', id: p.id } });
  ports[0].onmessage({ data: { type: 'end', id: p.id } });
  await flush();
  assert.equal(calls.eof, 1);
  assert.equal(calls.startResolved, 1);
  await f.drain(90);
  assert.equal(await done, true);
  assert.equal(calls.eof, 1);
  assert.equal(f.fetches.length, 0);
});
