const {
  prepareMultiServiceBilling,
} = require('../src/server/migrations/prepare-multi-service-billing.cjs');
const args = process.argv.slice(2),
  flags = ['--source', '--destination', '--backup-directory', '--key-file'];
if (
  args.length !== 9 ||
  args[8] !== '--offline' ||
  flags.some((flag, index) => args[index * 2] !== flag)
)
  throw Error(
    'Usage: node scripts/prepare-multi-service-billing.cjs --source DATA --destination NEW_COPY --backup-directory BACKUPS --key-file KEY --offline',
  );
prepareMultiServiceBilling({
  source: args[1],
  destination: args[3],
  directory: args[5],
  keyFile: args[7],
  offline: true,
})
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch(() => {
    console.error(
      'Multi-service preparation failed; source retained, preserve backups and the incomplete-copy marker.',
    );
    process.exitCode = 1;
  });
