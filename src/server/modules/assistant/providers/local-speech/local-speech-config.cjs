const fs = require('node:fs');
const path = require('node:path');
const { localEnabled } = require('../codex/codex-config.cjs');
function header(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const fd = fs.openSync(file, 'r'),
    bytes = Buffer.alloc(4);
  try {
    if (fs.readSync(fd, bytes, 0, 4, 0) !== 4) return null;
    return { bytes, size: stat.size, path: fs.realpathSync(file) };
  } finally {
    fs.closeSync(fd);
  }
}
function findRuntime(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return null;
  try {
    const executable = header(
      path.join(directory, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'),
    );
    const model = header(path.join(directory, 'models', 'ggml-base.bin'));
    const native =
      executable &&
      (process.platform === 'win32'
        ? executable.bytes.toString('ascii', 0, 2) === 'MZ'
        : executable.bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
          ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(
            executable.bytes.toString('hex'),
          ));
    if (
      !native ||
      !model ||
      model.size < 16 ||
      model.size > 256 * 1024 * 1024 ||
      model.bytes.readUInt32LE() !== 0x67676d6c
    )
      return null;
    return { executable: executable.path, model: model.path };
  } catch {
    return null;
  }
}
function childEnvironment(directory, env = process.env) {
  const result = { TEMP: directory, TMP: directory };
  for (const name of ['SystemRoot', 'WINDIR'])
    if (typeof env[name] === 'string') result[name] = env[name];
  return result;
}
module.exports = { localEnabled, findRuntime, childEnvironment };
