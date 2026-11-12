const {
  prepareNotificationUpgrade,
} = require('../src/server/migrations/prepare-notifications.cjs');
const args = process.argv.slice(2);
const names = ['--source', '--destination', '--backups', '--key'];
const values = {};
if (args.length !== 8) throw Error('Use four explicit source/destination/backups/key paths.');
for (let i = 0; i < args.length; i += 2) {
  if (!names.includes(args[i]) || values[args[i]] || !args[i + 1] || args[i + 1].startsWith('--'))
    throw Error('Invalid upgrade arguments.');
  values[args[i]] = args[i + 1];
}
prepareNotificationUpgrade({
  source: values['--source'],
  destination: values['--destination'],
  directory: values['--backups'],
  keyFile: values['--key'],
})
  .then((result) => console.log(JSON.stringify(result)))
  .catch(() => {
    console.error(
      'Подготовка обновления не завершена. Исходник не заменён; сохраните новую копию.',
    );
    process.exitCode = 1;
  });
