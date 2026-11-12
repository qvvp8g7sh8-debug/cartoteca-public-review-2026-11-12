const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPcmValidator, speechEncoding, PCM_METADATA, PCM_BYTES_PER_SECOND,
  MAX_PCM_SECONDS, MAX_AUDIO_BYTES,
} = require('../src/server/modules/assistant/speech/pcm-audio.cjs');

test('PCM contract is fixed24kHz mono signed16 LE and server speed is not repeated in playback', () => {
  assert.deepEqual(PCM_METADATA, { sampleRate: 24000, channels: 1, sampleFormat: 's16le', playbackRate: 1 });
  assert.equal(PCM_BYTES_PER_SECOND, 48000);
  assert.equal(speechEncoding('pcm').speed, 1.4);
  assert.equal(speechEncoding().format, 'mp3');
  assert.equal(speechEncoding().speed, 1);
  assert.equal(MAX_AUDIO_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_PCM_SECONDS, 132);
  assert.equal(Object.isFrozen(PCM_METADATA), true);
});

test('every byte partition including sample boundaries is preserved and has exact duration', () => {
  const expected = Buffer.from([0, 0, 255, 127, 0, 128, 255, 255]);
  for (let mask = 0; mask < 1 << (expected.length - 1); mask++) {
    const validator = createPcmValidator(), emitted = [];
    let start = 0;
    for (let end = 1; end <= expected.length; end++)
      if (end === expected.length || (mask & (1 << (end - 1)))) {
        const chunk = validator.push(expected.subarray(start, end));
        if (chunk) {
          assert.equal(chunk.length % 2, 0);
          emitted.push(chunk);
        }
        start = end;
      }
    assert.deepEqual(Buffer.concat(emitted), expected);
    assert.deepEqual(validator.finish(), { seconds: expected.length / 48000, tail: null });
  }
});

test('empty packets do not create output; zero-length and odd final streams are rejected', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([1]), Buffer.from([1, 2, 3])]) {
    const validator = createPcmValidator();
    assert.equal(validator.push(Buffer.alloc(0)), null);
    validator.push(bytes);
    assert.throws(() => validator.finish(), { status: 502 });
  }
});

test('byte and duration caps reject the offending packet before it can be written', () => {
  const byBytes = createPcmValidator({ maxBytes: 4 });
  assert.deepEqual(byBytes.push(Buffer.from([1, 2])), Buffer.from([1, 2]));
  assert.throws(() => byBytes.push(Buffer.from([3, 4, 5])), { status: 502 });
  const byTime = createPcmValidator({ maxSeconds: 1 });
  assert.equal(byTime.push(Buffer.alloc(48000)).length, 48000);
  assert.throws(() => byTime.push(Buffer.alloc(2)), { status: 502 });
});

test('fixed byte ceiling stays stricter than132seconds and accepts only actual bytes', () => {
  const full = createPcmValidator();
  full.push(Buffer.alloc(MAX_AUDIO_BYTES));
  assert.equal(full.finish().seconds, MAX_AUDIO_BYTES / 48000);
  assert.throws(() => full.push(Buffer.alloc(2)), { status: 502 });
  assert.throws(() => createPcmValidator().push(new Float32Array([NaN])), { status: 502 });
});

test('nonfinite and relaxed validator limits are rejected', () => {
  for (const value of [NaN, Infinity, -1, 0, 133])
    assert.throws(() => createPcmValidator({ maxSeconds: value }), /bounded PCM limits/);
  for (const value of [NaN, Infinity, -1, 0, 1.5, MAX_AUDIO_BYTES + 1])
    assert.throws(() => createPcmValidator({ maxBytes: value }), /bounded PCM limits/);
});

test('format selection cannot coerce objects or accept prototype keys', () => {
  for (const value of [null, 0, true, {}, ['pcm'], 'wav', 'PCM', 'toString', '__proto__'])
    assert.throws(() => speechEncoding(value), { status: 400 });
});


test('mislabeled Timeweb PCM buffers at most16 prefix bytes and preserves fragmented raw samples', () => {
  const expected = Buffer.from([0, 0, 255, 127, 0, 128, 255, 255, 1, 0, 2, 0, 3, 0, 4, 0,
    5, 0, 6, 0, 7, 0, 8, 0, 9, 0, 10, 0, 11, 0, 12, 0]);
  for (let first = 1; first < expected.length; first++) {
    const validator = createPcmValidator({ rejectEncodedPrefix: true }), emitted = [];
    const a = validator.push(expected.subarray(0, first));
    if (first < 16) assert.equal(a, null);
    if (a) emitted.push(a);
    const b = validator.push(expected.subarray(first));
    if (b) emitted.push(b);
    const done = validator.finish();
    if (done.tail) emitted.push(done.tail);
    assert.deepEqual(Buffer.concat(emitted), expected);
    assert.equal(done.seconds, expected.length / 48000);
  }
  const bytes = createPcmValidator({ rejectEncodedPrefix: true }), emitted = [];
  for (const byte of expected) { const output = bytes.push(Buffer.from([byte])); if (output) emitted.push(output); }
  assert.equal(bytes.finish().tail, null);
  assert.deepEqual(Buffer.concat(emitted), expected);
});

