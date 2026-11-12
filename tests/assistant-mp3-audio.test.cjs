const test = require('node:test');
const assert = require('node:assert/strict');
const { createMp3Validator, MAX_MP3_SECONDS } = require('../src/server/modules/assistant/speech/mp3-audio.cjs');
function frame(header = [255, 251, 144, 100], length = 417) {
  const bytes = Buffer.alloc(length); Buffer.from(header).copy(bytes); return bytes;
}
test('incremental MP3 validation withholds incomplete frames and calculates actual MPEG1 duration', () => {
  const parser = createMp3Validator(), bytes = frame();
  assert.equal(parser.push(bytes.subarray(0, 200)), null);
  assert.deepEqual(parser.push(bytes.subarray(200)), bytes);
  assert.equal(parser.finish().seconds, 1152 / 44100);
});
test('MPEG2 LayerIII and bounded ID3 headers preserve bytes and use their actual sample rate', () => {
  const parser = createMp3Validator(), bytes = frame([255, 243, 132, 100], 192);
  const tag = Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  assert.equal(parser.push(tag.subarray(0, 5)), null);
  const output = parser.push(Buffer.concat([tag.subarray(5), bytes]));
  assert.deepEqual(output, Buffer.concat([tag, bytes]));
  assert.equal(parser.finish().seconds, 576 / 24000);
});
test('unsupported codec, truncated frame and oversized metadata are rejected', () => {
  assert.throws(() => createMp3Validator().push(frame([255, 253, 144, 100])), { status: 502 });
  const partial = createMp3Validator(); partial.push(frame().subarray(0, 300));
  assert.throws(() => partial.finish(), { status: 502 });
  assert.throws(() => createMp3Validator().push(Buffer.from([73, 68, 51, 4, 0, 0, 0, 127, 127, 127])), { status: 502 });
});
test('132-second ceiling is enforced from MPEG frames before an over-limit frame is emitted', () => {
  const parser = createMp3Validator(), bytes = frame();
  const count = Math.floor(MAX_MP3_SECONDS / (1152 / 44100));
  assert.ok(parser.push(Buffer.concat(Array(count).fill(bytes))).length > 0);
  assert.ok(parser.finish().seconds <= MAX_MP3_SECONDS);
  assert.throws(() => parser.push(bytes), { status: 502 });
});
