// Offline only. Reuses the historical seed unmodified, then explicitly prepares schema19.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DATA, safe, grow } = require('./benchmark-organizations-fixture.cjs');
const { dateRange, actorOrder } = require('./benchmark-organizations-profile.cjs');
const { PROFILE, validate } = require('./benchmark-mixed92-profile.cjs');
const NAME = 'mixed92-private-fixture.json',
  MARKER = 'mixed92-v1-offline-synthetic-only';
async function createPhoto(sharp) {
  let random = 20261021;
  const pixels = Buffer.alloc(768 * 768 * 3);
  for (let n = 0; n < pixels.length; n++) {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    pixels[n] = random & 255;
  }
  const jpeg = await sharp(pixels, { raw: { width: 768, height: 768, channels: 3 } })
    .jpeg({ quality: 78 })
    .toBuffer();
  assert.ok(
    jpeg.length >= PROFILE.photoBytesMin && jpeg.length <= PROFILE.photoBytesMax,
    'JPEG outside frozen payload range',
  );
  return jpeg;
}
function readFixture(directory = DATA) {
  safe(directory);
  assert.equal(fs.readFileSync(path.join(directory, 'MIXED92-ONLY'), 'utf8'), MARKER);
  assert.ok(
    !fs.existsSync(path.join(directory, 'MIXED92-PREPARING')),
    'Incomplete synthetic fixture',
  );
  return validate(JSON.parse(fs.readFileSync(path.join(directory, NAME), 'utf8')));
}
async function prepare({
  root = '/app',
  directory = DATA,
  organizations = 10000,
  cards = 10,
  first,
} = {}) {
  assert.equal(root, '/app');
  assert.equal(path.resolve(directory), DATA);
  assert.ok(Number.isInteger(organizations) && organizations >= 5 && organizations <= 10000);
  assert.ok(Number.isInteger(cards) && cards >= 10 && cards <= 200);
  dateRange(first);
  assert.ok(!fs.existsSync(path.join(directory, NAME)), 'Fresh synthetic fixture only');
  const jpeg = await createPhoto(require(path.join(root, 'node_modules/sharp')));
  await grow(root, directory, organizations, cards, first);
  safe(directory);
  fs.writeFileSync(path.join(directory, 'MIXED92-PREPARING'), MARKER, { flag: 'wx', mode: 0o600 });
  // Must be seeded before the schema change; the old profile contract remains schema17.
  require('./benchmark-notifications-fixture.cjs').seed(root, directory);
  const legacy = JSON.parse(fs.readFileSync(path.join(directory, 'actors.json'), 'utf8'));
  const platformDir = path.join(directory, 'platform');
  const { createPlatformDatabase } = require(
    path.join(root, 'src/server/infrastructure/platform-database.cjs'),
  );
  const database = createPlatformDatabase(platformDir, { notificationSchema: 17 });
  try {
    require(
      path.join(root, 'src/server/migrations/018-notification-schedule.cjs'),
    ).migrateNotificationSchedule(database, platformDir);
    require(path.join(root, 'src/server/migrations/019-paid-services.cjs')).migratePaidServices(
      database,
      platformDir,
    );
  } finally {
    database.db.close();
  }
  const fixture = {
    ...legacy,
    profile: PROFILE.name,
    schema: 19,
    monthEnd: dateRange(first).monthEnd,
    password: 'Synthetic-organizations-password-2026',
    actors: legacy.actors.map((actor, ordinal) => ({
      ...actor,
      ordinal,
      email:
        actor.id === legacy.owner.accountId
          ? 'synthetic-owner@example.test'
          : actor.id + '@example.test',
    })),
  };
  // A fixed <=300-user voice pilot reflects the product cap, rather than bypassing it.
  const eligible = actorOrder(fixture.actors.length)
    .slice(0, Math.min(300, fixture.actors.length))
    .map((n) => fixture.actors[n]);
  eligible.forEach((actor) => {
    actor.assistant = true;
  });
  const grantsDb = createPlatformDatabase(platformDir, { notificationSchema: 19 });
  try {
    require(path.join(root, 'src/server/modules/assistant/access/store.cjs'))
      .createAssistantStore({ ...grantsDb, directory: platformDir })
      .update((state) => {
        state.policy.mode = 'selected';
        state.policy.limits.monthlyBudgetRub = 100000;
        state.policy.limits.dailyRequests = 1000;
        state.providers.llm.provider = 'timeweb';
        state.providers.tts.provider = 'timeweb';
        state.credentials.timeweb = 'synthetic-mixed92-never-network';
        state.revision++;
        state.grants = eligible.map((actor) => {
          const row = grantsDb.db
            .prepare('SELECT created_at FROM memberships WHERE organization_id=? AND account_id=?')
            .get(actor.org, actor.id);
          return {
            accountId: actor.id,
            organizationId: actor.org,
            membershipId: crypto
              .createHash('sha256')
              .update(JSON.stringify([actor.org, actor.id, row.created_at]))
              .digest('base64url'),
          };
        });
      });
  } finally {
    grantsDb.db.close();
  }
  const { createPlatformStore } = require(path.join(root, 'platform-store.cjs'));
  const platform = createPlatformStore(platformDir, { notificationSchema: 19 });
  try {
    for (const actor of fixture.actors)
      actor.ics = platform.calendarSubscription.connect(
        actor.cookie.split('=')[1],
        () => {},
        actor.ordinal % 2 ? 'google' : 'apple',
      ).credential;
  } finally {
    platform.close();
  }
  // Same immutable JPEG for all compared versions. This is synthetic noise, never a client photograph.
  fixture.jpegSha256 = crypto.createHash('sha256').update(jpeg).digest('hex');
  fixture.jpegBytes = jpeg.length;
  fs.writeFileSync(path.join(directory, 'mixed92-photo.jpg'), jpeg, { flag: 'wx', mode: 0o600 });
  const { createStorage } = require(path.join(root, 'storage.cjs'));
  const photoActors = eligible.filter((actor) => actor.role === 'owner').slice(0, 100);
  assert.ok(photoActors.length);
  for (const actor of photoActors) {
    const store = createStorage(path.join(directory, 'tenants', actor.org));
    try {
      const state = store.readSelected([actor.patient]),
        patient = state.patients[0];
      patient.visits[0].photos = [
        {
          data: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
          caption: 'Synthetic mixed92 fixture',
        },
      ];
      store.write(state, { changedIds: { patients: [actor.patient], services: [] } });
      actor.photo = store.readSelected([actor.patient]).patients[0].visits[0].photos[0].data;
    } finally {
      store.close();
    }
  }
  fixture.voicePilotAccounts = eligible.length;
  fixture.photoCohortAccounts = photoActors.length;
  validate(fixture);
  fs.writeFileSync(path.join(directory, NAME), JSON.stringify(fixture), {
    flag: 'wx',
    mode: 0o600,
  });
  fs.writeFileSync(path.join(directory, 'MIXED92-ONLY'), MARKER, { flag: 'wx', mode: 0o600 });
  fs.unlinkSync(path.join(directory, 'MIXED92-PREPARING'));
  return {
    profile: fixture.profile,
    schema: 19,
    organizations,
    accounts: fixture.actors.length,
    cards,
    voicePilotAccounts: eligible.length,
    photoCohortAccounts: photoActors.length,
    jpegBytes: jpeg.length,
    jpegSha256: fixture.jpegSha256,
  };
}
module.exports = { prepare, readFixture, createPhoto, NAME, MARKER };
if (require.main === module)
  prepare({
    organizations: Number(process.argv[2] || 10000),
    cards: Number(process.argv[3] || 10),
    first: process.argv[4],
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
