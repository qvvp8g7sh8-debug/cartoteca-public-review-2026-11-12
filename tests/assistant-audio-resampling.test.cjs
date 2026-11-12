const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/assistant-audio.js'),
  'utf8',
);
function audioEncoder(Bytes, btoa) {
  const factory = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window: {
      ArrayBuffer,
      DataView,
      Float32Array,
      Float64Array,
      Uint8Array: Bytes,
      btoa,
    },
  });
  return factory({ assistantGeneration: 0 }, {});
}
class LegacyBytes extends Uint8Array {
  toBase64 = undefined;
}
const api = audioEncoder(LegacyBytes, (text) => Buffer.from(text, 'binary').toString('base64'));
function encode(rate, channels, options = {}) {
  const bytes = Buffer.from(
    api.encodeAssistantWav(
      {
        sampleRate: rate,
        duration: options.duration ?? channels[0].length / rate,
        numberOfChannels: channels.length,
        getChannelData: (index) => channels[index],
      },
      options.maxSeconds,
    ),
    'base64',
  );
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  const samples = Array.from({ length: (bytes.length - 44) / 2 }, (_, index) =>
    bytes.readInt16LE(44 + index * 2),
  );
  return { bytes, samples };
}
function tone(rate, frequency, seconds = 0.2, amplitude = 0.5) {
  return Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, index) => amplitude * Math.sin((2 * Math.PI * frequency * index) / rate),
  );
}
function rms(samples) {
  const interior = samples.slice(200, -200);
  return Math.sqrt(
    interior.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / interior.length,
  );
}

for (const rate of [44100, 48000]) {
  test(`WAV ${rate}Hz downsampling retains speech band and rejects above-Nyquist aliases`, () => {
    for (const frequency of [1000, 6000]) {
      const level = rms(encode(rate, [tone(rate, frequency)]).samples);
      assert.ok(
        Math.abs(level - Math.SQRT1_2 * 0.5) < 0.01,
        `${frequency}Hz passband RMS ${level}`,
      );
    }
    for (const frequency of [10000, 12000, 18000]) {
      const level = rms(encode(rate, [tone(rate, frequency)]).samples);
      assert.ok(level < 0.002, `${frequency}Hz alias RMS ${level}`);
    }
  });

  test(`WAV ${rate}Hz normalized filter preserves DC at both recording boundaries`, () => {
    const input = new Float32Array(Math.round(rate * 0.03)).fill(0.5);
    const { samples } = encode(rate, [input]);
    assert.equal(samples.length, 480);
    assert.ok(samples.every((value) => value === 16384));
  });

  test(`WAV ${rate}Hz mixes channels before filtering without changing duration`, () => {
    const signal = tone(rate, 1000);
    const opposite = Float32Array.from(signal, (value) => -value);
    const { samples } = encode(rate, [signal, opposite]);
    assert.equal(samples.length, 3200);
    assert.ok(samples.every((value) => value === 0));
  });
}

test('WAV 16k path keeps signed quantization, clipping and individual samples exact', () => {
  const input = Float32Array.from([-2, -1, -0.5, 0, 0.5, 1, 2]);
  assert.deepEqual(
    encode(16000, [input]).samples,
    [-32768, -32768, -16384, 0, 16384, 32767, 32767],
  );
});

test('WAV upsampling retains linear interpolation for lower-rate input', () => {
  assert.deepEqual(
    encode(8000, [Float32Array.from([0, 1, 0, -1])]).samples,
    [0, 16384, 32767, 16384, 0, -16384, -32768, -32768],
  );
});

test('WAV filter is centered on an impulse without adding a recording delay', () => {
  const input = new Float32Array(4800);
  input[2400] = 1;
  const { samples } = encode(48000, [input]);
  const peak = samples.reduce(
    (best, value, index) => (Math.abs(value) > Math.abs(samples[best]) ? index : best),
    0,
  );
  assert.equal(peak, 800);
  for (let distance = 1; distance < 15; distance++)
    assert.ok(Math.abs(samples[800 - distance] - samples[800 + distance]) <= 1);
});

test('WAV output remains bounded by maxSeconds without reading the unused long tail', () => {
  const input = new Float32Array(96000).fill(0.25);
  const { samples, bytes } = encode(48000, [input], { maxSeconds: 1 });
  assert.equal(samples.length, 16000);
  assert.equal(bytes.length, 32044);
  assert.ok(samples.every((value) => value === 8192));
});

test('WAV uses native byte-to-base64 where available and preserves padded base64', () => {
  let nativeCalls = 0;
  class NativeBytes extends Uint8Array {
    toBase64() {
      nativeCalls++;
      return Buffer.from(this).toString('base64');
    }
  }
  const native = audioEncoder(NativeBytes, () => assert.fail('unexpected btoa fallback'));
  for (const sampleCount of [4000, 4001, 4002]) {
    const samples = Float32Array.from({ length: sampleCount }, (_, i) => Math.sin(i / 3) / 2);
    const input = {
      sampleRate: 16000,
      duration: sampleCount / 16000,
      numberOfChannels: 1,
      getChannelData: () => samples,
    };
    assert.equal(native.encodeAssistantWav(input), api.encodeAssistantWav(input));
  }
  assert.equal(nativeCalls, 3);
});

test('WAV preserves exact interior and boundary samples for odd-length stereo input', () => {
  for (const [rate, expected] of [
    [44100, 'caef8be827dab21fca660489559dbb288205e0000eb38f28ec373b6dbebc394e'],
    [48000, '499bdebdf0d0e880d9a74d647f191f5ede6633f5b30dd1f55aa3a0a0a2e8419c'],
  ]) {
    const length = rate + 313;
    const left = Float32Array.from({ length }, (_, i) => (((i * 239) % 4093) - 2046) / 1024);
    const right = Float32Array.from({ length }, (_, i) => (((i * 167) % 2039) - 1019) / 1024);
    left[0] = 0.75;
    right[length - 1] = -0.875;
    const { bytes } = encode(rate, [left, right]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, rate + ' Hz');
  }
});
