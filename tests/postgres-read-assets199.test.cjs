const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const {
  createOperationCryptoCache,
} = require('../src/server/infrastructure/postgres/read-operation-crypto145.cjs');
const io = fs.promises;
const active = () => {};
async function fixture(t) {
  const root = await io.mkdtemp(path.join(os.tmpdir(), 'cartoteca-assets199-'));
  const platformStoreId = randomUUID(),
    rootCabinetStoreId = randomUUID();
  const marker = {
    version: 1,
    backend: 'postgres',
    migrationId: randomUUID(),
    platformStoreId,
    rootCabinetStoreId,
    budgetStoreId: null,
    notificationSchema: 19,
    cabinetSchema: 1,
    cabinetTemplates: { 1: 'a'.repeat(64), 2: 'b'.repeat(64) },
    stores: [
      {
        kind: 'platform',
        storeId: platformStoreId,
        organizationId: null,
        relativeDirectory: 'platform',
        schemaVersion: 19,
      },
      {
        kind: 'cabinet',
        storeId: rootCabinetStoreId,
        organizationId: randomUUID(),
        relativeDirectory: '.',
        schemaVersion: 1,
      },
    ],
  };
  const one = path.join(root, 'tenants', 'one'),
    two = path.join(root, 'tenants', 'two');
  await io.mkdir(path.join(root, 'platform'));
  await io.mkdir(one, { recursive: true });
  await io.mkdir(two);
  await io.writeFile(path.join(root, 'postgresql-runtime.json'), JSON.stringify(marker));
  for (const file of [
    'platform/platform.key',
    'encryption.key',
    'tenants/one/encryption.key',
    'tenants/two/encryption.key',
  ])
    await io.writeFile(path.join(root, file), randomBytes(32));
  let cache;
  t.after(async () => {
    cache?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('cartoteca-assets199-'));
    await io.rm(root, { recursive: true, force: true });
  });
  cache = await createOperationCryptoCache(root, marker, { maximumEntries: 8 });
  return { root, one, two, cache };
}

test('fresh key phases deduplicate only current concurrent observations, including common parents', async (t) => {
  const f = await fixture(t);
  await f.cache.forOperation(f.one, active);
  await f.cache.forOperation(f.two, active);
  const lstat = io.lstat.bind(io),
    calls = [];
  t.mock.method(io, 'lstat', async (...args) => {
    calls.push(args[0]);
    return lstat(...args);
  });
  await f.cache.forPlatform(active);
  assert.equal(calls.length, 4);
  calls.length = 0;
  await f.cache.forOperation(f.one, active);
  assert.equal(calls.length, 7, 'one shared root is observed once within the API call');
  calls.length = 0;
  const pair = await Promise.all([f.cache.forPlatform(active), f.cache.forPlatform(active)]);
  assert.equal(calls.length, 4);
  assert.equal(pair[0].keyGeneration196, pair[1].keyGeneration196);
  calls.length = 0;
  const cabinets = await Promise.all([
    f.cache.forOperation(f.one, active),
    f.cache.forOperation(f.two, active),
  ]);
  const platformKey = path.join(f.root, 'platform', 'platform.key');
  assert.equal(new Set(calls.filter((file) => !file.endsWith('.key'))).size, 6);
  assert.equal(calls.filter((file) => !file.endsWith('.key')).length, 6);
  assert.equal(calls.filter((file) => file === path.join(f.one, 'encryption.key')).length, 1);
  assert.equal(calls.filter((file) => file === path.join(f.two, 'encryption.key')).length, 1);
  assert.ok([1, 2].includes(calls.filter((file) => file === platformKey).length));
  // Different parent IO can finish in different turns. A later P-key request
  // MUST remain separate if the other caller's P-key stat has already launched.
  assert.ok([9, 10].includes(calls.length));
  assert.notEqual(cabinets[0].cabinet.keyGeneration196, cabinets[1].cabinet.keyGeneration196);
  calls.length = 0;
  await f.cache.forPlatform(active);
  assert.equal(calls.length, 4, 'a subsequent SQL/COMMIT phase performs all fresh observations');
});

