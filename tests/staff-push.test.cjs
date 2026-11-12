const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { connectFresh } = require('./helpers/staff-push-connect.cjs');
const { subscription } = require('../src/server/modules/notifications/push-validation.cjs');
const { createPushRuntime } = require('../src/server/modules/notifications/push-runtime.cjs');
const { prepareStaffPushUpgrade } = require('../src/server/migrations/prepare-staff-push.cjs');
const { createV2Backup, restoreV2Backup } = require('../src/server/infrastructure/backup/service.cjs');
function sub(index = 1) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-' + index, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}
test('push subscription rejects SSRF, credentials, port, malformed encryption keys', () => {
  const valid = sub(); assert.deepEqual(subscription(valid), valid);
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.attacker.test/a', 'https://user@fcm.googleapis.com/a', 'https://fcm.googleapis.com:444/a', 'https://evil.push.apple.com.attacker.test/a', 'https://fcm.googleapis.com/a#fragment'])
    assert.throws(() => subscription({ ...valid, endpoint }), { status: 400 });
  assert.throws(() => subscription({ ...valid, keys: { auth: valid.keys.auth, p256dh: Buffer.alloc(65).toString('base64url') } }), { status: 400 });
});
test('staff push: encrypted devices, own scope, dedup, ACL, cancellation and preferences', async t => {
  const f = await staffMaxFixture(t, { schema: 17 }), store = f.platform.staffPush;
  const subs = f.users.map((_, i) => sub(i));
  const devices = f.users.map((u, i) => connectFresh(store, u.token, subs[i]).device);
  const row = f.database.db.prepare('SELECT value FROM staff_push_devices LIMIT 1').get();
  assert.ok(!Buffer.from(row.value).toString().includes('fcm.googleapis.com'));
  const foreignEndpoint = store.status(f.users[1].token, subs[0].endpoint);
  assert.equal(foreignEndpoint.device, null);
  assert.throws(() => store.connect(f.users[1].token, { ...subs[0], keys: { ...subs[0].keys, auth: subs[1].keys.auth } }, foreignEndpoint.bindingExpectation), { status: 409 });
  assert.throws(() => store.update(f.users[1].token, { deviceId: devices[0].id }, true), { status: 404 });
  const r = f.create(); f.create();
  let jobs = f.database.db.prepare('SELECT * FROM staff_push_jobs').all();
  assert.equal(jobs.length, 3); // owner/admin/assigned staff, never another employee
  assert.ok(!jobs.some(j => j.account_id === f.users[3].accountId));
  const job = store.claim(); assert.ok(store.valid(job));
  store.update(f.users.find(u => u.accountId === job.account_id).token, { deviceId: job.device_id }, true);
  assert.equal(store.valid(job), null); assert.equal(store.finish(job, 'sent'), 0);
  const employee = store.device(devices[2].id) ? devices[2] : connectFresh(store, f.users[2].token, subs[2]).device;
  store.update(f.users[2].token, { deviceId: employee.id, preferences: { events: ['reminder'], leadMinutes: 45 } });
  assert.throws(() => store.update(f.users[2].token, { deviceId: employee.id, preferences: { events: ['private'], leadMinutes: 45 } }), { status: 400 });
  const claimed = store.claim();
  const binding = store.device(claimed.device_id);
  f.database.db.prepare("UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?").run(f.owner.organizationId, claimed.account_id);
  assert.equal(store.valid(claimed), null);
  assert.equal(binding.organization_id, f.owner.organizationId);
  assert.equal(r.firstName, 'PRIVATE CLIENT');
});
test('push provider delivery uses neutral payload, test throttling, retry and expiry', async t => {
  const f = await staffMaxFixture(t, { schema: 17 }), store = f.platform.staffPush;
  const device = connectFresh(store, f.users[0].token, sub()).device;
  store.test(f.users[0].token, device.id, f.clock());
  assert.throws(() => store.test(f.users[0].token, device.id, f.clock()), { status: 429 });
  let attempt = 0, now = f.clock();
  const runtime = createPushRuntime({ platform: f.platform, tenantStore: () => ({ indexes: { appointments: () => [] }, transaction: fn => fn() }), origin: 'https://synthetic.test', enabled: true, clock: () => now,
    send: async (subscription, payload, options) => {
      assert.equal(options.timeout, 10000); assert.ok(options.vapidDetails.privateKey);
      assert.ok(!/PRIVATE|phone|patientName|firstName/.test(payload));
      assert.equal(JSON.parse(payload).data.event, 'test');
      if (++attempt === 1) throw { statusCode: 429, headers: { 'retry-after': '1' } };
    } });
  t.after(() => runtime.stop()); runtime.start(); await runtime.tick();
  assert.equal(f.database.db.prepare('SELECT status FROM staff_push_jobs').get().status, 'pending');
  now += 60001; await runtime.tick(); // test TTL expired, never send stale checks
  assert.equal(attempt, 1);
  assert.equal(f.database.db.prepare('SELECT status FROM staff_push_jobs').get().status, 'cancelled');
  store.test(f.users[0].token, device.id, now); await runtime.tick(); assert.equal(attempt, 2);
  const status = f.database.db.prepare("SELECT count(*) n FROM staff_push_jobs WHERE status='sent'").get(); assert.equal(status.n, 1);
  const disabled = createPushRuntime({ platform: f.platform, tenantStore: () => { throw Error(); }, origin: 'https://synthetic.test', enabled: false });
  assert.equal(disabled.available, false); await disabled.tick();
});
test('new push migration prepares separate copy, rollback empty and disaster restore revoke devices', async t => {
  const f = await staffMaxFixture(t);
  const keyFile = path.join(f.directory, 'synthetic-backup.key'); fs.writeFileSync(keyFile, crypto.randomBytes(32));
  const directory = path.join(f.directory, 'archives'), destination = path.join(f.directory, 'prepared');
  const result = await prepareStaffPushUpgrade({ source: f.source, destination, directory, keyFile });
  assert.equal(result.schema, 17); assert.equal(result.sourceUnchanged, true);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 16);
  const { createPlatformStore } = require('../src/server/application/platform.cjs');
  const p = createPlatformStore(path.join(destination, 'platform'), { notificationSchema: 17 });
  try { connectFresh(p.staffPush, f.users[0].token, sub()); } finally { p.close(); }
  const archive = await createV2Backup({ source: destination, directory, keyFile });
  const recovered = path.join(f.directory, 'recovered');
  await restoreV2Backup(archive.file, keyFile, recovered);
  const restored = createPlatformStore(path.join(recovered, 'platform'), { notificationSchema: 17 });
  restored.close();
  const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
  const db = createPlatformDatabase(path.join(recovered, 'platform'), { notificationSchema: 17 });
  try {
    assert.equal(db.db.prepare('SELECT count(*) n FROM staff_push_devices').get().n, 0);
    require('../src/server/migrations/017-staff-push.cjs').rollbackEmptyStaffPush(db);
    assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, 16);
  } finally { db.db.close(); }
  await assert.rejects(() => prepareStaffPushUpgrade({ source: f.source, destination: f.source, directory, keyFile }));
});
module.exports = { sub };
