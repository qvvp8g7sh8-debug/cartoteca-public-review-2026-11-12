const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  process.env.ASSISTANT_PCM_WORKLET_SOURCE ||
    path.join(__dirname, '../src/client/worklets/assistant-playback-worklet.js'),
  'utf8',
);
function fixture(rate = 24000) {
  let Implementation;
  const messages = [];
  vm.runInNewContext(source, {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (data) => messages.push(data) };
      }
    },
    Float32Array,
    Int16Array,
    Number,
    Math,
    sampleRate: rate,
    registerProcessor: (_, value) => {
      Implementation = value;
    },
  });
  const processor = new Implementation();
  const send = (data) => processor.port.onmessage({ data: { id: 1, ...data } });
  send({ type: 'begin' });
  return {
    processor,
    messages,
    send,
    buffer(count, value = 16384) {
      send({ type: 'buffer', samples: new Int16Array(count).fill(value) });
    },
    render(count) {
      const output = [];
      for (let remaining = count; remaining > 0;) {
        const frame = new Float32Array(Math.min(128, remaining));
        processor.process([], [[frame]]);
        output.push(...frame);
        remaining -= frame.length;
      }
      return output;
    },
  };
}
test('a provisional interruption lowers output smoothly without stopping the PCM clock', () => {
  const f = fixture(24000);
  f.buffer(12000);
  f.send({ type: 'resume' });
  assert.ok(f.render(512).every((value) => value === 0.5));
  f.send({ type: 'probe' });
  assert.equal(f.messages.filter((m) => m.type === 'probed').length, 1);
  const probe = f.render(1024);
  assert.ok(probe.every((value) => value >= 0.0625 && value <= 0.5));
  assert.equal(probe.at(-1), 0.0625);
  assert.equal(f.processor.consumed, 1536);
  f.send({ type: 'resume' });
  const restored = f.render(1024);
  assert.ok(restored.every((value) => value >= 0.0625 && value <= 0.5));
  assert.equal(restored.at(-1), 0.5);
  assert.equal(f.processor.consumed, 2560);
});
for (const rate of [44100, 48000]) {
  test(`a warm seed waits for at most180ms after cold reserve at ${rate}Hz`, () => {
    const f = fixture(rate);
    f.send({ type: 'begin', id: 2, startupSamples: 7200 });
    assert.equal(f.processor.startupTarget, 7200);
    f.send({ type: 'buffer', id: 2, samples: new Int16Array(2880).fill(16384) });
    f.send({ type: 'resume', id: 2 });
    assert.equal(f.render(Math.round(rate * 0.18)).some(Boolean), false);
    assert.ok(f.render(128).every(Boolean), 'warm cap releases already available cold reserve');
    assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 0);
  });
}
test('short packets wait for a small audio reserve, not a timer; a ready burst starts in the next quantum', () => {
  const f = fixture();
  f.send({ type: 'resume' });
  f.buffer(2400);
  assert.equal(f.render(4800).some(Boolean), false);
  assert.equal(f.processor.consumed, 0);
  assert.equal(
    f.messages.some((m) => m.type === 'started'),
    false,
  );
  f.buffer(480);
  assert.ok(f.render(128).every((value) => value === 0.5));
  assert.equal(f.messages.filter((m) => m.type === 'started').length, 1);
});
test('a complete reply shorter than the reserve and its final tail play immediately at EOF', () => {
  const f = fixture();
  f.buffer(512);
  f.send({ type: 'end' });
  f.send({ type: 'resume' });
  assert.ok(f.render(512).every((value) => value === 0.5));
  assert.equal(f.processor.consumed, 512);
  assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
});
test('120 ms reserve absorbs delayed 40 ms packets without holes, repetitions or extra requests', () => {
  const f = fixture();
  const schedule = new Map([
    [0, 960],
    [4, 960],
    [8, 960],
    [12, 960],
    [22, 2880],
    [28, 960],
  ]);
  const output = [];
  f.send({ type: 'resume' });
  for (let tick = 0; tick < 70; tick++) {
    if (schedule.has(tick)) f.buffer(schedule.get(tick));
    if (tick === 28) f.send({ type: 'end' });
    output.push(...f.render(240));
  }
  const first = output.findIndex(Boolean),
    last = output.findLastIndex(Boolean);
  assert.equal(first, 8 * 240, 'start when 120 ms is available, with no extra wall-clock timer');
  assert.equal(last - first + 1, 7680);
  assert.ok(output.slice(first, last + 1).every((value) => value === 0.5));
  assert.equal(f.processor.consumed, 7680);
  assert.equal(f.messages.filter((m) => m.type === 'started').length, 1);
  assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
});
test('a long outage triggers one refill; tiny arriving packets do not each restart speech', () => {
  const f = fixture();
  f.buffer(2880);
  f.send({ type: 'resume' });
  assert.ok(f.render(2880).every((value) => value === 0.5));
  assert.equal(f.render(2400).some(Boolean), false);
  for (let i = 0; i < 2; i++) {
    f.buffer(2400);
    assert.equal(f.render(2400).some(Boolean), false);
  }
  f.buffer(2400);
  assert.ok(f.render(128).every((value) => value === 0.5));
  f.send({ type: 'end' });
  f.render(7200);
  assert.equal(f.processor.consumed, 10080);
  assert.equal(f.messages.filter((m) => m.type === 'started').length, 1);
  assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
});
test('pause, cancellation and a new reply preserve ownership while a refill is pending', () => {
  const f = fixture();
  f.buffer(2880);
  f.send({ type: 'resume' });
  f.render(2880);
  f.render(128); // A genuinely missing block, not an exact full-block boundary.
  f.buffer(2400);
  f.send({ type: 'pause' });
  assert.equal(f.render(1000).some(Boolean), false);
  f.send({ type: 'resume' });
  assert.equal(f.render(1000).some(Boolean), false);
  f.send({ type: 'begin', id: 2 });
  f.buffer(24000);
  assert.equal(f.processor.length, 0, 'stale chunks cannot populate a new reply');
  f.send({ type: 'buffer', id: 2, samples: new Int16Array(128).fill(8192) });
  f.send({ type: 'end', id: 2 });
  f.send({ type: 'resume', id: 2 });
  assert.ok(f.render(128).every((value) => value === 0.25));
});
for (const rate of [24000, 44100, 48000]) {
  test(`refill and EOF preserve sample count and audio rate at ${rate} Hz`, () => {
    const f = fixture(rate);
    f.send({ type: 'resume' });
    f.buffer(2880);
    const first = f.render(Math.ceil((2880 * rate) / 24000));
    f.render(rate / 10);
    f.buffer(2400);
    assert.equal(f.render(rate / 10).some(Boolean), false);
    f.send({ type: 'end' });
    const tail = f.render(Math.ceil((2400 * rate) / 24000) + 128);
    const audible = [...first, ...tail].filter(Boolean);
    assert.ok(Math.abs(audible.length - (5280 * rate) / 24000) <= 1);
    assert.ok(audible.every((value) => value === 0.5));
    assert.equal(f.processor.consumed, 5280);
    assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
  });
}
test('repeated outages cap refill below the bounded two-second ring and cannot deadlock the producer', () => {
  const f = fixture();
  f.send({ type: 'resume' });
  for (let i = 0; i < 8; i++) {
    f.buffer(24000);
    assert.ok(f.render(24000).every((value) => value === 0.5));
    f.render(128);
  }
  assert.ok(f.processor.bufferTarget <= 24000);
  assert.equal(f.processor.samples.length, 48000);
  f.send({ type: 'end' });
  f.render(128);
  assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
});
test('continuous delivery reduces an elevated recovery reserve without dropping or accelerating audio', () => {
  const f = fixture();
  f.send({ type: 'resume' });
  f.buffer(2880);
  f.render(2880);
  f.render(128); // Establish actual starvation before testing recovery decay.
  f.buffer(7200);
  f.render(7200);
  const elevated = f.processor.bufferTarget;
  f.buffer(30000);
  assert.ok(f.render(24000).every((value) => value === 0.5));
  f.buffer(24000);
  assert.ok(f.render(24000).every((value) => value === 0.5));
  assert.ok(f.processor.bufferTarget < elevated);
  assert.ok(f.processor.bufferTarget >= 2880);
  assert.equal(f.processor.consumed, 58080);
});
test('a delayed ramp retains every sample in order through underflow, refill and a short EOF tail', () => {
  const f = fixture();
  const samples = Int16Array.from({ length: 10000 }, (_, i) => i + 1);
  f.send({ type: 'buffer', samples: samples.slice(0, 4000) });
  f.send({ type: 'resume' });
  const first = f.render(4000);
  f.render(2400);
  f.send({ type: 'buffer', samples: samples.slice(4000, 5000) });
  assert.equal(f.render(2400).some(Boolean), false);
  f.send({ type: 'buffer', samples: samples.slice(5000) });
  f.send({ type: 'end' });
  const tail = f.render(6000);
  assert.deepEqual(
    [...first, ...tail],
    Array.from(samples, (value) => value / 32768),
  );
  assert.equal(f.processor.consumed, 10000);
});

