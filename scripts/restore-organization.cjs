const fs = require('node:fs');
const path = require('node:path');
const sqliteRestore = require('../src/server/infrastructure/backup/organization-restore.cjs');
const sqliteSwitch = require('../src/server/infrastructure/backup/organization-switch.cjs');
const { readDocument } = require('../src/server/infrastructure/backup/organization-signature.cjs');
const { safeTree } = require('../src/server/infrastructure/backup/snapshot.cjs');
const [action, ...args] = process.argv.slice(2);
function options() {
  const allowed = new Set([
    '--source',
    '--archive',
    '--key',
    '--job',
    '--organization',
    '--confirm',
    '--stopped',
    '--backend',
  ]);
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!allowed.has(name) || values.has(name)) throw Error('Unknown or duplicate argument.');
    if (name === '--stopped') {
      values.set(name, true);
      continue;
    }
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('Missing explicit argument.');
    values.set(name, args[++i]);
  }
  if (!values.get('--job') || !values.get('--key')) throw Error('Specify --job and --key.');
  const result = { jobDirectory: values.get('--job'), keyFile: values.get('--key') };
  if (action === 'prepare') {
    if (!values.get('--source') || !values.get('--archive') || !values.get('--organization'))
      throw Error('Specify source, archive and organization.');
    Object.assign(result, {
      source: values.get('--source'),
      archive: values.get('--archive'),
      organizationId: values.get('--organization'),
    });
  } else if (['apply', 'recover', 'rollback'].includes(action)) {
    if (!values.get('--source') || !values.get('--confirm'))
      throw Error('Specify source and exact plan confirmation.');
    Object.assign(result, {
      source: values.get('--source'),
      confirmation: values.get('--confirm'),
      stopped: values.get('--stopped') === true,
    });
  } else if (!['verify', 'status'].includes(action))
    throw Error('Use prepare, verify, status, apply, recover or rollback.');
  let backend;
  if (action === 'prepare') {
    safeTree(path.resolve(result.source));
    backend = fs.existsSync(path.join(result.source, 'postgresql-runtime.json'))
      ? 'postgres'
      : 'sqlite';
  } else {
    // Routing is chosen only after authentication of the prepared plan.
    safeTree(path.resolve(result.jobDirectory));
    const plan = readDocument(path.join(result.jobDirectory, 'plan.json'), result.keyFile);
    backend = plan.backend === 'postgres' ? 'postgres' : 'sqlite';
  }
  if (
    values.has('--backend') &&
    (!['sqlite', 'postgres'].includes(values.get('--backend')) ||
      values.get('--backend') !== backend)
  )
    throw Error('Explicit backend does not match the source or signed plan.');
  return { backend, result };
}
(async () => {
  const { backend, result: value } = options();
  const restore =
    backend === 'postgres'
      ? require('../src/server/infrastructure/postgres/organization-restore.cjs')
      : sqliteRestore;
  const switching =
    backend === 'postgres'
      ? require('../src/server/infrastructure/postgres/organization-switch.cjs')
      : sqliteSwitch;
  if (backend === 'postgres' && ['prepare', 'apply', 'recover', 'rollback'].includes(action))
    value.connection =
      require('../src/server/infrastructure/postgres/connection.cjs').operatorSettings();
  if (action === 'recover' && backend !== 'postgres')
    throw Error('Use the SQLite recovery workflow for this signed plan.');
  const result =
    action === 'prepare'
      ? await restore.prepareOrganizationRestore(value)
      : action === 'status'
        ? restore.organizationRestoreStatus(value)
        : action === 'verify'
          ? await restore.verifyOrganizationRestore(value)
          : action === 'apply'
            ? await switching.applyOrganizationRestore(value)
            : action === 'recover'
              ? await switching.recoverOrganizationRestore(value)
              : await switching.rollbackOrganizationRestore(value);
  console.log(JSON.stringify(result));
})().catch(() => {
  // Keep raw database, crypto, path and clinical details out of CLI output.
  console.error(
    'Восстановление организации не завершено. Сохраните комплект и журнал. При начатом переключении не запускайте сервер до безопасного возврата.',
  );
  process.exitCode = 1;
});
