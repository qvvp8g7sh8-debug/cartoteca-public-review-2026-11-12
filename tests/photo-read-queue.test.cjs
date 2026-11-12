const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createPhotoReader,
  MAX_PHOTO_BYTES,
  GCM_OVERHEAD,
} = require('../src/server/infrastructure/photos/photo-reader.cjs');
const { createStorage } = require('../storage.cjs');
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture({
  bytes = Buffer.from('synthetic authenticated photo'),
  chunk = 3,
  failure,
  oversized,
  grow,
  gate,
} = {}) {
  const key = Buffer.alloc(32, 7),
    iv = Buffer.alloc(12, 3);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  const calls = { opened: 0, read: 0, closed: 0, stat: 0, decoded: 0 };
  const io = {
    async open() {
      calls.opened++;
      if (failure === 'open') throw Error('synthetic open failure');
      return {
        async stat() {
          calls.stat++;
          if (failure === 'stat') throw Error('synthetic stat failure');
          return {
            isFile: () => true,
            size: oversized
              ? MAX_PHOTO_BYTES + GCM_OVERHEAD + 1
              : packed.length + (grow && calls.stat % 2 === 0 ? 1 : 0),
          };
        },
        async read(target, offset, length, position) {
          calls.read++;
          if (gate) await gate.promise;
          if (failure === 'read') throw Error('synthetic read failure');
          if (failure === 'eof') return { bytesRead: 0 };
          const size = Math.min(chunk, length, packed.length - position);
          packed.copy(target, offset, position, position + size);
          return { bytesRead: size };
        },
        async close() {
          calls.closed++;
          if (failure === 'close') throw Error('synthetic close failure');
        },
      };
    },
  };
  const decode = (value) => {
    calls.decoded++;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
  };
  return {
    io,
    decode,
    packed,
    bytes,
    calls,
    input: { filename: 'synthetic.enc', mime: 'image/png', decode },
  };
}

test('bounded async reads authenticate all bytes, support partial reads and retain capacity until response completion', async () => {
  const f = fixture(),
    reader = createPhotoReader({ io: f.io });
  let release;
  const image = await reader.read({
    ...f.input,
    retain: (done) => {
      release = done;
    },
  });
  assert.deepEqual(image, { mime: 'image/png', buffer: f.bytes });
  assert.ok(f.calls.read > 1);
  assert.equal(f.calls.closed, 1);
  assert.equal(reader.stats().jobs, 1);
  assert.equal(reader.stats().bytes, f.packed.length * 3);
  release();
  release();
  assert.equal(reader.stats().jobs, 0);
  assert.equal(reader.stats().bytes, 0);
});

test('invalid GCM never returns plaintext and releases the complete read budget', async () => {
  const f = fixture();
  f.packed[12] ^= 1;
  const reader = createPhotoReader({ io: f.io });
  await assert.rejects(reader.read(f.input));
  assert.equal(f.calls.closed, 1);
  assert.equal(reader.stats().jobs, 0);
  assert.equal(reader.stats().bytes, 0);
});

test('oversized ciphertext is refused before allocation/read; growth and premature EOF are refused', async () => {
  for (const options of [{ oversized: true }, { grow: true }, { failure: 'eof' }]) {
    const f = fixture(options),
      reader = createPhotoReader({ io: f.io });
    await assert.rejects(reader.read(f.input), { status: 400 });
    if (options.oversized) assert.equal(f.calls.read, 0);
    assert.equal(f.calls.decoded, 0);
    assert.equal(f.calls.closed, 1);
    assert.equal(reader.stats().bytes, 0);
  }
});

test('retained byte budget rejects another read and becomes available only after release', async () => {
  const f = fixture(),
    reader = createPhotoReader({ io: f.io, maxBytes: f.packed.length * 3 });
  let release;
  await reader.read({
    ...f.input,
    retain: (done) => {
      release = done;
    },
  });
  await assert.rejects(
    reader.read(f.input),
    (error) => error.status === 503 && error.code === 'PHOTO_READ_CAPACITY',
  );
  assert.equal(reader.stats().jobs, 1);
  release();
  assert.deepEqual((await reader.read(f.input)).buffer, f.bytes);
  assert.equal(reader.stats().jobs, 0);
});

test('active, waiting and retained jobs are bounded and revoked waiting work never opens a file', async () => {
  const gate = deferred(),
    f = fixture({ gate }),
    reader = createPhotoReader({ io: f.io, concurrency: 1, capacity: 1, maxJobs: 2 });
  const first = reader.read(f.input);
  await turn();
  let allowed = true;
  const second = reader.read({
    ...f.input,
    authorize: () => {
      if (!allowed) throw Object.assign(Error('revoked'), { status: 403 });
    },
  });
  const rejected = assert.rejects(second, { status: 403 });
  await assert.rejects(reader.read(f.input), { status: 503 });
  assert.equal(reader.stats().jobs, 2);
  assert.equal(reader.stats().queued, 1);
  allowed = false;
  gate.resolve();
  await first;
  await rejected;
  assert.equal(f.calls.opened, 1);
  assert.equal(reader.stats().jobs, 0);
});

test('access or cancellation changing during asynchronous IO blocks decryption and returns capacity', async () => {
  for (const cancelled of [false, true]) {
    const gate = deferred(),
      f = fixture({ gate }),
      reader = createPhotoReader({ io: f.io });
    let stopped = false;
    const running = reader.read({
      ...f.input,
      cancelled: () => cancelled && stopped,
      authorize: () => {
        if (!cancelled && stopped) throw Object.assign(Error('revoked'), { status: 403 });
      },
    });
    await turn();
    stopped = true;
    gate.resolve();
    await assert.rejects(running, { status: cancelled ? 408 : 403 });
    assert.equal(f.calls.decoded, 0);
    assert.equal(f.calls.closed, 1);
    assert.equal(reader.stats().jobs, 0);
  }
});