for (const [rate, initial, rendered] of [
  [48000, 2880, 5760],
  [44100, 3204, 5888],
]) {
  test(`uneven timely packet delivery preserves the complete ramp at ${rate}Hz`, () => {
    const f = fixture(rate),
      control = fixture(rate);
    const samples = Int16Array.from({ length: 10240 }, (_, i) => i + 1000);
    const schedule = new Map([
      [0, 2880],
      [20, 800],
      [35, 1400],
      [40, 500],
      [48, 2100],
      [65, 1000],
      [75, 1560],
    ]);
    const total = Math.ceil((samples.length * rate) / 24000) + 128;
    const actual = [];
    let sent = 0;
    f.send({ type: 'resume' });
    for (let tick = 0; actual.length < total; tick++) {
      if (schedule.has(tick)) {
        const count = schedule.get(tick);
        f.send({ type: 'buffer', samples: samples.slice(sent, sent + count) });
        sent += count;
        if (sent === samples.length) f.send({ type: 'end' });
      }
      actual.push(...f.render(Math.min(128, total - actual.length)));
    }
    control.send({ type: 'buffer', samples });
    control.send({ type: 'end' });
    control.send({ type: 'resume' });
    assert.deepEqual(actual, control.render(total));
    assert.equal(f.processor.consumed, samples.length);
    assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 0);
    assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
  });

  test(`a full render boundary accepts the next timely packet without synthetic refill at ${rate}Hz`, () => {
    const f = fixture(rate),
      control = fixture(rate);
    const samples = Int16Array.from({ length: initial + 4000 }, (_, i) => i + 1000);
    f.send({ type: 'buffer', samples: samples.slice(0, initial) });
    f.send({ type: 'resume' });
    const first = f.render(rendered);
    assert.ok(first.every(Boolean), 'the entire preceding render block was supplied');
    assert.equal(f.processor.length, 0);
    assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 0);
    f.send({ type: 'buffer', samples: samples.slice(initial) });
    const timely = f.render(128);
    assert.ok(timely.every(Boolean), 'timely source cannot be muted by an artificial refill');
    f.send({ type: 'end' });
    const total = Math.ceil((samples.length * rate) / 24000) + 128;
    const tail = f.render(total - rendered - 128);
    control.send({ type: 'buffer', samples });
    control.send({ type: 'end' });
    control.send({ type: 'resume' });
    const actual = [...first, ...timely, ...tail],
      expected = control.render(total);
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      // Existing linear interpolation holds the last sample when a packet has
      // no lookahead. Only that boundary sample may differ from a full buffer.
      if (i >= rendered - Math.ceil(rate / 24000) && i < rendered)
        assert.ok(Math.abs(actual[i] - expected[i]) <= 1 / 32768);
      else assert.equal(actual[i], expected[i], 'ramp order at output frame' + i);
    }
    assert.equal(f.processor.consumed, samples.length);
    assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
  });

  test(`a real partial render shortage and900ms gap still require bounded recovery at ${rate}Hz`, () => {
    const f = fixture(rate);
    f.buffer(initial + 10);
    f.send({ type: 'resume' });
    assert.ok(f.render(rendered).every(Boolean));
    const partial = f.render(128);
    assert.ok(partial.some(Boolean));
    assert.ok(partial.some((value) => value === 0));
    assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 1);
    assert.equal(f.processor.bufferTarget, 7200);
    assert.equal(f.render(Math.round(rate * 0.9)).some(Boolean), false);
    f.buffer(2880);
    assert.equal(
      f.render(128).some(Boolean),
      false,
      'real shortage retains the300ms recovery target',
    );
    f.buffer(4320);
    assert.ok(f.render(128).every(Boolean));
    assert.equal(f.messages.filter((m) => m.event === 'refill').length, 1);
    assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 1);
    f.send({ type: 'end' });
    f.render(Math.ceil((7200 * rate) / 24000) + 128);
    assert.equal(f.processor.consumed, initial + 10 + 7200);
    assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
  });
}
