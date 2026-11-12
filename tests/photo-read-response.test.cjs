const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { servePhoto } = require('../src/server/http/photo-response.cjs');
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(method = 'GET') {
  const gate = deferred(),
    entered = deferred(),
    bytes = Buffer.from('synthetic authenticated photo');
  const original = {
    accountId: 'account',
    organizationId: 'org',
    role: 'cosmetologist',
    globalAdmin: false,
  };
  let session = { ...original },
    visible = true,
    reads = 0,
    released = 0,
    tenantCalls = 0;
  const req = { method, aborted: false },
    res = new EventEmitter();
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
    },
  });
  const context = {
    req,
    res,
    id: 'a'.repeat(32),
    requireCurrent: () => {
      if (!session) throw Object.assign(Error('login'), { status: 401 });
      return { ...session };
    },
    assertRequestContext: (current) => {
      if (current.accountId !== 'account' || current.organizationId !== 'org')
        throw Object.assign(Error('tab context'), { status: 428 });
    },
    tenantStore: () => {
      tenantCalls++;
      return {
        indexes: { photoVisible: () => visible },
        photo: () => assert.fail('HTTP cannot fall back to a blocking read'),
        async photoAsync(_id, { retain }) {
          reads++;
          entered.resolve();
          await gate.promise;
          retain(() => released++);
          return { mime: 'image/png', buffer: bytes };
        },
      };
    },
  };
  return {
    ...context,
    bytes,
    gate,
    entered,
    context,
    session: (value) => {
      session = value;
    },
    original,
    visibility: (value) => {
      visible = value;
    },
    counts: () => ({ reads, released, tenantCalls }),
  };
}

for (const method of ['GET', 'HEAD']) {
  test(`${method} preserves headers and retains the read buffer until finish/close`, async () => {
    const f = fixture(method),
      pending = servePhoto(f.context);
    await f.entered.promise;
    f.gate.resolve();
    await pending;
    assert.equal(f.res.status, 200);
    assert.deepEqual(f.res.headers, {
      'Content-Type': 'image/png',
      'Content-Length': f.bytes.length,
    });
    assert.deepEqual(f.res.body, method === 'HEAD' ? undefined : f.bytes);
    assert.equal(f.counts().released, 0);
    f.res.emit('finish');
    f.res.emit('close');
    assert.equal(f.counts().released, 1);
  });
}

for (const [change, status] of [
  ['logout', 401],
  ['account', 428],
  ['organization', 428],
  ['role', 403],
  ['globalAdmin', 403],
  ['photoACL', 404],
  ['abort', 408],
]) {
  test(`${change} during async photo read never returns private bytes`, async () => {
    const f = fixture(),
      pending = servePhoto(f.context);
    const rejected = assert.rejects(pending, { status });
    await f.entered.promise;
    if (change === 'logout') f.session(null);
    if (change === 'account') f.session({ ...f.original, accountId: 'other-account' });
    if (change === 'organization') f.session({ ...f.original, organizationId: 'other-org' });
    if (change === 'role') f.session({ ...f.original, role: 'owner' });
    if (change === 'globalAdmin') f.session({ ...f.original, globalAdmin: true });
    if (change === 'photoACL') f.visibility(false);
    if (change === 'abort') f.req.aborted = true;
    f.gate.resolve();
    await rejected;
    assert.equal(f.res.headersSent, false);
    assert.equal(f.res.body, undefined);
    assert.equal(f.counts().released, 1);
  });
}

test('a stale parallel-tab identity is refused before tenant access or read allocation', async () => {
  const f = fixture();
  f.session({ ...f.original, accountId: 'another-tab-account' });
  await assert.rejects(servePhoto(f.context), { status: 428 });
  assert.deepEqual(f.counts(), { reads: 0, released: 0, tenantCalls: 0 });
});

test('an initial foreign-photo ACL denial performs no async read', async () => {
  const f = fixture();
  f.visibility(false);
  await assert.rejects(servePhoto(f.context), { status: 404 });
  assert.equal(f.counts().reads, 0);
});

test('an absolute response deadline destroys a stalled output but never releases before the close event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let destroys = 0;
  f.res.destroy = () => {
    destroys++;
    f.res.destroyed = true;
  };
  const pending = servePhoto({ ...f.context, responseDeadlineMs: 30 });
  await f.entered.promise;
  f.gate.resolve();
  await pending;
  assert.equal(f.res.headersSent, true);
  assert.equal(f.counts().released, 0);
  t.mock.timers.tick(29);
  assert.equal(destroys, 0);
  t.mock.timers.tick(1);
  assert.equal(destroys, 1);
  assert.equal(f.counts().released, 0);
  f.res.emit('close');
  assert.equal(f.counts().released, 1);
  f.res.emit('finish');
  t.mock.timers.tick(100);
  assert.equal(destroys, 1);
  assert.equal(f.counts().released, 1);
});

test('the deadline includes the pending read and a late result cannot send headers or bytes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let destroys = 0;
  f.res.destroy = () => {
    destroys++;
    f.res.destroyed = true;
  };
  const pending = servePhoto({ ...f.context, responseDeadlineMs: 30 });
  const rejected = assert.rejects(pending, { status: 408 });
  await f.entered.promise;
  t.mock.timers.tick(30);
  assert.equal(destroys, 1);
  assert.equal(f.counts().released, 0, 'pending read has not settled');
  f.res.emit('close');
  assert.equal(f.counts().released, 0);
  f.gate.resolve();
  await rejected;
  assert.equal(f.counts().released, 1);
  assert.equal(f.res.headersSent, false);
  assert.equal(f.res.body, undefined);
});

test('normal completion clears the deadline and end errors retain a handed-off buffer until close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const normal = fixture();
  let destroyed = 0;
  normal.res.destroy = () => {
    destroyed++;
    normal.res.destroyed = true;
  };
  const completed = servePhoto({ ...normal.context, responseDeadlineMs: 30 });
  await normal.entered.promise;
  normal.gate.resolve();
  await completed;
  normal.res.emit('finish');
  t.mock.timers.tick(100);
  assert.equal(destroyed, 0);
  assert.equal(normal.counts().released, 1);
  const broken = fixture();
  broken.res.end = () => {
    throw Error('synthetic write failure');
  };
  broken.res.destroy = () => {
    destroyed++;
    broken.res.destroyed = true;
  };
  const failed = servePhoto({ ...broken.context, responseDeadlineMs: 30 });
  const rejected = assert.rejects(failed, /synthetic write failure/);
  await broken.entered.promise;
  broken.gate.resolve();
  await rejected;
  assert.equal(destroyed, 1);
  assert.equal(broken.counts().released, 0);
  broken.res.emit('close');
  assert.equal(broken.counts().released, 1);
});

// A malformed historical membership can never grant a global administrator
// clinical access, even when it happens to carry an organization and owner role.
test('global administrator cannot begin a clinical photo read through a historical membership', async () => {
  const f = fixture();
  f.session({ ...f.original, role: 'owner', globalAdmin: true });
  await assert.rejects(servePhoto(f.context), { status: 403 });
  assert.deepEqual(f.counts(), { reads: 0, released: 0, tenantCalls: 0 });
});