test('filesystem errors release slots, close every opened handle and never reach decoding', async () => {
  for (const failure of ['open', 'stat', 'read', 'close']) {
    const f = fixture({ failure }),
      reader = createPhotoReader({ io: f.io });
    await assert.rejects(reader.read(f.input), new RegExp('synthetic ' + failure));
    assert.equal(f.calls.closed, failure === 'open' ? 0 : 1);
    assert.equal(f.calls.decoded, 0);
    assert.equal(reader.stats().jobs, 0);
    assert.equal(reader.stats().bytes, 0);
  }
});

test('real storage async photo preserves encrypted format and active-row checks after awaiting', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-async-photo-'));
  const storage = createStorage(directory),
    id = 'a'.repeat(32),
    bytes = Buffer.from('synthetic photo');
  t.after(() => {
    storage.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  storage.db.prepare('INSERT INTO photos VALUES(?,?,1)').run(id, 'image/png');
  fs.writeFileSync(path.join(storage.photoDir, id + '.enc'), storage.seal(bytes));
  assert.deepEqual(await storage.photoAsync(id), storage.photo(id));
  let checks = 0;
  await assert.rejects(
    storage.photoAsync(id, {
      authorize: () => {
        if (++checks === 3) storage.db.prepare('UPDATE photos SET active=0 WHERE id=?').run(id);
      },
    }),
    { status: 404 },
  );
  assert.equal(checks, 3);
});

test('one organization cannot consume global jobs; six normal photos fit and empty scope counters disappear', async () => {
  const f = fixture(),
    reader = createPhotoReader({ io: f.io }),
    releases = [];
  for (let n = 0; n < 6; n++)
    await reader.read({ ...f.input, scopeKey: 'org-A', retain: (done) => releases.push(done) });
  await assert.rejects(reader.read({ ...f.input, scopeKey: 'org-A' }), {
    status: 503,
    code: 'PHOTO_READ_CAPACITY',
  });
  assert.equal(reader.stats().jobs, 6);
  await reader.read({ ...f.input, scopeKey: 'org-B', retain: (done) => releases.push(done) });
  assert.equal(reader.stats().jobs, 7);
  assert.equal(reader.stats().scopes, 2);
  assert.equal(JSON.stringify(reader.stats()).includes('org-A'), false);
  releases.forEach((done) => {
    done();
    done();
  });
  assert.equal(reader.stats().jobs, 0);
  assert.equal(reader.stats().bytes, 0);
  assert.equal(reader.stats().scopes, 0);
});

test('scope byte budget is independent from the global limit and failed reservations do not leak', async () => {
  const f = fixture(),
    reader = createPhotoReader({ io: f.io, maxBytesPerScope: f.packed.length * 3 });
  const releases = [];
  await reader.read({ ...f.input, scopeKey: 'org-A', retain: (done) => releases.push(done) });
  await assert.rejects(reader.read({ ...f.input, scopeKey: 'org-A' }), { status: 503 });
  await reader.read({ ...f.input, scopeKey: 'org-B', retain: (done) => releases.push(done) });
  assert.equal(reader.stats().jobs, 2);
  assert.equal(reader.stats().bytes, f.packed.length * 6);
  releases.forEach((done) => done());
  assert.equal(reader.stats().scopes, 0);
  assert.equal(reader.stats().bytes, 0);
});

test('an aborted pending file read keeps its slot and bytes until real IO settlement and FD close', async () => {
  const gate = deferred(),
    f = fixture({ gate }),
    reader = createPhotoReader({ io: f.io });
  let stopped = false;
  const pending = reader.read({ ...f.input, scopeKey: 'org-A', cancelled: () => stopped });
  const rejected = assert.rejects(pending, { status: 408 });
  await turn();
  stopped = true;
  assert.equal(reader.stats().jobs, 1);
  assert.equal(reader.stats().bytes, f.packed.length * 3);
  assert.equal(f.calls.closed, 0);
  gate.resolve();
  await rejected;
  assert.equal(f.calls.closed, 1);
  assert.equal(reader.stats().jobs, 0);
  assert.equal(reader.stats().scopes, 0);
});

test('real storage binds scope to the trusted constructor and ignores caller overrides', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-photo-scope-'));
  const stores = [0, 1].map((n) =>
    createStorage(path.join(root, String(n)), { photoOrganizationId: 'trusted-org' }),
  );
  const id = 'b'.repeat(32),
    releases = [];
  t.after(() => {
    releases.forEach((done) => done());
    stores.forEach((store) => store.close());
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const store of stores) {
    store.db.prepare('INSERT INTO photos VALUES(?,?,1)').run(id, 'image/png');
    fs.writeFileSync(
      path.join(store.photoDir, id + '.enc'),
      store.seal(Buffer.from('synthetic photo')),
    );
  }
  for (let n = 0; n < 6; n++)
    await stores[n % 2].photoAsync(id, {
      retain: (done) => releases.push(done),
      scopeKey: 'forged-' + n,
    });
  await assert.rejects(
    stores[0].photoAsync(id, { scopeKey: 'another-organization', photoOrganizationId: 'forged' }),
    { status: 503 },
  );
  releases.forEach((done) => done());
  assert.ok((await stores[1].photoAsync(id)).buffer.length);
});
