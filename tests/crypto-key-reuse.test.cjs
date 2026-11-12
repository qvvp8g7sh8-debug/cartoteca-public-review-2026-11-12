const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../storage.cjs');

function legacySeal(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}
function legacyOpen(key, value) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(),
  );
}

test('store-local KeyObjects preserve legacy ciphertext, HMAC, nonce and authentication', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-key-reuse-'));
  const platformDir = path.join(dir, 'platform'),
    cabinetDir = path.join(dir, 'cabinet');
  let platform = createPlatformDatabase(platformDir),
    cabinet = createStorage(cabinetDir);
  const other = createStorage(path.join(dir, 'other'));
  t.after(() => {
    platform.db.close();
    cabinet.close();
    other.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-key-reuse-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const value = { name: 'Synthetic', items: [1, 'Тест'], empty: null };
  assert.ok(Buffer.isBuffer(platform.key));
  const cabinetKey = fs.readFileSync(path.join(cabinetDir, 'encryption.key'));
  const stores = [
    { key: platform.key, seal: platform.seal, open: platform.open },
    { key: cabinetKey, seal: cabinet.encode, open: cabinet.decode },
  ];
  const saved = stores.map((store) => {
    const ciphertext = store.seal(value);
    assert.deepEqual(legacyOpen(store.key, ciphertext), value);
    assert.deepEqual(store.open(legacySeal(store.key, value)), value);
    assert.notDeepEqual(ciphertext.subarray(0, 12), store.seal(value).subarray(0, 12));
    const damaged = Buffer.from(ciphertext);
    damaged[12] ^= 1;
    assert.throws(() => store.open(damaged));
    assert.throws(() => legacyOpen(crypto.randomBytes(32), ciphertext));
    return ciphertext;
  });
  assert.throws(() => other.decode(saved[1]));
  const photoBytes = Buffer.from([137, 80, 78, 71, 0, 255, 1]);
  assert.deepEqual(cabinet.open(cabinet.seal(photoBytes)), photoBytes);
  const email = 'synthetic@example.test';
  assert.equal(
    platform.emailHash(email),
    crypto.createHmac('sha256', platform.key).update(email).digest('hex'),
  );
  assert.equal(
    platform.limitKey('test', 'client'),
    'test:' + crypto.createHmac('sha256', platform.key).update('client').digest('hex'),
  );

  const originals = Object.fromEntries(
    ['createCipheriv', 'createDecipheriv', 'createHmac'].map((name) => [name, crypto[name]]),
  );
  const keys = [];
  try {
    for (const name of Object.keys(originals))
      crypto[name] = function (algorithm, key, ...args) {
        keys.push(key);
        return originals[name].call(this, algorithm, key, ...args);
      };
    for (let i = 0; i < 3; i++) {
      platform.open(platform.seal(value));
      platform.emailHash(email);
      platform.limitKey('test', 'client');
    }
    assert.ok(keys.every((key) => key instanceof crypto.KeyObject));
    assert.equal(new Set(keys).size, 1);
    const platformKeyObject = keys[0];
    keys.length = 0;
    for (let i = 0; i < 3; i++) {
      cabinet.decode(cabinet.encode(value));
      cabinet.indexes.appointments('2030-01-01', '2030-01-01');
    }
    assert.ok(keys.every((key) => key instanceof crypto.KeyObject));
    assert.equal(new Set(keys).size, 1);
    assert.notEqual(keys[0], platformKeyObject);
  } finally {
    Object.assign(crypto, originals);
  }
  platform.db.close();
  cabinet.close();
  platform = createPlatformDatabase(platformDir);
  cabinet = createStorage(cabinetDir);
  assert.deepEqual(platform.open(saved[0]), value);
  assert.deepEqual(cabinet.decode(saved[1]), value);
  assert.equal(cabinet.db.prepare('PRAGMA user_version').get().user_version, 1);
});
