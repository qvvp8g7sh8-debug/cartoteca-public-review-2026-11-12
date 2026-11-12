const path = require('node:path');
const fs = require('node:fs');
const { createStorage } = require('./storage.cjs');
const { createBackup, restoreBackup, verifyArchive } = require('./backup.cjs');
(async () => {
  const [action, ...args] = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
  const dir = value('--data', process.env.CARTOTECA_DATA_DIR || path.join(__dirname, 'data'));
  const backupDir = value('--backups', process.env.BACKUP_DIR || path.join(__dirname, 'backups'));
  const key = value('--key', process.env.BACKUP_KEY_FILE || path.join(backupDir, 'backup.key'));
  if (fs.existsSync(path.join(dir, 'platform', 'platform.sqlite'))) throw Error('Legacy backup does not include platform or tenant databases. Read docs/MIGRATION.md.');
  if (action === 'create') { const storage = createStorage(dir); try { console.log(await createBackup(storage, backupDir, key)); } finally { storage.close(); } }
  else if (action === 'restore') { if (!value('--source') || !value('--destination')) throw Error('Use --source archive --destination NEW-directory --key key-file'); console.log(await restoreBackup(value('--source'), key, value('--destination'))); }
  else if (action === 'verify') { await verifyArchive(value('--source'), key); console.log('Backup authentication: OK'); }
  else throw Error('Use create, restore or verify');
})().catch(() => { console.error('Операция не выполнена. Проверьте пути, ключ и доступность файлов. При восстановлении укажите новую, ещё не существующую папку.'); process.exitCode = 1; });
