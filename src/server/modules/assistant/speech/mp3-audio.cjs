const { fail } = require('../../../../shared/errors.cjs');
const MAX_MP3_SECONDS = 132;
const RATES = [44100, 48000, 32000];
const MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
function invalid() {
  return fail(502, 'Провайдер вернул некорректный поток MP3.');
}
function frameInfo(bytes, offset = 0) {
  const a = bytes[offset + 1],
    b = bytes[offset + 2];
  const version = (a >> 3) & 3,
    bitrateIndex = b >> 4,
    sampleIndex = (b >> 2) & 3;
  if (
    bytes[offset] !== 255 ||
    (a & 224) !== 224 ||
    version === 1 ||
    ((a >> 1) & 3) !== 1 ||
    !bitrateIndex ||
    bitrateIndex === 15 ||
    sampleIndex === 3
  )
    throw invalid();
  const rate = RATES[sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (version === 3 ? MPEG1 : MPEG2)[bitrateIndex];
  return {
    length: Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / rate) + ((b >> 1) & 1),
    seconds: (version === 3 ? 1152 : 576) / rate,
  };
}
function createMp3Validator() {
  let pending = Buffer.alloc(0),
    leading = Buffer.alloc(0),
    first = true,
    frames = 0,
    seconds = 0;
  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      const output = [];
      let offset = 0;
      if (first) {
        if (pending.length < 10) return null;
        if (pending.toString('ascii', 0, 3) === 'ID3') {
          if (![2, 3, 4].includes(pending[3]) || [6, 7, 8, 9].some((i) => pending[i] > 127))
            throw invalid();
          const size =
            10 +
            pending[6] * 2097152 +
            pending[7] * 16384 +
            pending[8] * 128 +
            pending[9] +
            (pending[5] & 16 ? 10 : 0);
          if (size > 65536) throw invalid();
          if (pending.length < size + 4) return null;
          leading = pending.subarray(0, size);
          offset = size;
        }
        first = false;
      }
      while (pending.length - offset >= 4) {
        if (pending.toString('ascii', offset, offset + 3) === 'TAG') break;
        const frame = frameInfo(pending, offset);
        if (pending.length - offset < frame.length) break;
        if (seconds + frame.seconds > MAX_MP3_SECONDS + 0.000001)
          throw fail(502, 'Озвучивание превышает допустимую длительность.');
        seconds += frame.seconds;
        frames++;
        if (leading.length) {
          output.push(leading);
          leading = Buffer.alloc(0);
        }
        output.push(pending.subarray(offset, offset + frame.length));
        offset += frame.length;
      }
      pending = Buffer.from(pending.subarray(offset));
      // The only allowed trailer is the fixed-size ID3v1 tag. No arbitrary padding.
      if (pending.toString('ascii', 0, 3) === 'TAG' && pending.length > 128) throw invalid();
      return output.length ? Buffer.concat(output) : null;
    },
    finish() {
      if (!frames || first || leading.length) throw invalid();
      if (!pending.length) return { seconds, tail: null };
      if (pending.length === 128 && pending.toString('ascii', 0, 3) === 'TAG')
        return { seconds, tail: pending };
      throw invalid();
    },
  };
}
module.exports = { createMp3Validator, frameInfo, MAX_MP3_SECONDS };
