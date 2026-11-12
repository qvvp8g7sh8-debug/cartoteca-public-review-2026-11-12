const test = require('node:test');
const assert = require('node:assert/strict');
const { createMultiServer } = require('../multi-server.cjs');
const { organizationRestoreFixture } = require('./helpers/organization-restore-fixture.cjs');
const {
  prepareOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-restore.cjs');
const {
  applyOrganizationRestore,
  rollbackOrganizationRestore,
} = require('../src/server/infrastructure/backup/organization-switch.cjs');
const {
  dataInventory,
  inventoryFingerprint,
} = require('../src/server/infrastructure/backup/organization-inventory.cjs');

const fingerprint = (directory) => inventoryFingerprint(dataInventory(directory));
async function coldStartup(f) {
  const before = fingerprint(f.source);
  const server = createMultiServer({
    processRole: 'preflight',
    dataDir: f.source,
    notificationSchema: f.version,
    production: false,
    origin: '',
    backupStatusFile: '',
    sendMail: null,
    telegramBot: null,
    supportDelivery: {},
    telegramAutostart: false,
    supportAutostart: false,
    maxAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
    maxConnectionsEnabled: false,
    commonNotificationsEnabled: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await fetch(base + '/login.html')).status, 200);
    assert.equal((await fetch(base + '/app.js')).status, 401);
    assert.equal((await fetch(base + '/api/cabinet')).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(fingerprint(f.source), before);
}

for (const version of [11, 15, 16, 17, 18, 19, 20])
  test(`cold HTTP startup after selective restore and rollback preserves schema ${version} without outbound workers`, async (t) => {
    const f = await organizationRestoreFixture(t, version),
      before = fingerprint(f.source);
    const plan = await prepareOrganizationRestore(f.options);
    const options = {
      source: f.source,
      jobDirectory: f.jobDirectory,
      keyFile: f.keyFile,
      confirmation: plan.id,
      stopped: true,
    };
    await applyOrganizationRestore(options);
    await coldStartup(f);
    assert.equal(rollbackOrganizationRestore(options).state, 'rolled-back');
    assert.equal(fingerprint(f.source), before);
    await coldStartup(f);
  });
