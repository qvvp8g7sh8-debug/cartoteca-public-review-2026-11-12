const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createPhotoReader } = require('../src/server/infrastructure/photos/photo-reader.cjs');
const { servePhoto } = require('../src/server/http/photo-response.cjs');
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture({ chunk = 7, at = async () => {} } = {}) {
  const plaintext = Buffer.from('Synthetic private authenticated clinical image');
  const key = Buffer.alloc(32, 7),
    nonce = Buffer.alloc(12, 9);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const packed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  const counts = { opened: 0, stat: 0, read: 0, close: 0, decoded: 0, authorized: 0 };
  let allowed = true,
    sizeChanged = false;
  const io = {
    async open() {
      counts.opened++;
      await at('open');
      return {
        async stat() {
          counts.stat++;
          await at(counts.stat === 1 ? 'first-stat' : 'last-stat');
          return {
            isFile: () => true,
            size: packed.length + (sizeChanged && counts.stat > 1 ? 1 : 0),
            ino: 1,
            dev: 1,
          };
        },
        async read(target, offset, length, position) {
          counts.read++;
          await at('read');
          const bytesRead = Math.min(chunk, length, packed.length - position);
          packed.copy(target, offset, position, position + bytesRead);
          return { bytesRead };
        },
        async close() {
          counts.close++;
          await at('close');
        },
      };
    },
  };
  const decode = (bytes) => {
    counts.decoded++;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  };
  const authorize = () => {
    counts.authorized++;
    if (!allowed) throw Object.assign(Error('Revoked synthetic access'), { status: 403 });
  };
  return {
    packed,
    plaintext,
    counts,
    io,
    decode,
    authorize,
    input: { filename: 'synthetic.enc', mime: 'image/png', decode, authorize },
    allow(value) {
      allowed = value;
    },
    grow() {
      sizeChanged = true;
    },
  };
}

test('fragmented encrypted IO performs four fresh authority phases and retains exactly the same byte reservation', async () => {
  const f = fixture({ chunk: 1 }),
    reader = createPhotoReader({ io: f.io });
  let release;
  const image = await reader.read({
    ...f.input,
    retain: (done) => {
      release = done;
    },
  });
  assert.deepEqual(image.buffer, f.plaintext);
  assert.ok(f.counts.read > 30);
  assert.equal(f.counts.authorized, 4, 'authority cost is independent of encrypted read chunks');
  assert.equal(f.counts.decoded, 1);
  assert.equal(f.counts.close, 1);
  assert.equal(reader.stats().jobs, 1);
  assert.equal(reader.stats().bytes, f.packed.length * 3);
  release();
  release();
  assert.equal(reader.stats().bytes, 0);
  assert.equal(reader.stats().scopes, 0);
});

for (const phase of ['first-stat', 'read', 'close'])
  test(`access revoked while awaiting ${phase} blocks decryption and returns every byte and job`, async () => {
    const gate = deferred(),
      entered = deferred();
    let blocked = false;
    const f = fixture({
      at: async (stage) => {
        if (stage === phase && !blocked) {
          blocked = true;
          entered.resolve();
          await gate.promise;
        }
      },
    });
    const reader = createPhotoReader({ io: f.io });
    const pending = reader.read(f.input),
      rejected = assert.rejects(pending, { status: 403 });
    await entered.promise;
    f.allow(false);
    gate.resolve();
    await rejected;
    assert.equal(f.counts.decoded, 0);
    assert.equal(f.counts.close, 1);
    assert.equal(reader.stats().jobs, 0);
    assert.equal(reader.stats().bytes, 0);
  });

test('scope changed while queued is rejected before a second file is opened', async () => {
  const gate = deferred(),
    entered = deferred();
  let blocking = true;
  const f = fixture({
    at: async (phase) => {
      if (phase === 'read' && blocking) {
        blocking = false;
        entered.resolve();
        await gate.promise;
      }
    },
  });
  const reader = createPhotoReader({ io: f.io, concurrency: 1, capacity: 2 });
  const first = reader.read({ ...f.input, scopeKey: 'trusted-A' });
  await entered.promise;
  let organization = 'trusted-B';
  const second = reader.read({
    ...f.input,
    scopeKey: 'trusted-B',
    authorize() {
      if (organization !== 'trusted-B')
        throw Object.assign(Error('Account context changed'), { status: 428 });
    },
  });
  const rejected = assert.rejects(second, { status: 428 });
  await turn();
  assert.equal(reader.stats().queued, 1);
  organization = 'other';
  gate.resolve();
  await first;
  await rejected;
  assert.equal(f.counts.opened, 1);
  assert.equal(reader.stats().jobs, 0);
});

