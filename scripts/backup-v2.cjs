const path = require('node:path');
const {
  createV2Backup,
  verifyV2Backup,
  restoreV2Backup,
  createBackupKey,
} = require('../src/server/infrastructure/backup/service.cjs');
const [action, ...args] = process.argv.slice(2);
function value(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}
(async () => {
  if (action === 'drill') {
    const allowed = new Set(['--source', '--key', '--work']);
    if (
      args.length !== 6 ||
      args.some((arg, index) => index % 2 === 0 && !allowed.has(arg)) ||
      new Set(args.filter((arg, index) => index % 2 === 0)).size !== 3
    )
      throw Error('BACKUP_DRILL_CONFIGURATION');
    const { archiveRestoreDrill } = require('../src/server/infrastructure/backup/operations.cjs');
    const timer = setTimeout(() => process.exit(1), 1800000);
    timer.unref();
    try {
      console.log(
        JSON.stringify(
          await archiveRestoreDrill({
            archive: value('--source'),
            keyFile: value('--key'),
            workDirectory: value('--work'),
          }),
        ),
      );
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  const keyFile = value('--key', process.env.BACKUP_KEY_FILE);
  if (!keyFile) throw Error('Specify --key: an independent private key file is required.');
  if (action === 'key') {
    createBackupKey(keyFile);
    console.log('Backup key created. Store a separate protected recovery copy.');
    return;
  }
  if (action === 'create') {
    const directory = value('--backups', process.env.BACKUP_DIR);
    if (!directory) throw Error('Specify --backups outside the data directory.');
    const result = await createV2Backup({
      source: value(
        '--data',
        process.env.CARTOTECA_DATA_DIR || path.resolve(__dirname, '..', 'runtime'),
      ),
      directory,
      keyFile,
    });
    console.log(JSON.stringify(result));
    return;
  }
  const source = value('--source');
  if (!source) throw Error('Specify --source archive.');
  if (action === 'verify') {
    console.log(JSON.stringify(await verifyV2Backup(source, keyFile)));
    return;
  }
  const destination = value('--destination');
  if (action !== 'restore' || !destination)
    throw Error('Use key/create/verify/restore; restore requires a new --destination.');
  console.log(
    JSON.stringify(
      await restoreV2Backup(source, keyFile, destination, { offline: args.includes('--offline') }),
    ),
  );
})().catch(() => {
  console.error(
    'Операция резервирования v2 не завершена. Проверьте пути, свободное место, ключ и целостность копии. Рабочие данные не заменены.',
  );
  process.exitCode = 1;
});
