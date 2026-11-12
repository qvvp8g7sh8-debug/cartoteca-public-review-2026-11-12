const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createPlatformStore } = require('../src/server/application/platform.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { crypto } = require('../src/server/infrastructure/platform-constants.cjs');
const { migrateMaxConnections } = require('../src/server/migrations/012-max-connections.cjs');
const { createMaxLinks } = require('../src/server/modules/notifications/max-links.cjs');
const {
  createDeliveryPreferences,
} = require('../src/server/modules/notifications/delivery-preferences.cjs');
const {
  createMaxConnections,
  MAX_USERNAME,
} = require('../src/server/modules/notifications/max-connections.cjs');

function maxFixture(t, { serverData = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-max-synthetic-'));
  const directory = serverData ? path.join(dataDir, 'platform') : dataDir;
  const platform = createPlatformStore(directory),
    database = createPlatformDatabase(directory);
  t.after(() => {
    database.db.close();
    platform.close();
    if (
      path.dirname(dataDir) !== path.resolve(os.tmpdir()) ||
      !path.basename(dataDir).startsWith('cartoteca-max-synthetic-')
    )
      throw Error('Unexpected synthetic directory.');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  migrateMaxConnections(database, directory);
  const { db, seal } = database,
    now = Date.now();
  for (const org of ['org', 'other-org']) {
    db.prepare('INSERT INTO organizations(id,value,slug,status,created_at) VALUES(?,?,?,?,?)').run(
      org,
      seal({ name: 'Synthetic organization', businessType: 'individual' }),
      org,
      'active',
      now,
    );
    db.prepare(
      'INSERT INTO subscriptions(organization_id,plan,status,limits,changed_at) VALUES(?,?,?,?,?)',
    ).run(org, 'free', 'active', seal({ automaticNotifications: true }), now);
  }
  for (const [account, role] of [
    ['owner', 'owner'],
    ['staff', 'cosmetologist'],
    ['outsider', 'owner'],
  ]) {
    db.prepare('INSERT INTO accounts(id,email_hash,value,status,created_at) VALUES(?,?,?,?,?)').run(
      account,
      database.emailHash(account + '@synthetic.test'),
      seal({ displayName: 'Synthetic specialist' }),
      'active',
      now,
    );
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?,?)').run(
      account === 'outsider' ? 'other-org' : 'org',
      account,
      role,
      'active',
      now,
    );
  }
  const patients = [
    { id: 'p', createdBy: 'owner', appointments: [], visits: [] },
    { id: 'staff-p', createdBy: 'staff', appointments: [], visits: [] },
  ];
  const tenantStore = (org) => ({
    readSelected: (ids) => ({
      patients: org === 'org' ? patients.filter((p) => ids.includes(p.id)) : [],
      services: [],
    }),
  });
  const links = createMaxLinks({ ...database, crypto }),
    preferences = createDeliveryPreferences(database);
  const owner = { organizationId: 'org', accountId: 'owner', role: 'owner' };
  const identity = { botId: '123', username: MAX_USERNAME };
  const service = createMaxConnections({
    platform,
    tenantStore,
    links,
    preferences,
    botIdentity: identity,
    enabled: true,
    clock: () => now,
    makeQr: async () => 'data:image/png;base64,c3ludGhldGlj',
  });
  return {
    dataDir,
    directory,
    platform,
    database,
    links,
    preferences,
    owner,
    identity,
    service,
    patients,
    tenantStore,
    now,
  };
}
module.exports = { maxFixture };
