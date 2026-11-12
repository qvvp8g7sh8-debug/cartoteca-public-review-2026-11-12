const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createPlatformStore } = require('../../src/server/application/platform.cjs');
const { createStorage } = require('../../src/server/infrastructure/cabinet-storage.cjs');

// A few native SQLite files are created directly. No source tree or DATA copy.
async function nativeIsolatedFixture(t, { organizations = 1 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-native-isolated-'));
  const platform = createPlatformStore(path.join(directory, 'platform'));
  const actors = [];
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    platform.close();
    if (
      path.dirname(directory) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('cartoteca-native-isolated-')
    )
      throw Error('Invalid synthetic cleanup target.');
    fs.rmSync(directory, { recursive: true, force: true });
  };
  t.after(cleanup);
  for (let n = 0; n < organizations; n++) {
    const email = `native-owner-${n}@synthetic.test`,
      password = 'Synthetic-native-isolation-password';
    const registered = await platform.registerOwner({
      email,
      password,
      displayName: 'Synthetic owner',
      organizationName: 'Synthetic organization',
    });
    platform.verifyEmail(registered.verificationToken);
    const login = await platform.login(email, password);
    const patientId = randomUUID();
    const storage = createStorage(path.join(directory, 'tenants', registered.organizationId));
    storage.write({
      revision: 0,
      services: [],
      patients: [
        {
          id: patientId,
          firstName: 'Synthetic',
          lastName: 'Client',
          name: 'Synthetic Client',
          createdBy: registered.accountId,
          appointments: [],
          visits: [],
        },
      ],
    });
    storage.close();
    actors.push({ ...registered, token: login.token, login, patientId });
  }
  const config = {
    dataDir: directory,
    host: '127.0.0.1',
    port: 4174,
    origin: '',
    production: false,
    notificationSchema: 11,
    maxEnabled: false,
    pushEnabled: false,
    telegramBot: null,
    sendMail: null,
    supportDelivery: {},
    telegramAutostart: false,
    telegramIdentityAutostart: false,
    maxAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
    paymentNetworkEnabled: false,
    assistantAppointmentSavingEnabled: false,
  };
  return { directory, platform, actors, config, cleanup };
}
module.exports = { nativeIsolatedFixture };
