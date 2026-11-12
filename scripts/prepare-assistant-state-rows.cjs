const {
  prepareAssistantStateRowsCopy,
} = require('../src/server/migrations/prepare-assistant-state-rows.cjs');
const args = process.argv.slice(2),
  names = ['source', 'destination', 'backups', 'key'];
if (
  ![9, 10].includes(args.length) ||
  names.some(
    (name, index) =>
      args[index * 2] !== '--' + name ||
      !args[index * 2 + 1] ||
      args[index * 2 + 1].startsWith('--'),
  ) ||
  args[8] !== '--offline' ||
  (args.length === 10 && args[9] !== '--rollback')
) {
  console.error(
    'Usage: --source <stopped-data> --destination <new-copy> --backups <archives> --key <backup-key> --offline [--rollback]',
  );
  process.exitCode = 1;
} else {
  prepareAssistantStateRowsCopy({
    source: args[1],
    destination: args[3],
    directory: args[5],
    keyFile: args[7],
    offline: true,
    rollback: args[9] === '--rollback',
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        'Assistant rows preparation failed. Original retained; do not activate incomplete copy.',
      );
      process.exitCode = 1;
    });
}
