const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  captureSourceProof,
  assertSourceProof,
} = require('../src/server/infrastructure/postgres/migration-source-proof.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-pg123-source-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-pg123-source-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'platform'));
  fs.mkdirSync(path.join(root, 'photos'));
  for (const [file, value] of Object.entries({
    'platform/platform.sqlite': 'synthetic database',
    'platform/platform.key': Buffer.alloc(32, 1),
    'platform/assistant-state.enc': 'synthetic assistant ciphertext',
    'cabinet.sqlite': 'synthetic cabinet',
    'encryption.key': Buffer.alloc(32, 2),
    ['photos/' + 'a'.repeat(32) + '.enc']: Buffer.alloc(2 * 1024 * 1024, 3),
  }))
    fs.writeFileSync(path.join(root, file), value);
  return root;
}
test('offline source proof streams durable bytes while accepting only SHM and empty WAL maintenance', (t) => {
  const root = fixture(t),
    read = fs.readSync;
  let largest = 0;
  const mock = t.mock.method(
    fs,
    'readSync',
    function (descriptor, buffer, offset, length, position) {
      largest = Math.max(largest, length);
      return read.call(fs, descriptor, buffer, offset, length, position);
    },
  );
  const before = captureSourceProof(root);
  assert.equal(before.files, 6);
  assert.ok(largest <= 128 * 1024);
  fs.writeFileSync(path.join(root, 'platform/platform.sqlite-shm'), 'technical index');
  fs.writeFileSync(path.join(root, 'platform/platform.sqlite-wal'), '');
  assert.equal(assertSourceProof(root, before), true);
  mock.mock.restore();
});
test('changed durable file, new nonempty WAL, new tenant and new photo are refused', (t) => {
  const root = fixture(t),
    before = captureSourceProof(root);
  for (const relative of [
    'platform/platform.sqlite',
    'platform/platform.key',
    'platform/assistant-state.enc',
    'photos/' + 'a'.repeat(32) + '.enc',
  ]) {
    const file = path.join(root, relative),
      original = fs.readFileSync(file),
      changed = Buffer.from(original);
    changed[0] ^= 1;
    fs.writeFileSync(file, changed);
    assert.throws(
      () => assertSourceProof(root, before),
      (error) => error.code === 'POSTGRES_SOURCE_CHANGED',
    );
    fs.writeFileSync(file, original);
  }
  for (const relative of ['platform/platform.sqlite-wal', 'photos/' + 'b'.repeat(32) + '.enc']) {
    const file = path.join(root, relative);
    fs.writeFileSync(file, 'new durable bytes');
    assert.throws(
      () => assertSourceProof(root, before),
      (error) => error.code === 'POSTGRES_SOURCE_CHANGED',
    );
    fs.unlinkSync(file);
  }
  const tenant = path.join(root, 'tenants', 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12));
  fs.mkdirSync(tenant, { recursive: true });
  fs.writeFileSync(path.join(tenant, 'cabinet.sqlite'), 'new clinical store');
  assert.throws(
    () => assertSourceProof(root, before),
    (error) => error.code === 'POSTGRES_SOURCE_CHANGED',
  );
});
test('a retained committed WAL is part of the proof, and can never be silently discarded', (t) => {
  const root = fixture(t),
    file = path.join(root, 'cabinet.sqlite-wal');
  fs.writeFileSync(file, 'retained committed WAL');
  const before = captureSourceProof(root);
  fs.unlinkSync(file);
  assert.throws(
    () => assertSourceProof(root, before),
    (error) => error.code === 'POSTGRES_SOURCE_CHANGED',
  );
});
