const fs = require('node:fs');
const { fail } = require('../../../shared/errors.cjs');
const { createProcessingQueue } = require('./processing-queue.cjs');

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const GCM_OVERHEAD = 28;
function createPhotoReader({
  io = fs.promises,
  concurrency = 4,
  capacity = 8,
  waitMs = 5000,
  maxJobs = 12,
  maxBytes = 64 * 1024 * 1024,
  maxJobsPerScope = 6,
  maxBytesPerScope = 32 * 1024 * 1024,
} = {}) {
  if (
    !Number.isSafeInteger(maxJobs) ||
    maxJobs < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxJobsPerScope) ||
    maxJobsPerScope < 1 ||
    !Number.isSafeInteger(maxBytesPerScope) ||
    maxBytesPerScope < 1
  )
    throw Error('Invalid photo read budget.');
  const queue = createProcessingQueue({
    concurrency,
    capacity,
    waitMs,
    maxActivePerScope: Math.min(2, concurrency),
    maxPendingPerScope: Math.min(4, capacity),
  });
  const scopes = new Map();
  let jobs = 0,
    bytes = 0;
  const busy = () =>
    Object.assign(
      fail(503, 'Сервер загружает другие фотографии. Повторите через несколько секунд.'),
      {
        code: 'PHOTO_READ_CAPACITY',
        retryAfter: 2,
      },
    );
  async function read({
    filename,
    mime,
    decode,
    authorize = () => {},
    cancelled = () => false,
    retain,
    scopeKey = 'internal:unscoped',
  }) {
    const check = () => {
      if (cancelled()) throw fail(408, 'Загрузка фотографии остановлена.');
    };
    const authorizeRead = () => {
      check();
      authorize();
    };
    authorizeRead();
    if (typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > 256)
      throw Error('Invalid photo read scope.');
    const scope = scopes.get(scopeKey) || { jobs: 0, bytes: 0 };
    if (jobs >= maxJobs || scope.jobs >= maxJobsPerScope) throw busy();
    jobs++;
    scope.jobs++;
    scopes.set(scopeKey, scope);
    let heldBytes = 0,
      released = false,
      retained = false;
    const release = () => {
      if (released) return;
      released = true;
      jobs--;
      bytes -= heldBytes;
      scope.jobs--;
      scope.bytes -= heldBytes;
      if (!scope.jobs) scopes.delete(scopeKey);
    };
    try {
      const image = await queue.run(
        async () => {
          // Queue admission can await: authorize before opening any file.
          authorizeRead();
          const file = await io.open(filename, 'r');
          let encrypted;
          try {
            check();
            const before = await file.stat();
            check();
            if (
              !before.isFile() ||
              !Number.isSafeInteger(before.size) ||
              before.size <= GCM_OVERHEAD ||
              before.size > MAX_PHOTO_BYTES + GCM_OVERHEAD
            )
              throw fail(400, 'Некорректный размер фотографии.');
            // Owned ciphertext, decipher.update output and the final authenticated
            // Buffer can coexist. The storage decoder must not copy this complete
            // private input. Reserve all three before allocating a file-sized buffer.
            heldBytes = before.size * 3;
            if (bytes + heldBytes > maxBytes || scope.bytes + heldBytes > maxBytesPerScope) {
              heldBytes = 0;
              throw busy();
            }
            bytes += heldBytes;
            scope.bytes += heldBytes;
            encrypted = Buffer.alloc(before.size);
            let offset = 0;
            while (offset < encrypted.length) {
              check();
              const result = await file.read(encrypted, offset, encrypted.length - offset, offset);
              check();
              if (!result.bytesRead) throw fail(400, 'Фотография повреждена.');
              offset += result.bytesRead;
            }
            const after = await file.stat();
            check();
            if (after.size !== before.size)
              throw fail(400, 'Фотография изменилась во время загрузки.');
          } finally {
            await file.close();
          }
          // Encrypted IO exposes no clinical bytes. Recheck current ACL and the
          // active photo row after the last file await, before creating plaintext.
          authorizeRead();
          // decode verifies the complete GCM tag before any plaintext is returned.
          const buffer = decode(encrypted);
          if (!Buffer.isBuffer(buffer) || buffer.length > MAX_PHOTO_BYTES)
            throw fail(400, 'Фотография повреждена.');
          check();
          return { mime, buffer };
        },
        { scopeKey: scopeKey === 'internal:unscoped' ? null : scopeKey, cancelled },
      );
      // Settling the queue promise is another await boundary. Generic readers
      // also return only currently authorized plaintext; HTTP guards again later.
      authorizeRead();
      if (retain) {
        retain(release);
        retained = true;
      }
      return image;
    } finally {
      if (!retained) release();
    }
  }
  return {
    read,
    stats: () => ({
      ...queue.snapshot(),
      maxActivePerScope: Math.min(2, concurrency),
      maxPendingPerScope: Math.min(4, capacity),
      jobs,
      bytes,
      maxJobs,
      maxBytes,
      scopes: scopes.size,
      maxJobsPerScope,
      maxBytesPerScope,
    }),
  };
}
// All tenant stores in one web process share this bounded read/response budget.
const photoReader = createPhotoReader();
module.exports = { createPhotoReader, photoReader, MAX_PHOTO_BYTES, GCM_OVERHEAD };
