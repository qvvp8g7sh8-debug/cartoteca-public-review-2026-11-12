const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { safeTree } = require('../src/server/infrastructure/backup/snapshot.cjs');
const { atomicJson } = require('../src/server/infrastructure/backup/durable.cjs');
function location(environment = process.env) {
  if (environment.CARTOTECA_POSTGRES_REHEARSAL !== 'synthetic-v1')
    throw Error('Explicit synthetic rehearsal mode required.');
  const directory = environment.CARTOTECA_REHEARSAL_DIR || '/rehearsal';
  if (!path.isAbsolute(directory)) throw Error('Absolute owned rehearsal directory required.');
  safeTree(directory);
  return path.resolve(directory);
}
function fingerprint(directory) {
  const hash = crypto.createHash('sha256');
  function walk(current, relative = '') {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative + entry.name,
        file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw Error('Synthetic source cannot contain links.');
      if (entry.isDirectory()) walk(file, name + '/');
      else if (entry.isFile()) {
        if (
          name.endsWith('.sqlite-shm') ||
          (name.endsWith('.sqlite-wal') && fs.statSync(file).size === 0)
        )
          continue;
        hash.update(name);
        hash.update(fs.readFileSync(file));
      } else throw Error('Unsupported synthetic source entry.');
    }
  }
  walk(directory);
  return hash.digest('hex');
}
function readFixture(environment = process.env) {
  const directory = location(environment),
    file = path.join(directory, 'fixture.json'),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw Error('Invalid synthetic fixture.');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    fixture.version !== 1 ||
    fixture.scope !== 'scale123-synthetic' ||
    !Array.isArray(fixture.actors) ||
    fixture.actors.length !== 2 ||
    !fixture.sourceFingerprint
  )
    throw Error('Invalid synthetic fixture identity.');
  return { directory, fixture, source: path.join(directory, 'source') };
}
async function seed(environment = process.env) {
  const directory = location(environment);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (
    fs.existsSync(path.join(directory, 'fixture.json')) ||
    fs.existsSync(path.join(directory, 'source'))
  )
    throw Error('Synthetic rehearsal source already exists.');
  fs.writeFileSync(
    path.join(directory, '.synthetic-owner.json'),
    JSON.stringify({ version: 1, scope: 'scale123-synthetic', id: crypto.randomUUID() }),
    { flag: 'wx', mode: 0o600 },
  );
  const source = path.join(directory, 'source'),
    platform = createPlatformStore(path.join(source, 'platform')),
    actors = [];
  try {
    for (let n = 0; n < 2; n++) {
      const email = 'owner-' + n + '@synthetic.invalid',
        password = crypto.randomBytes(32).toString('hex');
      const registered = await platform.registerOwner({
        email,
        password,
        displayName: 'Synthetic owner',
        organizationName: 'Synthetic organization',
      });
      platform.verifyEmail(registered.verificationToken);
      const login = await platform.login(email, password),
        patientId = crypto.randomUUID(),
        cabinet = createStorage(path.join(source, 'tenants', registered.organizationId));
      try {
        cabinet.write({
          revision: 0,
          services: [],
          patients: [
            {
              id: patientId,
              firstName: 'Synthetic',
              lastName: 'Client',
              name: 'Synthetic Client',
              createdBy: registered.accountId,
              appointments: [
                {
                  id: 'synthetic-appointment-' + n,
                  staffId: registered.accountId,
                  roomId: 'main',
                  date: '2035-01-02',
                  time: '10:00',
                  duration: 30,
                  service: 'Synthetic service',
                },
              ],
              visits: [],
            },
          ],
        });
      } finally {
        cabinet.close();
      }
      actors.push({
        accountId: registered.accountId,
        organizationId: registered.organizationId,
        token: login.token,
        patientId,
        email,
        password,
      });
    }
  } finally {
    platform.close();
  }
  const platformDirectory = path.join(source, 'platform'),
    database = require('../src/server/infrastructure/platform-database.cjs').createPlatformDatabase(
      platformDirectory,
    );
  try {
    for (const [file, name] of [
      ['012-max-connections', 'migrateMaxConnections'],
      ['013-notification-queue', 'migrateNotificationQueue'],
      ['014-notification-channels', 'migrateNotificationChannels'],
      ['015-max-inbox', 'migrateMaxInbox'],
      ['016-staff-max', 'migrateStaffMax'],
      ['017-staff-push', 'migrateStaffPush'],
      ['018-notification-schedule', 'migrateNotificationSchedule'],
      ['019-paid-services', 'migratePaidServices'],
    ]) {
      if (file === '019-paid-services') {
        const marker = path.join(source, '.restore-in-progress');
        fs.writeFileSync(marker, 'booking-public-links-preparation-v1', {
          flag: 'wx',
          mode: 0o600,
        });
        try {
          require('../src/server/migrations/001-booking-public-links.cjs').migrateBookingPublicLinks(
            platformDirectory,
          );
        } finally {
          fs.unlinkSync(marker);
        }
      }
      require('../src/server/migrations/' + file + '.cjs')[name](database, platformDirectory, {
        offline: true,
      });
    }
    require('../src/server/modules/assistant/access/store.cjs')
      .createAssistantFileStore({
        directory: platformDirectory,
        seal: database.seal,
        open: database.open,
      })
      .update((state) => {
        state.policy.instructions = 'Synthetic rehearsal only';
        state.revision++;
      });
    database.db
      .prepare('INSERT INTO login_limits VALUES(?,?,?,?)')
      .run('booking-budget:site-read:synthetic', 2, 0, 3000);
  } finally {
    database.closeWriter();
    database.db.close();
  }
  const marker = path.join(source, '.restore-in-progress');
  for (const [preparation, file, method] of [
    [
      'assistant-state-rows-preparation-v1',
      '001-assistant-state-rows',
      'migrateAssistantStateRows',
    ],
    ['booking-read-budget-preparation-v1', '001-booking-read-budget', 'migrateBookingReadBudget'],
  ]) {
    fs.writeFileSync(marker, preparation, { flag: 'wx', mode: 0o600 });
    try {
      require('../src/server/migrations/' + file + '.cjs')[method](platformDirectory);
    } finally {
      fs.unlinkSync(marker);
    }
  }
  const cabinetPath = path.join(source, 'tenants', actors[0].organizationId),
    cabinet = createStorage(cabinetPath),
    photoId = 'a'.repeat(32);
  try {
    cabinet.db
      .prepare('INSERT INTO photos(id,mime,active) VALUES(?,?,1)')
      .run(photoId, 'image/jpeg');
    fs.writeFileSync(
      path.join(cabinet.photoDir, photoId + '.enc'),
      cabinet.seal(Buffer.from('Synthetic immutable photo payload')),
      { flag: 'wx', mode: 0o600 },
    );
    require('../src/server/migrations/002-cabinet-records.cjs').migrateCabinetRecords(cabinet);
  } finally {
    cabinet.close();
  }
  const prepared = createStorage(cabinetPath, { cabinetSchema: 2 });
  let original;
  try {
    original = prepared.read();
  } finally {
    prepared.close();
  }
  // Historical offline migrators create rollback snapshots; retain only this
  // synthetic final source, not eight superseded SQLite datasets.
  const snapshots = path.join(platformDirectory, 'migration-backups');
  if (fs.existsSync(snapshots)) {
    safeTree(snapshots);
    fs.rmSync(snapshots, { recursive: true, force: false });
  }
  const fixture = {
    version: 1,
    scope: 'scale123-synthetic',
    actors,
    operationId: crypto.randomUUID(),
    revision: original.revision,
    before: original.patients[0],
    sourceFingerprint: fingerprint(source),
    sourceRetired: false,
    notificationSchema: 19,
    bookingLinksVersion: 1,
    photoCount: 1,
  };
  atomicJson(path.join(directory, 'fixture.json'), fixture);
  return {
    seeded: true,
    organizations: 2,
    patients: 2,
    photos: 1,
    schema: 19,
    syntheticOnly: true,
  };
}
module.exports = { location, fingerprint, readFixture, seed };
