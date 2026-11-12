const { prepareNotificationCopy } = require('../src/server/migrations/prepare-notifications.cjs');
const args = process.argv.slice(2);
const names = ['--source', '--destination', '--backups', '--key'];
const values = {};
if (args.length !== 8)
  throw Error('Use --source SOURCE --destination NEW-COPY --backups ARCHIVES --key PRIVATE-KEY.');
for (let i = 0; i < args.length; i += 2) {
  if (!names.includes(args[i]) || values[args[i]] || !args[i + 1] || args[i + 1].startsWith('--'))
    throw Error('Invalid notification preparation arguments.');
  values[args[i]] = args[i + 1];
}
prepareNotificationCopy({
  source: values['--source'],
  destination: values['--destination'],
  directory: values['--backups'],
  keyFile: values['--key'],
})
  .then((result) => console.log(JSON.stringify(result)))
  .catch(() => {
    console.error(
      'Подготовка MAX не завершена. Исходные данные не заменены; сохраните новую копию для разбора.',
    );
    process.exitCode = 1;
  });
