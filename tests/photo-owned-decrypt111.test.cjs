const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage.cjs');
const {
  photoReader,
  MAX_PHOTO_BYTES,
  GCM_OVERHEAD,
} = require('../src/server/infrastructure/photos/photo-reader.cjs');
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'cartoteca-photo-owned111-'));
  const storage = createStorage(directory, { photoOrganizationId: 'synthetic-owned111' });
  t.after(() => {
    try {
      storage.close();
    } finally {
      const resolved = fs.realpathSync(directory);
      assert.equal(path.dirname(resolved), parent);
      assert.ok(path.basename(resolved).startsWith('cartoteca-photo-owned111-'));
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  const id = 'a'.repeat(32);
  storage.db.prepare('INSERT INTO photos VALUES(?,?,1)').run(id, 'image/png');
  return { storage, id, filename: path.join(storage.photoDir, id + '.enc') };
}
test('real maximum10MiB photo decrypts within unchanged32/64MiB reservations and retains capacity until response release', async (t) => {
  const f = fixture(t);
  const plaintext = Buffer.alloc(MAX_PHOTO_BYTES, 0x5a);
  const ciphertext = f.storage.seal(plaintext);
  assert.equal(
    ciphertext.length,
    MAX_PHOTO_BYTES + GCM_OVERHEAD,
    'cabinet format is IV12+GCMtag16+ciphertext, without an additional magic prefix',
  );
  fs.writeFileSync(f.filename, ciphertext);
  let release;
  try {
    const image = await f.storage.photoAsync(f.id, {
      retain: (done) => {
        release = done;
      },
    });
    assert.equal(image.mime, 'image/png');
    assert.deepEqual(image.buffer, plaintext);
    const stats = photoReader.stats();
    assert.equal(stats.maxBytes, 64 * 1024 * 1024);
    assert.equal(stats.maxBytesPerScope, 32 * 1024 * 1024);
    assert.equal(stats.bytes, ciphertext.length * 3);
    assert.equal(stats.jobs, 1);
    assert.equal(stats.scopes, 1);
    assert.deepEqual(
      fs.readFileSync(f.filename),
      ciphertext,
      'decoding never mutates persisted ciphertext',
    );
  } finally {
    release?.();
  }
  assert.equal(photoReader.stats().jobs, 0);
  assert.equal(photoReader.stats().bytes, 0);
  assert.equal(photoReader.stats().scopes, 0);
});
test('owned photo decoder leaves its complete input unchanged, authenticates the full tag and keeps legacy open input forms', async (t) => {
  const f = fixture(t);
  const plaintext = Buffer.from('synthetic UTF8 photo bytes — 111');
  const ciphertext = f.storage.seal(plaintext),
    before = Buffer.from(ciphertext);
  // Intercept only the reader boundary to inspect the exact private-input
  // decoder selected by real storage; no global crypto/Buffer interception.
  t.mock.method(photoReader, 'read', async (options) => {
    options.authorize();
    const decoded = options.decode(ciphertext);
    assert.deepEqual(ciphertext, before);
    assert.deepEqual(decoded, plaintext);
    const corrupt = Buffer.from(ciphertext);
    corrupt[12] ^= 1;
    assert.throws(
      () => options.decode(corrupt),
      'unauthenticated plaintext must never be returned',
    );
    return { mime: options.mime, buffer: decoded };
  });
  assert.deepEqual((await f.storage.photoAsync(f.id)).buffer, plaintext);
  assert.deepEqual(f.storage.open(Uint8Array.from(ciphertext)), plaintext);
  assert.deepEqual(f.storage.open(Array.from(ciphertext)), plaintext);
  assert.deepEqual(ciphertext, before);
});
test('real async corruption returns no photo and releases every reserved byte and scope', async (t) => {
  const f = fixture(t);
  const ciphertext = f.storage.seal(Buffer.from('synthetic corrupted-tag photo'));
  ciphertext[12] ^= 1;
  fs.writeFileSync(f.filename, ciphertext);
  let retained = false;
  await assert.rejects(
    f.storage.photoAsync(f.id, {
      retain: () => {
        retained = true;
      },
    }),
  );
  assert.equal(retained, false);
  assert.equal(photoReader.stats().jobs, 0);
  assert.equal(photoReader.stats().bytes, 0);
  assert.equal(photoReader.stats().scopes, 0);
});
