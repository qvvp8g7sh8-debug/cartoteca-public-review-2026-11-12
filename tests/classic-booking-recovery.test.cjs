const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { publicSubmit } = require('../src/server/modules/booking/public-service.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { createBackupKey, createV2Backup, restoreV2Backup } = require('../src/server/infrastructure/backup/service.cjs');

for (const notificationSchema of [11, 15]) test(`schema ${notificationSchema}: classic mode, accepted appointment and retry receipt survive encrypted backup/restore`, async t => {
  const f = await bookingFixture({ patients: 2, history: 2, notificationSchema }); t.after(f.close); f.setMode('classic');
  const values = f.input(), receipt = publicSubmit(f.context, f.org, values, f.now);
  const before = f.storage.read();
  // Source is a disposable fixture; backup directories cannot be inside it.
  const root = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'cartoteca-classic-backup-'));
  const keyFile = path.join(root, 'keys', 'backup.key'); createBackupKey(keyFile);
  try {
    const backup = await createV2Backup({ source: f.dir, directory: path.join(root, 'archives'), keyFile });
    assert.equal(backup.verified, true);
    const destination = path.join(root, 'restored');
    await restoreV2Backup(backup.file, keyFile, destination);
    const platform = createPlatformStore(path.join(destination, 'platform'), { notificationSchema });
    const storage = createStorage(path.join(destination, 'tenants', f.org));
    try {
      assert.equal(platform.session(f.token), null);
      assert.equal(platform.onlineBooking.settings(f.org).bookingMode, 'classic');
      assert.deepEqual(storage.read(), before);
      const context = { ...f.context, platform, tenantStore: () => storage };
      assert.deepEqual(publicSubmit(context, f.org, values, f.now + 1000), receipt);
      assert.deepEqual(storage.read(), before);
      assert.equal(storage.read().patients.at(-1).visits.length, 0);
    } finally { storage.close(); platform.close(); }
  } finally {
    if (path.dirname(root) !== path.resolve(require('node:os').tmpdir()) || !path.basename(root).startsWith('cartoteca-classic-backup-')) throw Error('Unsafe fixture cleanup');
    require('node:fs').rmSync(root, { recursive: true, force: true });
  }
});

test('two real server processes serialize same-slot races and recover same-key submissions without duplicates', { timeout: 60000 }, async t => {
  const f = await bookingFixture(); t.after(f.close); f.setMode('classic');
  const children = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'pathext'].includes(key.toLowerCase())));
  try {
    const bases = [];
    for (let n = 0; n < 2; n++) {
      const child = fork(path.join(__dirname, 'fixtures/booking-load-server.cjs'), [f.dir], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('Fixture server failed'); })]);
      bases.push('http://127.0.0.1:' + ready.port);
    }
    const form = async (base, extra) => {
      const info = await (await fetch(base + '/api/public-booking/info?organization=' + f.org)).json();
      return f.input({ key: info.challenge, ...extra });
    };
    const submit = async (base, value) => {
      const response = await fetch(base + '/api/public-booking/requests?organization=' + f.org,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1', Origin: base },
          body: JSON.stringify(value), signal: AbortSignal.timeout(15000) });
      return { http: response.status, body: await response.json() };
    };
    const forms = await Promise.all(Array.from({ length: 12 }, (_, i) => form(bases[i % 2], { phone: '+7' + String(9999900000 + i) })));
    const outcomes = await Promise.all(forms.map((value, i) => submit(bases[i % 2], value)));
    assert.equal(outcomes.filter(o => o.http === 200 && o.body.status === 'booked').length, 1);
    assert.equal(outcomes.filter(o => o.http === 409).length, 11);
    // The preceding 12 distinct forms intentionally exhaust the address submit
    // budget. Start the independent retry profile at an empty synthetic baseline.
    const database = require('../src/server/infrastructure/platform-database.cjs').createPlatformDatabase(path.join(f.dir, 'platform'));
    try { database.db.prepare("DELETE FROM login_limits WHERE key LIKE 'booking-budget:%'").run(); }
    finally { database.db.close(); }
    const repeated = await form(bases[0], { time: '10:00', phone: '+79999999998' });
    const retries = await Promise.all(Array.from({ length: 12 }, (_, i) => submit(bases[i % 2], repeated)));
    assert.ok(retries.every(o => o.http === 200 && o.body.status === 'booked'), JSON.stringify(retries));
    assert.equal(f.storage.read().patients.flatMap(p => p.appointments).length, 2);
    assert.ok(f.storage.read().patients.every(p => !p.visits.length));
  } finally {
    for (const child of children) if (child.connected) { const ended = once(child, 'exit'); child.send({ type: 'stop' }); await ended; }
  }
});
