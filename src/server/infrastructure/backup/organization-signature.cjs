const crypto = require('node:crypto');
const { readKey, plainFile } = require('./snapshot.cjs');
const fs = require('node:fs');

function signDocument(value, keyFile) {
  const { mac: ignored, ...body } = value;
  return {
    ...body,
    mac: crypto
      .createHmac('sha256', readKey(keyFile))
      .update('organization-restore-v1\0' + JSON.stringify(body))
      .digest('hex'),
  };
}
function readDocument(file, keyFile) {
  plainFile(file);
  if (fs.statSync(file).size > 16384) throw Error('Excessive restore document.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    !/^[a-f0-9]{64}$/.test(value.mac || '') ||
    !crypto.timingSafeEqual(
      Buffer.from(value.mac, 'hex'),
      Buffer.from(signDocument(value, keyFile).mac, 'hex'),
    )
  )
    throw Error('Restore document authentication failed.');
  return value;
}
module.exports = { signDocument, readDocument };
