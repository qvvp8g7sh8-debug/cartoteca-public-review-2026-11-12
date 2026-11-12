// Explicit offline opt-in for the marked, disposable multi-organization stand.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { safe, DATA } = require('./benchmark-organizations-fixture.cjs');
const { validateFixture } = require('./benchmark-organizations-profile.cjs');
const PROFILE = 'notifications-v1';
const MAX_BOT = '930000001';
const MANIFEST = 'notifications-profile.json';

function validateManifest(value) {
  assert.equal(value.profile, PROFILE);
  assert.equal(value.schema, 17);
  assert.ok(Array.isArray(value.clients) && value.clients.length > 0);
  assert.ok(Array.isArray(value.devices) && value.devices.length >= value.clients.length);
  assert.equal(value.expected.clientTelegram, value.clients.length);
  assert.equal(value.expected.clientMax, value.clients.length);
  assert.equal(value.expected.pushChange, value.devices.length);
  assert.equal(new Set(value.clients.map((row) => row.organization)).size, value.clients.length);
  for (const [index, row] of value.clients.entries()) {
    assert.equal(row.telegram, String(940000000 + index));
    assert.equal(row.max, String(950000000 + index));
    assert.equal(row.bot, MAX_BOT);
  }
  for (const [index, row] of value.devices.entries())
    assert.equal(row.endpoint, 'https://fcm.googleapis.com/fcm/send/cartoteca-synthetic-' + index);
  return value;
}

// Connections are supplied explicitly for small synthetic integration tests;
// the CLI-facing seed below first enforces the exact marked stand directory.
function populateProfile({ root, platform, database, fixture, tenantStore, now = Date.now() }) {
  validateFixture(fixture);
  const { db } = database;
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 17);
  for (const table of [
    'telegram_links',
    'max_client_links',
    'staff_push_devices',
    'notification_channel_jobs',
    'staff_push_jobs',
  ])
    assert.equal(db.prepare('SELECT count(*) n FROM ' + table).get().n, 0, 'Fresh profile only');
  const { startsAt, fingerprint } = require(
    path.join(root, 'src/server/modules/notifications/appointments.cjs'),
  );
  const manifest = {
    profile: PROFILE,
    schema: 17,
    first: fixture.first,
    seededAt: now,
    clients: [],
    devices: [],
    expected: {
      clientTelegram: fixture.organizations.length,
      clientMax: fixture.organizations.length,
      pushChange: fixture.actors.length,
    },
    excluded: [
      'real-provider-network',
      'client-confirmation-callbacks',
      'staff-messenger-jobs',
      'email',
      'support',
    ],
  };
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
  for (const [index, org] of fixture.organizations.entries()) {
    const users = fixture.actors.filter((actor) => actor.org === org),
      owner = users.find((actor) => actor.role === 'owner');
    assert.ok(owner);
    assert.match(platform.organization(org).name, /^Synthetic /);
    const row = db.prepare('SELECT limits FROM subscriptions WHERE organization_id=?').get(org);
    db.prepare('UPDATE subscriptions SET limits=? WHERE organization_id=?').run(
      database.seal({ ...database.open(row.limits), automaticNotifications: true }),
      org,
    );
    const zone = platform.organizationTimeZone(org);
    platform.telegram.saveSettings(org, owner.id, {
      enabled: true,
      leadMinutes: 20160,
      timeZone: zone,
      showServices: true,
    });
    const store = tenantStore(org);
    try {
      const selected = (actor) => {
        const patient = store.readSelected([actor.patient]).patients[0];
        assert.ok(patient && patient.id.startsWith('p-' + actor.index + '-'));
        const appointment = patient.appointments.find(
          (a) => a.status === 'scheduled' && startsAt(a, zone) > now,
        );
        assert.ok(
          appointment && startsAt(appointment, zone) - now <= 20160 * 60000,
          'Future due appointment required',
        );
        return { patient, appointment };
      };
      const { patient } = selected(owner),
        telegram = String(940000000 + index),
        max = String(950000000 + index);
      const exists = (organization, id, actor) =>
        organization === org && id === patient.id && actor === owner.id;
      const token = platform.telegram.issueLink(org, patient.id, owner.id, now);
      platform.telegram.consumeLink(token, telegram, exists, now);
      const invitation = platform.maxLinks.issue(org, patient.id, owner.id, MAX_BOT, () => {}, now);
      platform.maxLinks.consume(
        invitation.token,
        MAX_BOT,
        max,
        (organization, id, actor) => assert.ok(exists(organization, id, actor)),
        now,
      );
      manifest.clients.push({
        organization: org,
        patient: patient.id,
        telegram,
        max,
        bot: MAX_BOT,
      });
      for (const actor of users) {
        const endpoint =
          'https://fcm.googleapis.com/fcm/send/cartoteca-synthetic-' + manifest.devices.length;
        const token = actor.cookie.split('=')[1];
        const bindingExpectation = platform.staffPush.status(token, endpoint).bindingExpectation;
        const connected = platform.staffPush.connect(token, { endpoint, keys }, bindingExpectation);
        const { patient, appointment } = selected(actor);
        platform.withWriteLock(() =>
          platform.staffPush.enqueue(
            org,
            appointment.staffId,
            'change',
            {
              kind: 'appointment',
              patientId: patient.id,
              id: appointment.id,
              stamp: fingerprint(appointment, zone),
              notice: 'created',
            },
            JSON.stringify(['synthetic-load-change', actor.id]),
            now + 86400000,
            connected.device.id,
          ),
        );
        manifest.devices.push({ organization: org, account: actor.id, endpoint });
      }
    } finally {
      store.close();
    }
  }
  assert.equal(db.prepare('SELECT count(*) n FROM staff_push_jobs').get().n, fixture.actors.length);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  return validateManifest(manifest);
}

