const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { digest } = require('./catalog-sqlite.cjs');
const { validateRuntimeProfile } = require('./runtime.cjs');
const { createFreshAssetStats199 } = require('./fresh-asset-stats199.cjs');
const changed = () =>
  Object.assign(Error('PostgreSQL encryption assets changed'), {
    status: 503,
    code: 'POSTGRES_READ_ASSETS_CHANGED',
  });
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.gid].join(':');
async function createOperationCryptoCache(dataDir, marker, { maximumEntries = 512 } = {}) {
  if (!Number.isInteger(maximumEntries) || maximumEntries < 2 || maximumEntries > 1024)
    throw Error('Invalid key cache bound');
  const root = path.resolve(dataDir),
    markerPath = path.join(root, 'postgresql-runtime.json');
  const mi = await fs.promises.lstat(markerPath, { bigint: true });
  if (!mi.isFile() || mi.isSymbolicLink() || mi.nlink !== 1n || mi.size > 16n * 1024n * 1024n)
    throw changed();
  const actual = validateRuntimeProfile(JSON.parse(await fs.promises.readFile(markerPath, 'utf8')));
  if (digest(actual) !== digest(marker)) throw changed();
  const markerStamp = stamp(mi),
    keys = new Map();
  let closed = false,
    reads = 0;
  const observations = createFreshAssetStats199();
  async function freshPhase(specifications, assertActive) {
    assertActive();
    if (closed) throw changed();
    const parents = new Set();
    const targets = specifications.map(([directory, filename]) => {
      const target = path.resolve(directory, filename);
      if (
        !target.startsWith(root + path.sep) ||
        !['platform.key', 'encryption.key'].includes(filename)
      )
        throw changed();
      let parent = path.dirname(target);
      for (;;) {
        parents.add(parent);
        if (parent === root) break;
        const next = path.dirname(parent);
        if (next === parent || !next.startsWith(root)) throw changed();
        parent = next;
      }
      return target;
    });
    const [current, ...directories] = await observations.read([
      { path: markerPath, bigint: true },
      ...[...parents].map((parent) => ({ path: parent })),
    ]);
    assertActive();
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      stamp(current) !== markerStamp
    )
      throw changed();
    for (const info of directories) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw changed();
    }
    if (closed) throw changed();
    const before = await observations.read(
      targets.map((target) => ({ path: target, bigint: true })),
    );
    assertActive();
    if (closed) throw changed();
    return targets.map((target, index) => ({ target, before: before[index] }));
  }
  async function load({ target, before }) {
    if (closed) throw changed();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== 32n)
      throw changed();
    const previous = keys.get(target);
    if (previous) {
      if (stamp(before) !== previous.stamp) throw changed();
      keys.delete(target);
      keys.set(target, previous);
      return {
        raw: Buffer.from(previous.raw),
        generation: previous.generation,
      };
    }
    const file = await fs.promises.open(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let raw;
    try {
      const opened = await file.stat({ bigint: true });
      if (stamp(opened) !== stamp(before)) throw changed();
      raw = await file.readFile();
      if (raw.byteLength !== 32 || stamp(await file.stat({ bigint: true })) !== stamp(before))
        throw changed();
    } finally {
      await file.close();
    }
    const after = await fs.promises.lstat(target, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || stamp(after) !== stamp(before) || closed) {
      raw.fill(0);
      throw changed();
    }
    while (keys.size >= maximumEntries) {
      const oldest = keys.keys().next().value;
      keys.get(oldest).raw.fill(0);
      keys.delete(oldest);
    }
    reads++;
    const generation = Object.freeze({});
    keys.set(target, { raw, stamp: stamp(after), generation });
    return { raw: Buffer.from(raw), generation };
  }
  // Platform key is read once at startup; all hits still asynchronously check
  // identity/link/length/marker. There is no synchronous request-path file IO.
  const platformSpec = [path.join(root, 'platform'), 'platform.key'];
  (await load((await freshPhase([platformSpec], () => {}))[0])).raw.fill(0);
  return {
    async forPlatform(assertActive) {
      assertActive();
      const raw = await load((await freshPhase([platformSpec], assertActive))[0]);
      assertActive();
      return keyCrypto(raw, assertActive, true);
    },
    async forOperation(directory, assertActive) {
      try {
        assertActive();
        const checked = await freshPhase(
          [platformSpec, [directory, 'encryption.key']],
          assertActive,
        );
        const [platform, cabinet] = await Promise.all(checked.map(load));
        assertActive();
        return {
          platform: keyCrypto(platform, assertActive, true),
          cabinet: keyCrypto(cabinet, assertActive, false),
        };
      } catch (error) {
        if (error.status) throw error;
        throw changed();
      }
    },
    stats: () => ({ entries: keys.size, maximumEntries, reads }),
    close() {
      closed = true;
      observations.close();
      for (const entry of keys.values()) entry.raw.fill(0);
      keys.clear();
    },
  };
}
function keyCrypto({ raw, generation }, assertActive, platform) {
  const key = crypto.createSecretKey(raw);
  raw.fill(0);
  const seal = (input) => {
    assertActive();
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const value = platform ? Buffer.from(JSON.stringify(input)) : Buffer.from(input);
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  };
  return {
    // Opaque identity of this exact checked key-cache entry. It contains no key
    // material or clinical references and changes after eviction/reload.
    keyGeneration196: generation,
    encode: platform ? seal : (value) => seal(Buffer.from(JSON.stringify(value))),
    decode(input) {
      assertActive();
      const value = Buffer.from(input),
        decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'),
      );
    },
    hash(value) {
      assertActive();
      return crypto.createHmac('sha256', key).update(value).digest('hex');
    },
  };
}
module.exports = { createOperationCryptoCache };