test('mislabeled PCM rejects fragmented encoded or text prefixes before any sample is returned', () => {
  const mp3 = Buffer.alloc(417); Buffer.from([255, 251, 144, 100]).copy(mp3);
  const examples = [mp3, Buffer.from('ID3'+'.'.repeat(32)), Buffer.from('RIFF0000WAVE'+'.'.repeat(32)),
    Buffer.from('OggS'+'.'.repeat(32)), Buffer.from('fLaC'+'.'.repeat(32)), Buffer.from([255, 241, 80, 128, 4, 31, 252, ...Array(25).fill(0)]),
    Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom0000')]),
    Buffer.from('  {"error":"provider unavailable"}'), Buffer.from('<html>unavailable</html>'),
    Buffer.from('Provider temporarily unavailable'), Buffer.from('Провайдер недоступен'),
  ];
  for (const example of examples) for (let first = 1; first < 16; first++) {
    const validator = createPcmValidator({ rejectEncodedPrefix: true });
    assert.equal(validator.push(example.subarray(0, first)), null);
    assert.throws(() => validator.push(example.subarray(first)), { status: 502 });
  }
});

test('short mislabeled PCM is checked only at EOF; empty, odd, and textual replies fail closed', () => {
  for (const bytes of [Buffer.from([0, 0]), Buffer.from([1, 0, 2, 0, 255, 127])]) {
    const validator = createPcmValidator({ rejectEncodedPrefix: true });
    assert.equal(validator.push(bytes), null);
    assert.deepEqual(validator.finish(), { seconds: bytes.length / 48000, tail: bytes });
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from([1, 0, 2]), Buffer.from('{}'), Buffer.from('OK'), Buffer.from('<html>'), Buffer.from('ID3a')]) {
    const validator = createPcmValidator({ rejectEncodedPrefix: true });
    assert.equal(validator.push(bytes), null);
    assert.throws(() => validator.finish(), { status: 502 });
  }
  assert.throws(() => createPcmValidator({ rejectEncodedPrefix: 1 }), /bounded PCM limits/);
  const bounded = createPcmValidator({ maxBytes: 8, rejectEncodedPrefix: true });
  bounded.push(Buffer.alloc(8));
  assert.throws(() => bounded.push(Buffer.alloc(2)), { status: 502 });
});


test('signed16 PCM starting at minus1 or minus2 is not mistaken for MPEG or ADTS sync', () => {
  for (const sample of [-1, -2]) {
    const expected = Buffer.alloc(32); expected.writeInt16LE(sample);
    for (let first = 1; first < 16; first++) {
      const validator = createPcmValidator({ rejectEncodedPrefix: true });
      assert.equal(validator.push(expected.subarray(0, first)), null);
      assert.deepEqual(validator.push(expected.subarray(first)), expected);
      assert.deepEqual(validator.finish(), { seconds: expected.length / 48000, tail: null });
    }
    const short = expected.subarray(0, 2), validator = createPcmValidator({ rejectEncodedPrefix: true });
    assert.equal(validator.push(short), null);
    assert.deepEqual(validator.finish(), { seconds: 2 / 48000, tail: short });
  }
});


for (const sample of [123, 91, 60, 34, 39])
  test(`quiet signed16 PCM sample ${sample} followed by zeros is not mistaken for text`, () => {
    const expected = Buffer.alloc(16); expected.writeInt16LE(sample);
    for (let first = 1; first < 16; first++) {
      const validator = createPcmValidator({ rejectEncodedPrefix: true });
      assert.equal(validator.push(expected.subarray(0, first)), null);
      assert.deepEqual(validator.push(expected.subarray(first)), expected);
      assert.deepEqual(validator.finish(), { seconds: expected.length / 48000, tail: null });
    }
    const short = expected.subarray(0, 2), validator = createPcmValidator({ rejectEncodedPrefix: true });
    assert.equal(validator.push(short), null);
    assert.deepEqual(validator.finish(), { seconds: 2 / 48000, tail: short });
  });
