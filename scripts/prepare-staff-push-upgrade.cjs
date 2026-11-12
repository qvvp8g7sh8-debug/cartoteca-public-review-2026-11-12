const { prepareStaffPushUpgrade } = require('../src/server/migrations/prepare-staff-push.cjs');
const args = process.argv.slice(2);
const names = ['source', 'destination', 'backups', 'key'];
if (args.length !== 8 || names.some((name, i) => args[i * 2] !== '--' + name))
  throw Error('Usage: --source <offline-data> --destination <new-copy> --backups <archives> --key <backup-key>');
prepareStaffPushUpgrade({ source: args[1], destination: args[3], directory: args[5], keyFile: args[7] })
  .then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error('Push preparation failed. Original retained; inspect the staging copy locally.'); process.exitCode = 1; });
