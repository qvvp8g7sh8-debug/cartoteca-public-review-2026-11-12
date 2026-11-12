const { fail } = require('../../../../shared/errors.cjs');
const { frameInfo } = require('./mp3-audio.cjs');
const { TextDecoder } = require('node:util');
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_PCM_SECONDS = 132;
const PCM_METADATA = Object.freeze({
  sampleRate: 24000,
  channels: 1,
  sampleFormat: 's16le',
  playbackRate: 1,
});
const PCM_BYTES_PER_SECOND = PCM_METADATA.sampleRate * PCM_METADATA.channels * 2;
const ENCODINGS = Object.freeze({
  mp3: Object.freeze({ format: 'mp3', mimeType: 'audio/mpeg', speed: 1, version: 1 }),
  pcm: Object.freeze({ format: 'pcm', mimeType: 'audio/pcm', speed: 1.4, version: 2 }),
});
function speechEncoding(format = 'mp3') {
  if (typeof format !== 'string' || !Object.hasOwn(ENCODINGS, format))
    throw fail(400, 'Выберите формат озвучивания.');
  return ENCODINGS[format];
}
// Raw PCM has no identifying header. This is deliberately only a prefix rejection
// guard for the documented Timeweb PCM response whose gateway labels it audio/mpeg.
// It is not general-purpose codec detection or permission to decode encoded audio.
function encodedPrefix(bytes) {
  const ascii = bytes.toString('latin1');
  if (
    ['ID3', 'RIFF', 'RIFX', 'RF64', 'OggS', 'fLaC', 'ADIF'].some((tag) => ascii.startsWith(tag)) ||
    (bytes.length >= 3 &&
      bytes[0] === 255 &&
      (bytes[1] & 246) === 240 &&
      ((bytes[2] >> 2) & 15) <= 12) ||
    (bytes.length >= 8 && ['ftyp', 'moov', 'mdat', 'styp'].includes(ascii.slice(4, 8)))
  )
    return true;
  // A sync prefix alone also occurs in valid signed16 PCM, such as sample -1.
  // Require valid MPEG version/layer/bitrate/sample-rate fields before rejection.
  if (bytes.length >= 4) {
    try {
      frameInfo(bytes);
      return true;
    } catch {}
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }).trim();
    if (/^[\x20-\x7e\r\n\t]+$/u.test(text)) return true;
    return !!text && /^[\p{L}\p{N}\p{P}\p{Zs}\r\n\t]+$/u.test(text);
  } catch {
    return false;
  }
}
function createPcmValidator({
  maxBytes = MAX_AUDIO_BYTES,
  maxSeconds = MAX_PCM_SECONDS,
  rejectEncodedPrefix = false,
} = {}) {
  if (
    typeof rejectEncodedPrefix !== 'boolean' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_AUDIO_BYTES ||
    !Number.isFinite(maxSeconds) ||
    maxSeconds <= 0 ||
    maxSeconds > MAX_PCM_SECONDS
  )
    throw Error('Invalid bounded PCM limits');
  let total = 0,
    pending = null,
    prefix = rejectEncodedPrefix ? Buffer.alloc(0) : null;
  return {
    push(chunk) {
      if (!(chunk instanceof Uint8Array))
        throw fail(502, 'Провайдер вернул некорректный поток PCM.');
      if (!chunk.byteLength) return null;
      total += chunk.byteLength;
      if (total > maxBytes) throw fail(502, 'Аудио провайдера превышает ограничение.');
      if (total / PCM_BYTES_PER_SECOND > maxSeconds)
        throw fail(502, 'Озвучивание превышает допустимую длительность.');
      let bytes = Buffer.from(chunk);
      if (prefix !== null) {
        const needed = Math.min(16 - prefix.length, bytes.length);
        const peek = Buffer.concat([prefix, bytes.subarray(0, needed)]);
        if (peek.length < 16) {
          prefix = peek;
          return null;
        }
        if (encodedPrefix(peek))
          throw fail(502, 'Провайдер вернул закодированный ответ вместо PCM.');
        bytes = Buffer.concat([prefix, bytes]);
        prefix = null;
      }
      if (pending) bytes = Buffer.concat([pending, bytes]);
      const aligned = bytes.length - (bytes.length % 2);
      // A network chunk may split a signed16 sample. Retain exactly one byte.
      pending = aligned < bytes.length ? Buffer.from(bytes.subarray(aligned)) : null;
      return aligned ? bytes.subarray(0, aligned) : null;
    },
    finish() {
      if (!total || pending || (prefix !== null && (prefix.length % 2 || encodedPrefix(prefix))))
        throw fail(502, 'Провайдер вернул некорректный поток PCM.');
      const tail = prefix;
      prefix = null;
      return { seconds: total / PCM_BYTES_PER_SECOND, tail };
    },
  };
}
module.exports = {
  createPcmValidator,
  speechEncoding,
  PCM_METADATA,
  PCM_BYTES_PER_SECOND,
  MAX_PCM_SECONDS,
  MAX_AUDIO_BYTES,
};