test('uncached reads retain no-follow/open/fstat/read/fstat/close/post-lstat, also with concurrent cache hits', async (t) => {
  const f = await fixture(t),
    target = path.join(f.one, 'encryption.key');
  const lstat = io.lstat.bind(io),
    open = io.open.bind(io),
    trace = [];
  t.mock.method(io, 'lstat', async (...args) => {
    if (args[0] === target) trace.push('lstat');
    return lstat(...args);
  });
  t.mock.method(io, 'open', async (file, flags) => {
    const handle = await open(file, flags);
    if (file !== target) return handle;
    assert.equal(flags, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    trace.push('open');
    return {
      stat: async (...args) => {
        trace.push('fstat');
        return handle.stat(...args);
      },
      readFile: async () => {
        trace.push('read32');
        return handle.readFile();
      },
      close: async () => {
        trace.push('close');
        return handle.close();
      },
    };
  });
  const [miss, platform] = await Promise.all([
    f.cache.forOperation(f.one, active),
    f.cache.forPlatform(active),
  ]);
  assert.deepEqual(trace, ['lstat', 'open', 'fstat', 'read32', 'fstat', 'close', 'lstat']);
  assert.deepEqual(platform.decode(miss.platform.encode({ value: 'synthetic' })), {
    value: 'synthetic',
  });
  const two = await f.cache.forOperation(f.one, active);
  assert.equal(miss.cabinet.keyGeneration196, two.cabinet.keyGeneration196);
  assert.deepEqual(two.cabinet.decode(miss.cabinet.encode({ value: 1 })), { value: 1 });
});

test('concurrent cold callers preserve key bytes and cancellation remains local to its caller', async (t) => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([
    f.cache.forOperation(f.one, active),
    f.cache.forOperation(f.one, active),
  ]);
  assert.deepEqual(two.cabinet.decode(one.cabinet.encode({ value: 'cold' })), { value: 'cold' });
  let cancelled = false;
  const lstat = io.lstat.bind(io);
  t.mock.method(io, 'lstat', async (...args) => {
    const result = await lstat(...args);
    if (args[0] === path.join(f.root, 'postgresql-runtime.json')) cancelled = true;
    return result;
  });
  const check = () => {
    if (cancelled) throw Object.assign(Error('cancelled'), { status: 499 });
  };
  const [rejected, accepted] = await Promise.allSettled([
    f.cache.forOperation(f.one, check),
    f.cache.forOperation(f.one, active),
  ]);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason.status, 499);
  assert.equal(accepted.status, 'fulfilled');
  assert.deepEqual(accepted.value.cabinet.decode(one.cabinet.encode({ value: 2 })), { value: 2 });
});

test('a fresh marker or parent failure prevents key observations; cached key replacement still fails closed', async (t) => {
  const f = await fixture(t);
  await f.cache.forOperation(f.one, active);
  const target = path.join(f.one, 'encryption.key');
  await io.writeFile(target, randomBytes(32));
  await assert.rejects(f.cache.forOperation(f.one, active), {
    code: 'POSTGRES_READ_ASSETS_CHANGED',
  });
  const lstat = io.lstat.bind(io),
    keys = [];
  t.mock.method(io, 'lstat', async (...args) => {
    if (String(args[0]).endsWith('.key')) keys.push(args[0]);
    return lstat(...args);
  });
  await io.rename(path.join(f.root, 'platform'), path.join(f.root, 'old-platform'));
  await io.writeFile(path.join(f.root, 'platform'), 'not a directory');
  await assert.rejects(f.cache.forPlatform(active), { code: 'POSTGRES_READ_ASSETS_CHANGED' });
  assert.equal(keys.length, 0);
  await io.unlink(path.join(f.root, 'platform'));
  await io.rename(path.join(f.root, 'old-platform'), path.join(f.root, 'platform'));
  await io.appendFile(path.join(f.root, 'postgresql-runtime.json'), '\n');
  await assert.rejects(f.cache.forPlatform(active), { code: 'POSTGRES_READ_ASSETS_CHANGED' });
  assert.equal(keys.length, 0);
});

test('cancellation and close before dispatch launch no IO; replacement during uncached open is detected', async (t) => {
  const f = await fixture(t),
    lstat = io.lstat.bind(io),
    open = io.open.bind(io);
  let calls = 0;
  t.mock.method(io, 'lstat', async (...args) => {
    calls++;
    return lstat(...args);
  });
  await assert.rejects(
    f.cache.forPlatform(() => {
      throw Object.assign(Error('cancelled'), { status: 499 });
    }),
    { status: 499 },
  );
  assert.equal(calls, 0);
  const target = path.join(f.one, 'encryption.key');
  t.mock.method(io, 'open', async (file, flags) => {
    if (file === target) await io.writeFile(target, randomBytes(32));
    return open(file, flags);
  });
  await assert.rejects(f.cache.forOperation(f.one, active), {
    code: 'POSTGRES_READ_ASSETS_CHANGED',
  });
  calls = 0;
  const queued = f.cache.forPlatform(active);
  f.cache.close();
  await assert.rejects(queued, { status: 503 });
  await new Promise(setImmediate);
  assert.equal(calls, 0);
});