function seed(root, directory = DATA) {
  safe(directory);
  const file = path.join(directory, MANIFEST);
  assert.ok(!fs.existsSync(file), 'Never reseed an existing notification profile');
  const fixture = JSON.parse(fs.readFileSync(path.join(directory, 'actors.json'), 'utf8'));
  validateFixture(fixture);
  const { createPlatformStore } = require(path.join(root, 'platform-store.cjs'));
  const { createPlatformDatabase } = require(
    path.join(root, 'src/server/infrastructure/platform-database.cjs'),
  );
  const { createStorage } = require(path.join(root, 'storage.cjs'));
  const platform = createPlatformStore(path.join(directory, 'platform'), {
    notificationSchema: 17,
  });
  let database;
  try {
    database = createPlatformDatabase(path.join(directory, 'platform'), { notificationSchema: 17 });
    const value = populateProfile({
      root,
      platform,
      database,
      fixture,
      tenantStore: (org) => createStorage(path.join(directory, 'tenants', org)),
    });
    fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return { profile: PROFILE, expected: value.expected, organizations: value.clients.length };
  } finally {
    database?.db.close();
    platform.close();
  }
}

function readManifest(directory = DATA) {
  safe(directory);
  return validateManifest(JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), 'utf8')));
}
function queueSnapshot(directory = DATA) {
  safe(directory);
  const db = new DatabaseSync(path.join(directory, 'platform', 'platform.sqlite'), {
    readOnly: true,
  });
  try {
    const queues = {};
    for (const table of ['notification_channel_jobs', 'staff_push_jobs']) {
      const channel = table === 'notification_channel_jobs' ? 'channel' : "'push'";
      queues[table] = db
        .prepare(
          `SELECT ${channel} channel,status,count(*) jobs,count(DISTINCT organization_id) organizations,
        min(CASE WHEN status IN ('pending','reserved','sending') THEN next_at END) oldestNextAt
        FROM ${table} GROUP BY ${channel},status`,
        )
        .all()
        .map((row) => ({
          ...row,
          oldestDueAgeMs:
            row.oldestNextAt === null ? null : Math.max(0, Date.now() - row.oldestNextAt),
        }));
    }
    return { profile: PROFILE, queues };
  } finally {
    db.close();
  }
}
module.exports = { seed, readManifest, queueSnapshot, populateProfile, validateManifest, PROFILE };
if (require.main === module) {
  try {
    console.log(JSON.stringify(seed('/app')));
  } catch {
    console.error('Synthetic notification profile preparation failed; discard this stand copy.');
    process.exitCode = 1;
  }
}
