const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { operatorServerConnection } = require('./connection.cjs');
const { identifier: q } = require('./catalog-sqlite.cjs');
const { safeTree } = require('../backup/snapshot.cjs');
const { markBackupStage } = require('../backup/staging.cjs');
async function postgresRestoreDrill(file, keyFile, workDirectory, options = {}) {
  const connection = await operatorServerConnection(
    options.connection,
    process.env,
    options.connectionOptions,
  );
  // The host below is derived only from the already admitted, pinned connection.
  // Reusing it cannot widen the configured DNS/host admission boundary.
  const connectionOptions =
    (options.connectionOptions?.profile || process.env.CARTOTECA_POSTGRES_PROFILE) ===
    'production-v1'
      ? { profile: 'production-v1', allowedHosts: [connection.host] }
      : { profile: 'local' };
  safeTree(workDirectory);
  fs.mkdirSync(workDirectory, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(workDirectory, '.cartoteca-drill-'));
  const token = randomBytes(12).toString('hex'),
    database = 'cartoteca_drill_' + token,
    role = 'cartoteca_drill_app_' + token;
  const password = randomBytes(32).toString('hex');
  const admin = new Client({ ...connection, database: 'postgres' });
  let connected = false,
    createdDatabase = false,
    createdRole = false,
    server,
    shutdownConfirmed = true;
  try {
    markBackupStage(stage, 'backup-drill', options);
    await admin.connect();
    connected = true;
    await admin.query(
      'CREATE ROLE ' +
        q(role) +
        " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '" +
        password +
        "'",
    );
    createdRole = true;
    await admin.query('CREATE DATABASE ' + q(database) + ' OWNER ' + q(connection.user));
    createdDatabase = true;
    await admin.query('REVOKE ALL ON DATABASE ' + q(database) + ' FROM PUBLIC');
    await admin.query('GRANT CONNECT,TEMPORARY ON DATABASE ' + q(database) + ' TO ' + q(role));
    const target = { ...connection, database },
      destination = path.join(stage, 'restored');
    await require('./backup-service.cjs').restorePostgresBackup(file, keyFile, destination, {
      connection: target,
      connectionOptions,
      applicationRole: role,
      offline: true,
    });
    const application = { ...target, user: role, password };
    const prepared = await require('./prepared-profile.cjs').preparedPostgresProfile(
      application,
      destination,
      connectionOptions,
    );
    server = await require('../../application/isolated-server.cjs').createIsolatedServer({
      storageBackend: 'postgres',
      postgres: application,
      postgresProfile: connectionOptions.profile,
      postgresAllowedHosts: connectionOptions.allowedHosts || [],
      dataDir: destination,
      ...prepared,
      host: '127.0.0.1',
      port: 0,
      origin: '',
      production: false,
      maxEnabled: false,
      pushEnabled: false,
      paymentNetworkEnabled: false,
      assistantAppointmentSavingEnabled: false,
      assistantCodexEnabled: false,
      telegramBot: null,
      supportBot: null,
      sendMail: null,
      supportDelivery: { telegram: null, email: null },
      telegramAutostart: false,
      telegramIdentityAutostart: false,
      maxAutostart: false,
      pushAutostart: false,
      supportAutostart: false,
      adminEmailAutostart: false,
      bookingPublicationAutostart: false,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (const endpoint of ['/login.html', '/api/auth/session']) {
      const response = await fetch(origin + endpoint, { signal: AbortSignal.timeout(10000) });
      if (response.status !== 200) throw Error('BACKUP_DRILL_FAILED');
      if (endpoint.includes('/api/')) {
        const session = await response.json();
        if (
          session.multiUser !== true ||
          typeof session.configured !== 'boolean' ||
          session.user !== null
        )
          throw Error('BACKUP_DRILL_FAILED');
      } else await response.arrayBuffer();
    }
    return { restored: true, started: true, notificationsPaused: true, backend: 'postgres' };
  } finally {
    let shutdownError;
    if (server) {
      server.closeAllConnections();
      try {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        shutdownConfirmed = false;
        shutdownError = error;
      }
    }
    try {
      if (connected && shutdownConfirmed) {
        if (createdDatabase) await admin.query('DROP DATABASE ' + q(database));
        if (createdRole) await admin.query('DROP ROLE ' + q(role));
      }
    } finally {
      if (connected) await admin.end();
    }
    if (shutdownConfirmed) {
      if (
        path.dirname(path.resolve(stage)) !== path.resolve(workDirectory) ||
        !path.basename(stage).startsWith('.cartoteca-drill-')
      )
        throw Error('Unsafe PostgreSQL drill cleanup.');
      fs.rmSync(stage, { recursive: true, force: true });
    }
    if (shutdownError) throw shutdownError;
  }
}
module.exports = { postgresRestoreDrill };
