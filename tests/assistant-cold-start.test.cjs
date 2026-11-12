const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(
  process.env.ASSISTANT_PCM_WORKLET_SOURCE || 'src/client/worklets/assistant-playback-worklet.js',
  'utf8',
);
function fixture(rate, coldStart = true, startupSamples = 2880) {
  let Processor;
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
    registerProcessor: (_, P) => (Processor = P),
  });
  const p = new Processor();
  const send = (type, extra = {}) => p.port.onmessage({ data: { id: 1, type, ...extra } });
  send('begin', { coldStart, startupSamples });
  send('resume');
  return {
    p,
    messages,
    send,
    buffer(n, v = 16384) {
      send('buffer', { samples: new Int16Array(n).fill(v) });
    },
    quantum() {
      const out = new Float32Array(128);
      p.process([], [[out]]);
      return out;
    },
    render(n) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(...this.quantum());
      return out;
    },
    untilStart() {
      let frames = 0;
      for (let n = 0; n < 1000; n++) {
        const a = this.quantum();
        const i = a.findIndex(Boolean);
        if (i >= 0) return frames + i;
        frames += 128;
      }
      assert.fail('bounded start absent');
    },
  };
}
for (const rate of [24000, 44100, 48000]) {
  test(`cold readiness spends at most180ms total after minimum reserve at ${rate}`, () => {
    const f = fixture(rate);
    f.buffer(2880);
    const first = f.untilStart();
    assert.ok(first >= rate * 0.18 - 128, 'cold readiness must actually wait');
    assert.ok(first <= Math.floor(rate * 0.18), 'total cold wait cannot exceed180ms');
    assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 0);
  });
  test(`observed prestart packet gap cannot stack another cold wait at ${rate}`, () => {
    const f = fixture(rate);
    f.buffer(960);
    f.render(Math.ceil((rate * 0.13) / 128));
    f.buffer(1920);
    const first = f.untilStart();
    assert.ok(first >= rate * 0.18 - 128, 'missing arrival metadata uses bounded cold readiness');
    assert.ok(first <= Math.floor(rate * 0.18), 'observed gap cannot stack60ms onto180ms');
  });
  test(`ready backlog and EOF bypass cold staging with ordered complete tail at ${rate}`, () => {
    const ready = fixture(rate);
    ready.buffer(5760);
    assert.ok(ready.quantum().some(Boolean));
    const f = fixture(rate);
    const samples = Int16Array.from({ length: 601 }, (_, i) => i + 1);
    f.send('buffer', { samples });
    f.send('end');
    const out = f.render(Math.ceil((601 * rate) / 24000 / 128) + 2);
    const values = out.filter(Boolean);
    assert.ok(values.length > 0);
    assert.ok(out[0] > 0);
    for (let i = 1; i < values.length; i++)
      assert.ok(values[i] >= values[i - 1], 'sample order must not reverse');
    assert.equal(f.p.consumed, 601);
    assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
    assert.equal(f.messages.filter((m) => m.event === 'underrun').length, 0);
  });
  test(`default and warm startup semantics remain distinct from cold stage at ${rate}`, () => {
    const plain = fixture(rate, false);
    plain.buffer(2880);
    assert.ok(plain.quantum().some(Boolean));
    const warm = fixture(rate, false, 7200);
    warm.buffer(2880);
    const first = warm.untilStart();
    assert.ok(first >= rate * 0.18);
    assert.ok(first < rate * 0.18 + 128);
  });
}
test('cold stage cannot mask a long outage; true recovery remains300ms and EOF drains', () => {
  const f = fixture(24000);
  f.buffer(2880);
  f.untilStart();
  f.render(90);
  assert.ok(f.messages.some((m) => m.event === 'underrun'));
  assert.equal(f.p.bufferTarget, 7200);
  f.buffer(2400);
  assert.equal(f.render(10).some(Boolean), false);
  f.send('end');
  f.render(30);
  assert.equal(f.p.consumed, 5280);
  assert.equal(f.messages.filter((m) => m.type === 'ended').length, 1);
});
test('pause does not spend cold wait and stale owner cannot inject a tail', () => {
  const f = fixture(24000);
  f.buffer(2880);
  f.send('pause');
  f.render(30);
  assert.equal(f.p.consumed, 0);
  f.send('resume');
  const resumedWait = f.untilStart();
  assert.ok(resumedWait >= 4320 - 128 && resumedWait <= 4320);
  f.send('begin', { id: 2, coldStart: true });
  f.send('buffer', { samples: new Int16Array(10000).fill(16384) });
  assert.equal(f.p.length, 0);
  f.send('buffer', { id: 2, samples: new Int16Array(31).fill(8192) });
  f.send('end', { id: 2 });
  f.send('resume', { id: 2 });
  assert.ok(f.quantum().some(Boolean));
  assert.equal(f.p.consumed, 31);
  assert.equal(f.messages.filter((m) => m.type === 'ended' && m.id === 2).length, 1);
});
