const {
  preparePaidServicesProductionUpgrade,
} = require('../src/server/migrations/prepare-paid-services-upgrade.cjs');
const args = process.argv.slice(2),
  names = ['source', 'destination', 'backups', 'key'];
if (
  args.length !== 9 ||
  names.some((name, index) => args[index * 2] !== '--' + name) ||
  args[8] !== '--offline'
)
  throw Error(
    'Usage: --source <stopped-schema17-data> --destination <new-copy> --backups <archives> --key <backup-key> --offline',
  );
preparePaidServicesProductionUpgrade({
  source: args[1],
  destination: args[3],
  directory: args[5],
  keyFile: args[7],
  offline: true,
})
  .then((value) => console.log(JSON.stringify(value)))
  .catch(() => {
    console.error(
      'Paid services preparation failed. Original retained; do not activate incomplete copy.',
    );
    process.exitCode = 1;
  });
