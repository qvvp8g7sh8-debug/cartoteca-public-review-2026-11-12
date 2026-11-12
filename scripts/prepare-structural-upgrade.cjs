const { prepareStructuralUpgrade } = require('../src/server/migrations/prepare-structural-upgrade.cjs');
const args = process.argv.slice(2);
const names = ['source', 'destination', 'backups', 'key'];
if (![9, 10].includes(args.length) || names.some((name, i) => args[i * 2] !== '--' + name) ||
    args[8] !== '--offline' || (args.length === 10 && args[9] !== '--rollback'))
  throw Error('Usage: --source <stopped-data> --destination <new-copy> --backups <archives> --key <backup-key> --offline [--rollback]');
prepareStructuralUpgrade({ source: args[1], destination: args[3], directory: args[5], keyFile: args[7], offline: true, rollback: args[9] === '--rollback' })
  .then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error('Structural preparation failed. Original retained; do not activate incomplete copy.'); process.exitCode = 1; });
