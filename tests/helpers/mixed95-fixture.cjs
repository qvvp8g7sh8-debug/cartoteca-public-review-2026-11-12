const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../../storage.cjs');
const { populateProfile } = require('../../scripts/benchmark-notifications-fixture.cjs');
const profile = require('../../scripts/benchmark-mixed95-profile.cjs');
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return [4174, 4186].includes(port) ? freePort() : port;
}
async function mixed95Fixture(t, topology = 'split', functionalScenario = 'standard') {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-mixed95-'));
  const directory = path.join(owned, 'data'),
    controlDirectory = path.join(owned, 'control');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(controlDirectory, { mode: 0o700 });
  const sourceRoot = fs.realpathSync(path.join(__dirname, '../..'));
  const platformDirectory = path.join(directory, 'platform'),
    password = 'Synthetic-topology95-password';
  let platform = createPlatformStore(platformDirectory),
    database;
  const children = [];
  let completed = false;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    platform?.close();
    database?.db.close();
    assert.equal(path.dirname(owned), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(owned).startsWith('cartoteca-mixed95-'));
    assert.equal(fs.realpathSync(owned), owned);
    assert.equal(fs.lstatSync(owned).isSymbolicLink(), false);
    if (completed) fs.rmSync(owned, { recursive: true, force: true });
    else t.diagnostic('Preserved incomplete synthetic95 fixture: ' + owned);
  });
  const first = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const fixture = {
    version: 1,
    schema: 17,
    first,
    cards: 3,
    visits: 1,
    organizations: [],
    actors: [],
  };
  for (let index = 0; index < 2; index++) {
    const owner = await platform.registerOwner({
      email: 'owner' + index + '@mixed95.test',
      password,
      displayName: 'Synthetic owner',
      organizationName: 'Synthetic topology ' + index,
    });
    platform.verifyEmail(owner.verificationToken);
    fixture.organizations.push(owner.organizationId);
    const users = [{ ...owner, role: 'owner', email: 'owner' + index + '@mixed95.test' }];
    for (const [n, role] of ['salon_admin', 'cosmetologist'].entries()) {
      const invitation = platform.createInvitation({
        organizationId: owner.organizationId,
        invitedBy: owner.accountId,
        role,
      });
      const email = 'staff-' + index + '-' + n + '@mixed95.test';
      users.push({
        ...(await platform.acceptInvitation({
          token: invitation.token,
          email,
          password,
          displayName: 'Synthetic staff',
        })),
        role,
        email,
      });
    }
    for (const [ordinal, user] of users.entries()) {
      const login = await platform.login(user.email, password);
      fixture.actors.push({
        id: user.accountId,
        org: owner.organizationId,
        role: user.role,
        ordinal: fixture.actors.length,
        index,
        patient: 'p-' + index + '-' + ordinal,
        cookie: 'cartoteca_v2_session=' + login.token,
      });
    }
    const tenant = createStorage(path.join(directory, 'tenants', owner.organizationId));
    tenant.write({
      revision: 0,
      services: [],
      patients: users.map((user, n) => ({
        id: 'p-' + index + '-' + n,
        firstName: 'Synthetic',
        lastName: 'Client' + n,
        name: 'Synthetic Client' + n,
        phone: '+79990000' + index + '0' + n,
        createdBy: user.accountId,
        visits: [
          {
            id: 'v-' + n,
            date: '2026-01-01',
            staffId: user.role === 'salon_admin' ? owner.accountId : user.accountId,
            photos: [],
          },
        ],
        appointments: [
          {
            id: 'a-' + n,
            date: first,
            time: String(10 + n).padStart(2, '0') + ':00',
            duration: 30,
            staffId: user.role === 'salon_admin' ? owner.accountId : user.accountId,
            roomId: 'main',
            service: 'Synthetic service',
            status: 'scheduled',
          },
        ],
      })),
    });
    const cabinet = tenant.read();
    platform.saveWorkspace(
      owner.organizationId,
      owner.accountId,
      {
        revision: 0,
        enabled: true,
        mode: 'shared',
        roomLayout: 'single',
        rooms: [
          {
            id: 'main',
            name: 'Synthetic room',
            active: true,
            preventOverlap: true,
            staffMode: 'multiple',
            staffIds: users
              .filter((user) => user.role !== 'salon_admin')
              .map((user) => user.accountId),
          },
        ],
      },
      () => cabinet,
    );
    tenant.close();
  }
  platform.close();
  platform = null;
  database = createPlatformDatabase(platformDirectory);
  for (const [name, method] of [
    ['012-max-connections', 'migrateMaxConnections'],
    ['013-notification-queue', 'migrateNotificationQueue'],
    ['014-notification-channels', 'migrateNotificationChannels'],
    ['015-max-inbox', 'migrateMaxInbox'],
    ['016-staff-max', 'migrateStaffMax'],
    ['017-staff-push', 'migrateStaffPush'],
  ])
    require('../../src/server/migrations/' + name + '.cjs')[method](database, platformDirectory);
  for (const org of fixture.organizations) {
    const previous = database.open(
      database.db.prepare('SELECT limits FROM subscriptions WHERE organization_id=?').get(org)
        .limits,
    );
    database.db
      .prepare('UPDATE subscriptions SET plan=?,status=?,limits=? WHERE organization_id=?')
      .run(
        'paid',
        'active',
        database.seal({
          ...previous,
          automaticNotifications: true,
          patients: 20000,
          photos: 10000,
        }),
        org,
      );
  }
  platform = createPlatformStore(platformDirectory, { notificationSchema: 17 });
  const manifest = populateProfile({
    root: sourceRoot,
    platform,
    database,
    fixture,
    tenantStore: (org) => createStorage(path.join(directory, 'tenants', org)),
  });
  manifest.staffReceivers = [];
  for (const actor of fixture.actors) {
    const client = manifest.clients.find((row) => row.organization === actor.org);
    const telegram = actor.role === 'owner' ? client.telegram : String(960000000 + actor.ordinal);
    const max = actor.role === 'owner' ? client.max : String(970000000 + actor.ordinal);
    const token = actor.cookie.split('=')[1],
      now = Date.now();
    const tg = platform.staffNotifications.issue(token, now);
    platform.staffNotifications.consume(tg.token, telegram, now);
    const mx = platform.staffMaxNotifications.issue(token, client.bot, now);
    platform.staffMaxNotifications.consume(mx.token, client.bot, max, now, now);
    manifest.staffReceivers.push(
      { channel: 'telegram', recipient: telegram, accountId: actor.id },
      { channel: 'max', recipient: max, accountId: actor.id },
    );
  }
  fs.writeFileSync(path.join(directory, 'mixed95-fixture.json'), JSON.stringify(fixture), {
    flag: 'wx',
    mode: 0o600,
  });
  fs.writeFileSync(path.join(directory, 'notifications-profile.json'), JSON.stringify(manifest), {
    flag: 'wx',
    mode: 0o600,
  });
  const sourceFiles = require('../../scripts/release/files.cjs'),
    sourceManifest = sourceFiles.manifest(sourceRoot);
  const sourceBytes = JSON.stringify(sourceManifest);
  fs.writeFileSync(path.join(controlDirectory, 'source-manifest.json'), sourceBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  const port = await freePort();
  const job = {
    format: 'mixed95-job-v1',
    jobId: randomUUID(),
    mode: 'functional',
    variant: 'current',
    topology,
    functionalScenario,
    resources: profile.budget(topology),
    sourceRoot,
    directory,
    controlDirectory,
    port,
    applicationOrigin: 'https://127.0.0.1:' + port,
    sourceSha256: sourceFiles.objectHash(sourceManifest),
    sourceManifestSha256: profile.digest(sourceBytes),
    fixtureSha256: profile.digest(fs.readFileSync(path.join(directory, 'mixed95-fixture.json'))),
    notificationManifestSha256: profile.digest(
      fs.readFileSync(path.join(directory, 'notifications-profile.json')),
    ),
    harnessSha256: profile.identity().sha256,
    schema: 17,
    assistantSaving: false,
    providerNetwork: false,
    assistantDialogueCapacity: 500,
    assistantStateBackend: 'file',
    notificationMaintenanceEnabled: false,
    sharedCabinetWrites: false,
    isolatedReadBudgets: false,
    modelDelayMs: 3000,
    notificationDelayMs: 3,
  };
  job.proofSha256 = profile.digest(JSON.stringify(job));
  const jobFile = path.join(controlDirectory, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(
    path.join(controlDirectory, 'MIXED95-OWNED.json'),
    JSON.stringify({ jobId: job.jobId, syntheticOnly: true, proofSha256: job.proofSha256 }),
    { flag: 'wx', mode: 0o600 },
  );
  profile.readJob(jobFile);
  return {
    owned,
    directory,
    controlDirectory,
    job,
    jobFile,
    fixture,
    manifest,
    children,
    platform,
    database,
    sourceRoot,
    complete() {
      completed = true;
    },
    base: 'http://127.0.0.1:' + port,
    headers(actor = fixture.actors[0]) {
      return {
        Origin: job.applicationOrigin,
        'X-Cartoteca-Request': '1',
        'Content-Type': 'application/json',
        Cookie: actor.cookie,
        'X-Cartoteca-Account-Id': actor.id,
        'X-Cartoteca-Organization-Id': actor.org,
      };
    },
    createRequest(key) {
      const actor = fixture.actors[2];
      return platform.withWriteLock(() =>
        platform.bookingRequests.create(
          actor.org,
          key,
          {
            kind: 'other-time',
            staffId: actor.id,
            date: first,
            time: '15:00',
            duration: 30,
            services: [{ id: 's', name: 'Synthetic service' }],
            firstName: 'Synthetic',
            phone: '+79990000000',
            comment: 'Synthetic request',
          },
          30,
          Date.now(),
        ),
      );
    },
  };
}
module.exports = { mixed95Fixture, freePort };
