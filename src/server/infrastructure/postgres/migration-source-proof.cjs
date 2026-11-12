const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeTree } = require('../backup/snapshot.cjs');
const { plain } = require('./migration-assets.cjs');
function captureSourceProof(source) {
  source = path.resolve(source);
  safeTree(source);
  plain(source, true);
  const hash = crypto.createHash('sha256'),
    buffer = Buffer.allocUnsafe(128 * 1024);
  let files = 0,
    bytes = 0;
  function optional(relative, { wal = false } = {}) {
    const file = path.join(source, relative);
    let before;
    try {
      before = fs.lstatSync(file, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink())
      throw Error('Invalid offline migration source file.');
    if (wal && before.size === 0n) return;
    if (++files > 1000000) throw Error('Offline migration source exceeds the file bound.');
    hash.update(relative.length + ':' + relative + ':' + before.size + ':');
    const descriptor = fs.openSync(file, 'r');
    let size = 0;
    try {
      for (;;) {
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!count) break;
        size += count;
        hash.update(buffer.subarray(0, count));
      }
    } finally {
      fs.closeSync(descriptor);
    }
    const after = fs.lstatSync(file, { bigint: true });
    if (
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some((key) => before[key] !== after[key]) ||
      BigInt(size) !== before.size
    )
      throw changed();
    bytes += size;
    hash.update(';');
  }
  function database(relative) {
    optional(relative);
    optional(relative + '-wal', { wal: true });
    optional(relative + '-journal', { wal: true });
  }
  function cabinet(relative = '') {
    const directory = path.join(source, relative);
    plain(directory, true);
    const prefix = relative ? relative + '/' : '';
    database(prefix + 'cabinet.sqlite');
    optional(prefix + 'encryption.key');
    const photoDirectory = path.join(directory, 'photos');
    if (!fs.existsSync(photoDirectory)) return;
    plain(photoDirectory, true);
    for (const name of fs.readdirSync(photoDirectory).sort()) {
      if (!/^[a-f0-9]{32}\.enc$/.test(name))
        throw Error('Unsupported offline migration photo file.');
      optional(prefix + 'photos/' + name);
    }
  }
  plain(path.join(source, 'platform'), true);
  database('platform/platform.sqlite');
  optional('platform/platform.key');
  optional('platform/assistant-state.enc');
  database('platform/booking-read-budget.sqlite');
  cabinet();
  const tenants = path.join(source, 'tenants');
  if (fs.existsSync(tenants)) {
    plain(tenants, true);
    const names = fs.readdirSync(tenants).sort();
    if (names.length > 100000) throw Error('Offline migration source exceeds the tenant bound.');
    for (const name of names) {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(name))
        throw Error('Unsupported offline migration tenant directory.');
      cabinet('tenants/' + name);
    }
  }
  return Object.freeze({ version: 1, files, bytes, sha256: hash.digest('hex') });
}
function changed() {
  return Object.assign(Error('Offline migration source changed; destination was not activated.'), {
    code: 'POSTGRES_SOURCE_CHANGED',
  });
}
function assertSourceProof(source, expected) {
  let actual;
  try {
    actual = captureSourceProof(source);
  } catch (error) {
    if (error.code === 'POSTGRES_SOURCE_CHANGED') throw error;
    throw changed();
  }
  if (
    !expected ||
    expected.version !== 1 ||
    actual.files !== expected.files ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  )
    throw changed();
  return true;
}
module.exports = { captureSourceProof, assertSourceProof };
