const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeTree, plainFile } = require('./snapshot.cjs');

function syncFile(file) {
  plainFile(file);
  // FlushFileBuffers on Windows requires a writable handle. Never truncate.
  const descriptor = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
function syncDirectory(directory) {
  // Windows cannot open directories for fsync; file fsync still applies there.
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
function atomicJson(file, value) {
  const directory = path.dirname(file);
  safeTree(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) plainFile(file);
  const temporary = path.join(directory, '.status-' + crypto.randomUUID());
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    syncFile(temporary);
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
module.exports = { syncFile, syncDirectory, atomicJson };
