const fs = require('node:fs');
const path = require('node:path');
const { safeTree } = require('./snapshot.cjs');
const { restoreV2Backup } = require('./service.cjs');
const { DatabaseSync } = require('node:sqlite');
const { registration } = require('../booking-read-budget-store.cjs');
const assistantRows = require('../../modules/assistant/access/row-schema.cjs');
const { markBackupStage } = require('./staging.cjs');

async function restoreDrill(file, keyFile, workDirectory, ownership = {}) {
  if (require('./archive.cjs').archiveKind(file) === 'postgres')
    return require('../postgres/backup-drill.cjs').postgresRestoreDrill(
      file,
      keyFile,
      workDirectory,
      ownership,
    );
  safeTree(workDirectory);
  fs.mkdirSync(workDirectory, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(workDirectory, '.cartoteca-drill-'));
  let server;
  try {
    markBackupStage(stage, 'backup-drill', ownership);
    await restoreV2Backup(file, keyFile, path.join(stage, 'restored'));
    // A full runtime startup, not just archive readability. No outbound adapters/workers.
    const { createMultiServer } = require('../../application/server.cjs');
    const prepared = new DatabaseSync(path.join(stage, 'restored', 'platform', 'platform.sqlite'), {
      readOnly: true,
    });
    let schema, isolatedReadBudgets, assistantStateBackend;
    try {
      schema = prepared.prepare('PRAGMA user_version').get().user_version;
      isolatedReadBudgets = registration(prepared)?.mode === 'isolated';
      assistantStateBackend = assistantRows.validate(prepared) ? 'rows-v1' : 'file';
    } finally {
      prepared.close();
    }
    server = createMultiServer({
      notificationSchema: schema >= 12 ? schema : 11,
      isolatedReadBudgets,
      assistantStateBackend,
      dataDir: path.join(stage, 'restored'),
      production: false,
      origin: '',
      host: '127.0.0.1',
      port: 0,
      additionalOrigins: [],
      backupStatusFile: '',
      sendMail: null,
      telegramBot: null,
      supportDelivery: { telegram: null, email: null },
      telegramAutostart: false,
      supportAutostart: false,
      adminEmailAutostart: false,
      maxAutostart: false,
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
      const content = await response.text();
      if (endpoint.includes('/api/')) {
        const session = JSON.parse(content);
        if (
          session.multiUser !== true ||
          typeof session.configured !== 'boolean' ||
          session.user !== null
        )
          throw Error('BACKUP_DRILL_FAILED');
      }
    }
    return { restored: true, started: true, notificationsPaused: true };
  } catch {
    throw Error('BACKUP_DRILL_FAILED');
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (
      path.dirname(stage) !== path.resolve(workDirectory) ||
      !path.basename(stage).startsWith('.cartoteca-drill-')
    )
      throw Error('Unsafe drill cleanup');
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
module.exports = { restoreDrill };
