const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const { createStorage } = require('../storage.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { prepareStructuralUpgrade } = require('../src/server/migrations/prepare-structural-upgrade.cjs');

test('whole-tree17/1 to18/2 and current-data rollback preserve sessions, links and all cabinet content', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  f.connect(f.users[0], 0);
  f.connectTelegram(f.users[1], 1);
  const tenant = path.join(f.source, 'tenants', f.owner.organizationId);
  const original = createStorage(tenant);
  original.write({ revision: 0, services: [], patients: [{
    id: 'synthetic-patient', name: 'Synthetic', phone: '+79990000000', visits: [],
    appointments: [{ id: 'synthetic-appointment', date: '2035-01-01', time: '10:00', duration: 30, service: 'Synthetic' }],
  }] });
  const saved = original.read();
  original.close();
  const keyFile = path.join(f.directory, 'synthetic-backup.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32));
  const args = { source: f.source, destination: path.join(f.directory, 'prepared'), directory: path.join(f.directory, 'archives'), keyFile, offline: true };
  const result = await prepareStructuralUpgrade(args);
  assert.equal(result.schema, 18);
  assert.equal(result.cabinetSchema, 2);
  assert.equal(result.cabinets, 2);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
  const old = createStorage(tenant);
  assert.deepEqual(old.read(), saved);
  assert.equal(old.db.prepare('PRAGMA user_version').get().user_version, 1);
  old.close();
  const next = createStorage(path.join(args.destination, 'tenants', f.owner.organizationId), { cabinetSchema: 2 });
  assert.deepEqual(next.read(), saved);
  next.write({ ...saved, patients: [{ ...saved.patients[0], name: 'Changed after activation' }] });
  const current = next.read();
  next.close();
  const p = createPlatformStore(path.join(args.destination, 'platform'), { notificationSchema: 18, scheduledNotifications: true });
  assert.ok(p.session(f.users[0].token));
  assert.equal(p.notificationSchedule.enabled, true);
  p.close();
  const reversed = path.join(f.directory, 'reversed');
  const reverse = await prepareStructuralUpgrade({ ...args, source: args.destination, destination: reversed, rollback: true });
  assert.equal(reverse.schema, 17);
  assert.equal(reverse.cabinetSchema, 1);
  const restored = createStorage(path.join(reversed, 'tenants', f.owner.organizationId), { cabinetSchema: 1 });
  assert.deepEqual(restored.read(), current);
  restored.close();
  const reopened = createPlatformStore(path.join(reversed, 'platform'), { notificationSchema: 17 });
  assert.ok(reopened.session(f.users[0].token));
  reopened.close();
  for (const folder of [args.destination, reversed]) assert.equal(fs.existsSync(path.join(folder, '.restore-in-progress')), false);
  const db = new DatabaseSync(path.join(args.destination, 'platform/platform.sqlite'), { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 18);
  db.close();
});

test('new schema2 cabinets are explicit; existing schema1 is not implicitly upgraded', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  assert.throws(() => createStorage(f.source, { cabinetSchema: 2 }), /offline copy/);
  const directory = path.join(f.directory, 'brand-new');
  const store = createStorage(directory, { cabinetSchema: 2 });
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  store.close();
  const reopened = createStorage(directory, { cabinetSchema: 2 });
  assert.deepEqual(reopened.read().patients, []);
  reopened.close();
  await assert.rejects(prepareStructuralUpgrade({ source: f.source, destination: directory }), /Stop writers/);
});

test('failed combined preparation leaves marker, original17 and no silently usable partial destination', async (t) => {
  const f = await staffMaxFixture(t, { schema: 17 });
  f.database.db.exec('CREATE TABLE notification_schedule(bad TEXT)');
  const keyFile = path.join(f.directory, 'synthetic-backup.key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32));
  const destination = path.join(f.directory, 'failed');
  const args = { source: f.source, destination, directory: path.join(f.directory, 'archives'), keyFile, offline: true };
  await assert.rejects(prepareStructuralUpgrade(args));
  assert.equal(f.database.db.prepare('PRAGMA user_version').get().user_version, 17);
  assert.equal(fs.existsSync(path.join(destination, '.restore-in-progress')), true);
  await assert.rejects(prepareStructuralUpgrade(args), /must be new/);
});
