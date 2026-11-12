const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
function encryptionKey(directory, filename, keyFile, missingMessage) {
  const read = () => {
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw Error('Invalid encryption key');
    return key;
  };
  try {
    return read();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (fs.existsSync(filename)) {
    // Another initializer may just have completed; never replace a lost key.
    try {
      return read();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw Error(missingMessage);
    }
  }
  const temporary = path.join(directory, '.key-init-' + crypto.randomUUID());
  fs.writeFileSync(temporary, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  try {
    // Publish a complete key atomically, without overwriting the winning initializer.
    try {
      fs.linkSync(temporary, keyFile);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    fs.unlinkSync(temporary);
  }
  return read();
}
module.exports = { encryptionKey };
