const { fail } = require('../../../../../shared/errors.cjs');
function validateLocalAudio(audio) {
  const bytes = audio?.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > 3 * 1024 * 1024)
    throw fail(400, 'Нужна короткая запись WAV PCM с одним каналом.');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4),
      start = offset + 8;
    if (start + size > bytes.length) break;
    if (bytes.toString('ascii', offset, offset + 4) === 'fmt ' && size >= 16) {
      if (bytes.readUInt32LE(start + 4) !== 16000)
        throw fail(
          400,
          'Локальное распознавание принимает WAV 16 кГц. Запишите звук через микрофон помощника.',
        );
      return bytes;
    }
    offset = start + size + (size % 2);
  }
  throw fail(400, 'Некорректная запись WAV для локального распознавания.');
}
module.exports = { validateLocalAudio };
