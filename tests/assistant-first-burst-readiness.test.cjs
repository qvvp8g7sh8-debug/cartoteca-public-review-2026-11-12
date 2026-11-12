const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/worklets/assistant-playback-worklet.js'),
  'utf8',
);
function processor(rate, cold = true, seed = 2880) {
  let P;
  const messages = [];
  vm.runInNewContext(source, {
    sampleRate: rate,
    Float32Array,
    Int16Array,
    Number,
    Math,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => messages.push(m) };
      }
    },
    registerProcessor: (_, p) => (P = p),
  });
  const p = new P(),
    send = (type, data = {}) => p.port.onmessage({ data: { id: 1, type, ...data } });
  send('begin', { coldStart: cold, startupSamples: seed });
  send('resume');
  return {
    p,
    send,
    messages,
    tick() {
      const a = new Float32Array(128);
      p.process([], [[a]]);
      return a;
    },
  };
}
function run(rate, packets, { cold = true, seed = 2880, metadata = true } = {}) {
  const f = processor(rate, cold, seed);
  let packet = 0,
    index = 0,
    first = null,
    gap = 0,
    maxGap = 0;
  const rendered = [];
  for (let n = 0; n < Math.ceil((rate * 3) / 128); n++) {
    const time = (n * 128 * 1000) / rate;
    while (packet < packets.length && packets[packet][0] <= time) {
      const data = Int16Array.from({ length: packets[packet][1] }, () => ++index);
      for (let i = 0; i < data.length; i += 4096)
        f.send('buffer', {
          samples: data.slice(i, i + 4096),
          ...(metadata ? { arrivalGroup: packet + 1 } : {}),
        });
      packet++;
      if (packet === packets.length) f.send('end');
    }
    const a = f.tick();
    for (let i = 0; i < a.length; i++) {
      if (a[i]) {
        first ??= ((n * 128 + i) * 1000) / rate;
        maxGap = Math.max(maxGap, gap);
        gap = 0;
        rendered.push(a[i]);
      } else if (first !== null && !f.p.finished) gap++;
    }
    if (f.p.finished) break;
  }
  return { ...f, first, gapMs: (maxGap * 1000) / rate, rendered };
}
for (const rate of [24000, 44100, 48000]) {
  test(
    'first125ms plus actual next190ms continuing stream drains without an internal gap at ' + rate,
    () => {
      const packets = [
          [0, 3000],
          [190, 600],
          ...Array.from({ length: 20 }, (_, i) => [215 + i * 40, 960]),
        ],
        f = run(rate, packets),
        count = packets.reduce((n, x) => n + x[1], 0),
        reference = run(rate, [[0, count]]);
      assert.equal(f.gapMs, 0);
      assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 0);
      assert.equal(f.p.consumed, count);
      assert.deepEqual(f.rendered, reference.rendered);
      assert.ok(f.first <= 180 && f.first >= 180 - 128000 / rate);
    },
  );
  test(
    'ready300ms backlog cannot predict future550ms arrival and still drains exact tail at ' + rate,
    () => {
      const f = run(rate, [
        [0, 7200],
        [550, 21600],
      ]);
      assert.ok(f.gapMs >= 240 && f.gapMs < 270);
      assert.equal(f.p.consumed, 28800);
      assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
      for (let i = 1; i < f.rendered.length; i++) assert.ok(f.rendered[i] >= f.rendered[i - 1]);
    },
  );
  test(
    'EOF and ready240ms bypass, while missing network metadata uses total180ms at ' + rate,
    () => {
      const eof = run(rate, [[0, 601]]);
      assert.equal(eof.first, 0);
      assert.equal(eof.p.consumed, 601);
      const f = processor(rate);
      f.send('buffer', { samples: new Int16Array(5760).fill(1) });
      assert.ok(f.tick().some(Boolean));
      const missing = processor(rate);
      missing.send('buffer', { samples: new Int16Array(2880).fill(1) });
      let wait = 0;
      for (; wait < rate; wait += 128) if (missing.tick().some(Boolean)) break;
      assert.ok(wait <= Math.floor(rate * 0.18) && wait >= rate * 0.18 - 128);
    },
  );
  test('same read fragments cannot fake later network arrivals at ' + rate, () => {
    const f = processor(rate);
    f.send('buffer', { samples: new Int16Array(2400).fill(1), arrivalGroup: 1 });
    for (let i = 0; i < Math.ceil((rate * 0.13) / 128); i++) f.tick();
    f.send('buffer', { samples: new Int16Array(600).fill(1), arrivalGroup: 1 });
    assert.equal(f.p.networkGroups, 1);
    assert.equal(f.p.networkLaterSamples, 0);
    assert.equal(f.tick().some(Boolean), false);
  });
  test('warm startup remains independent of cold readiness at ' + rate, () => {
    const warm = run(
      rate,
      [
        [0, 3000],
        [190, 21000],
      ],
      { cold: false, seed: 7200 },
    );
    assert.equal(warm.gapMs, 0);
    assert.ok(warm.first >= 180 && warm.first < 180 + 128000 / rate);
  });
}
// Reuse the existing real client pump + real worklet fixture setup without executing its test cases.
const harness = fs.readFileSync(path.join(__dirname, 'assistant-pcm-playback.test.cjs'), 'utf8');
const helpers = new Function(
  'require',
  '__dirname',
  'process',
  harness.slice(0, harness.indexOf('\ntest(')) + '\nreturn {fixture, response, pcm, reply, flush};',
)(require, __dirname, process);
test('actual fetch read keeps one arrivalGroup across4096sample fragments and room backpressure', async (t) => {
  const f = helpers.fixture(t);
  await f.gesture();
  f.setResponse(helpers.response([helpers.pcm(60000), helpers.pcm(20)]));
  const prepared = f.api.prepare({
      ...helpers.reply(),
      voiceOwner: { epoch: 1, session: 1, generation: 1 },
    }),
    done = prepared.play();
  await helpers.flush();
  await f.drain(1400);
  assert.equal(await done, true);
  const packets = f.nodes[0].messages.filter((x) => x.type === 'buffer' && x.id > 0);
  assert.ok(packets.length > 14);
  assert.ok(packets.every((x) => x.samples.length <= 4096));
  assert.ok(packets.slice(0, -1).every((x) => x.arrivalGroup === 1));
  assert.equal(packets.at(-1).arrivalGroup, 2);
  assert.equal(
    packets.reduce((s, x) => s + x.samples.length, 0),
    60020,
  );
});
