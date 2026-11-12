const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const assert = require('node:assert/strict');
const { createPlatformStore } = require('../../src/server/application/platform.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');
const { migrateMaxConnections } = require('../../src/server/migrations/012-max-connections.cjs');
const {
  migrateNotificationQueue,
} = require('../../src/server/migrations/013-notification-queue.cjs');
const {
  migrateNotificationChannels,
} = require('../../src/server/migrations/014-notification-channels.cjs');
const { migrateMaxInbox } = require('../../src/server/migrations/015-max-inbox.cjs');
const { migrateStaffMax } = require('../../src/server/migrations/016-staff-max.cjs');
const { MAX_USERNAME } = require('../../src/server/modules/notifications/max-connections.cjs');

async function staffMaxFixture(t, { schema = 16 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-staff-max-synthetic-'));
  const source = path.join(directory, 'source'),
    platformDirectory = path.join(source, 'platform');
  const password = 'Synthetic-staff-max-password';
  let platform = createPlatformStore(platformDirectory),
    database = null,
    now = Date.now();
  t.after(() => {
    database?.db.close();
    platform?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-staff-max-synthetic-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const owner = await platform.registerOwner({
    email: 'owner@staff-max.test',
    password,
    displayName: 'Synthetic owner',
    organizationName: 'Synthetic organization',
  });
  platform.verifyEmail(owner.verificationToken);
  const ownerLogin = await platform.login('owner@staff-max.test', password);
  const users = [{ ...owner, token: ownerLogin.token, login: ownerLogin }];
  for (const [index, role] of ['salon_admin', 'cosmetologist', 'cosmetologist'].entries()) {
    const invitation = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    const user = await platform.acceptInvitation({
      token: invitation.token,
      email: `staff${index}@staff-max.test`,
      password,
      displayName: 'Synthetic employee',
    });
    const login = await platform.login(`staff${index}@staff-max.test`, password);
    users.push({
      ...user,
      token: login.token,
      login,
    });
  }
  platform.close();
  platform = null;
  database = createPlatformDatabase(platformDirectory);
  migrateMaxConnections(database, platformDirectory);
  migrateNotificationQueue(database, platformDirectory);
  migrateNotificationChannels(database, platformDirectory);
  migrateMaxInbox(database, platformDirectory);
  if (schema >= 16) migrateStaffMax(database, platformDirectory);
  if (schema === 17)
    require('../../src/server/migrations/017-staff-push.cjs').migrateStaffPush(
      database,
      platformDirectory,
    );
  platform = createPlatformStore(platformDirectory, { notificationSchema: schema });
  const cabinet = createStorage(source);
  cabinet.write({ revision: 0, services: [], patients: [] });
  cabinet.close();
  const identity = { botId: '123', username: MAX_USERNAME };
  const connect = (user, index) => {
    const issued = platform.staffMaxNotifications.issue(user.token, identity.botId, now);
    platform.staffMaxNotifications.consume(
      issued.token,
      identity.botId,
      String(1000 + index),
      now,
      now,
    );
    return issued;
  };
  const connectTelegram = (user, index) => {
    const issued = platform.staffNotifications.issue(user.token, now);
    platform.staffNotifications.consume(issued.token, String(2000 + index), now);
    return issued;
  };
  const create = (key = 'synthetic-staff-max-event') =>
    platform.withWriteLock(() =>
      platform.bookingRequests.create(
        owner.organizationId,
        key,
        {
          kind: 'other-time',
          staffId: users[2].accountId,
          date: '2035-01-01',
          time: '10:00',
          duration: 30,
          services: [{ id: 's', name: 'Synthetic service' }],
          firstName: 'PRIVATE CLIENT',
          phone: '+79990000000',
          comment: 'PRIVATE COMMENT',
        },
        30,
        now,
      ),
    );
  const jobs = (channel = 'max') =>
    database.db
      .prepare(
        `SELECT * FROM ${channel === 'max' ? 'staff_max_jobs' : 'staff_notification_jobs'} ORDER BY account_id`,
      )
      .all();
  return {
    directory,
    source,
    platformDirectory,
    database,
    platform,
    users,
    owner,
    identity,
    connect,
    connectTelegram,
    create,
    jobs,
    clock: () => now,
    advance: (ms) => (now += ms),
  };
}
module.exports = { staffMaxFixture };
