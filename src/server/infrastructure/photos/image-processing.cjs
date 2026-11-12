const { execFileSync } = require('node:child_process');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { createProcessingQueue } = require('./processing-queue.cjs');
const processing = createProcessingQueue({ maxActivePerScope: 1, maxPendingPerScope: 2 });
function normalizeImage(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 10 * 1024 * 1024)
    throw Error('Invalid image');
  return execFileSync(process.execPath, [path.join(__dirname, 'image-worker.cjs'), mime.slice(6)], {
    input: buffer,
    timeout: 15000,
    maxBuffer: 11 * 1024 * 1024,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function normalizeImageAsync(buffer, mime, authorize = () => {}, scopeKey = null) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 10 * 1024 * 1024)
    return Promise.reject(Error('Invalid image'));
  return processing.run(
    () =>
      new Promise((resolve, reject) => {
        authorize(); // A queued request may lose access before a worker starts.
        const child = execFile(
          process.execPath,
          [path.join(__dirname, 'image-worker.cjs'), mime.slice(6)],
          { timeout: 15000, maxBuffer: 11 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
          (error, stdout) => {
            error ? reject(error) : resolve(stdout);
          },
        );
        child.stdin.on('error', () => {});
        child.stdin.end(buffer);
      }),
    { scopeKey },
  );
}
module.exports = {
  normalizeImage,
  normalizeImageAsync,
  photoProcessingStats: () => ({ ...processing.snapshot(), ...processing.scopeSnapshot() }),
};
