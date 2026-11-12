const { prepareStaffMaxUpgrade } = require('../src/server/migrations/prepare-staff-max.cjs');
const args = process.argv.slice(2),
  values = {};
const names = {
  '--source': 'source',
  '--destination': 'destination',
  '--backups': 'directory',
  '--key': 'keyFile',
};
if (args.length !== 8)
  throw Error(
    'Usage: prepare-staff-max-upgrade --source SOURCE --destination NEW-DIRECTORY --backups ARCHIVES --key KEY',
  );
for (let i = 0; i < args.length; i += 2) {
  const name = Object.hasOwn(names, args[i]) ? names[args[i]] : '';
  if (!name || values[name] || !args[i + 1] || args[i + 1].startsWith('--'))
    throw Error('Invalid preparation arguments.');
  values[name] = args[i + 1];
}
prepareStaffMaxUpgrade(values)
  .then((result) => console.log(JSON.stringify(result)))
  .catch(() => {
    console.error(
      'Staff MAX preparation failed. Source retained; keep the separate copy for investigation.',
    );
    process.exitCode = 1;
  });
