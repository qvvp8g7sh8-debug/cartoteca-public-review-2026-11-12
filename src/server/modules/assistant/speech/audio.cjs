const { fail } = require('../../../../shared/errors.cjs');
function wavAudio(body, maxSeconds) {
  if (
    body.mimeType !== 'audio/wav' ||
    typeof body.audioBase64 !== 'string' ||
    body.audioBase64.length > 4 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audioBase64)
  )
    throw fail(400, 'Нужна короткая запись WAV PCM с одним каналом.');
  const bytes = Buffer.from(body.audioBase64, 'base64');
  if (
    bytes.length < 44 ||
    bytes.length > 3 * 1024 * 1024 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw fail(400, 'Некорректный WAV-файл.');
  let format = null,
    dataBytes = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw fail(400, 'Повреждённая запись голоса.');
    if (type === 'fmt ') {
      if (format || size < 16) throw fail(400, 'Некорректный аудиоформат.');
      format = {
        type: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4),
        bytesPerSecond: bytes.readUInt32LE(start + 8),
        align: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    }
    if (type === 'data') {
      if (dataBytes !== null) throw fail(400, 'Лишний звуковой блок.');
      dataBytes = size;
    }
    offset = start + size + (size % 2);
  }
  if (
    !format ||
    dataBytes === null ||
    !dataBytes ||
    format.type !== 1 ||
    format.channels !== 1 ||
    format.bits !== 16 ||
    format.align !== 2 ||
    ![16000, 22050, 24000, 44100, 48000].includes(format.rate) ||
    format.bytesPerSecond !== format.rate * 2 ||
    dataBytes % 2
  )
    throw fail(400, 'Поддерживается только одноканальный WAV PCM 16 бит.');
  const seconds = dataBytes / format.bytesPerSecond;
  if (seconds < 0.1 || seconds > maxSeconds)
    throw fail(400, 'Запись превышает допустимую длительность.');
  return { bytes, seconds };
}
function providerWavDuration(bytes) {
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw fail(502, 'Провайдер не вернул WAV-аудио.');
  let format = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4),
      rawSize = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Some streaming WAV encoders mark the final data length as unknown.
    const size = type === 'data' && rawSize === 0xffffffff ? bytes.length - start : rawSize;
    if (start + size > bytes.length) throw fail(502, 'Провайдер вернул повреждённое аудио.');
    if (type === 'fmt ' && size >= 16)
      format = {
        type: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        align: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    if (type === 'data') {
      if (
        !format ||
        format.type !== 1 ||
        format.channels !== 1 ||
        format.bits !== 16 ||
        format.align !== 2 ||
        format.rate < 16000 ||
        format.rate > 48000 ||
        format.byteRate !== format.rate * 2 ||
        !size ||
        size % 2
      )
        throw fail(502, 'Не поддерживается формат голосового ответа провайдера.');
      return size / format.byteRate;
    }
    offset = start + size + (size % 2);
  }
  throw fail(502, 'В голосовом ответе нет звуковых данных.');
}
function finalizeProviderWav(bytes) {
  const seconds = providerWavDuration(bytes);
  const unknownRiffLength = bytes.readUInt32LE(4) === 0xffffffff;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4),
      start = offset + 8;
    if (type === 'data') {
      if (!unknownRiffLength && size !== 0xffffffff) return { bytes, seconds };
      // PCM is already validated; complete only the streaming length fields in a copy.
      const completed = Buffer.from(bytes);
      if (unknownRiffLength) completed.writeUInt32LE(completed.length - 8, 4);
      if (size === 0xffffffff) completed.writeUInt32LE(completed.length - start, offset + 4);
      return { bytes: completed, seconds };
    }
    offset = start + size + (size % 2);
  }
  throw fail(502, 'В голосовом ответе нет звуковых данных.');
}
module.exports = { wavAudio, providerWavDuration, finalizeProviderWav };