test('changed ciphertext size or authentication tag is refused before any result can be retained', async () => {
  for (const kind of ['size', 'tag']) {
    let changed = false;
    const f = fixture({
      at: async (phase) => {
        if (phase === 'read' && !changed) {
          changed = true;
          if (kind === 'size') f.grow();
          else f.packed[12] ^= 1;
        }
      },
    });
    const reader = createPhotoReader({ io: f.io });
    let retained = false;
    await assert.rejects(
      reader.read({
        ...f.input,
        retain() {
          retained = true;
        },
      }),
    );
    assert.equal(retained, false);
    assert.equal(f.counts.decoded, kind === 'size' ? 0 : 1);
    assert.equal(f.counts.close, 1);
    assert.equal(reader.stats().jobs, 0);
    assert.equal(reader.stats().bytes, 0);
  }
});

test('generic callers also recheck after the queue promise settles before returning plaintext', async () => {
  const f = fixture(),
    reader = createPhotoReader({ io: f.io });
  await assert.rejects(
    reader.read({
      ...f.input,
      decode(bytes) {
        const image = f.decode(bytes);
        queueMicrotask(() => f.allow(false));
        return image;
      },
    }),
    { status: 403 },
  );
  assert.equal(f.counts.decoded, 1);
  assert.equal(reader.stats().jobs, 0);
  assert.equal(reader.stats().bytes, 0);
});

for (const change of ['membership', 'photo-active', 'staff-visibility', 'account-context'])
  test(`real photo reader composed with HTTP sends no headers or bytes after ${change} changes during IO`, async () => {
    const gate = deferred(),
      entered = deferred();
    let blocking = true;
    const f = fixture({
      at: async (phase) => {
        if (phase === 'read' && blocking) {
          blocking = false;
          entered.resolve();
          await gate.promise;
        }
      },
    });
    const reader = createPhotoReader({ io: f.io });
    let session = {
      accountId: 'staff',
      organizationId: 'org',
      role: 'cosmetologist',
      globalAdmin: false,
    };
    let visible = true,
      active = true;
    const res = new EventEmitter();
    Object.assign(res, {
      destroyed: false,
      headersSent: false,
      writeHead() {
        this.headersSent = true;
      },
      end(bytes) {
        this.body = bytes;
      },
    });
    const pending = servePhoto({
      req: { method: 'GET', aborted: false },
      res,
      id: 'a'.repeat(32),
      requireCurrent() {
        if (!session) throw Object.assign(Error('Revoked'), { status: 401 });
        return { ...session };
      },
      assertRequestContext(current) {
        if (current.accountId !== 'staff' || current.organizationId !== 'org')
          throw Object.assign(Error('Other account context'), { status: 428 });
      },
      tenantStore() {
        return {
          indexes: { photoVisible: () => visible },
          photoAsync(_id, options) {
            return reader.read({
              ...f.input,
              ...options,
              authorize() {
                options.authorize();
                if (!active) throw Object.assign(Error('Inactive photo'), { status: 404 });
              },
            });
          },
        };
      },
    });
    const status = change === 'membership' ? 401 : change === 'account-context' ? 428 : 404;
    const rejected = assert.rejects(pending, { status });
    await entered.promise;
    if (change === 'membership') session = null;
    if (change === 'account-context') session.organizationId = 'another-org';
    if (change === 'photo-active') active = false;
    if (change === 'staff-visibility') visible = false;
    gate.resolve();
    await rejected;
    assert.equal(f.counts.decoded, 0);
    assert.equal(res.headersSent, false);
    assert.equal(res.body, undefined);
    assert.equal(reader.stats().jobs, 0);
    assert.equal(reader.stats().bytes, 0);
  });
