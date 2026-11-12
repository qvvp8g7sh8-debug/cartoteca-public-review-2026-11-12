const { Client } = require('pg');
const { localConnection } = require('../src/server/infrastructure/postgres/connection.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
async function main(args = process.argv.slice(2), environment = process.env) {
  const options = { dryRun: true, offline: false };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--apply') options.dryRun = false;
    else if (name === '--dry-run') options.dryRun = true;
    else if (name === '--offline') options.offline = true;
    else if (['--source', '--destination', '--application-role'].includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error('Missing migration argument.');
      options[
        {
          '--source': 'source',
          '--destination': 'destination',
          '--application-role': 'applicationRole',
        }[name]
      ] = value;
    } else throw Error('Unsupported migration argument.');
  }
  if (!options.source || (!options.dryRun && !options.destination))
    throw Error('Migration requires an offline source and a new asset destination.');
  const connectionString = environment.CARTOTECA_POSTGRES_URL;
  if (!connectionString)
    throw Error('Set the local migration connection using CARTOTECA_POSTGRES_URL.');
  const client = new Client(localConnection(connectionString));
  await client.connect();
  try {
    return await migratePostgresData({ ...options, client });
  } finally {
    await client.end();
  }
}
if (require.main === module)
  main()
    .then((result) =>
      console.log(
        JSON.stringify({
          dryRun: result.dryRun,
          rolledBack: result.rolledBack === true,
          sourceUnchanged: result.sourceUnchanged,
          cutover: false,
          stores: result.reports.length,
          assets: result.assets,
          migrationId: result.migrationId,
        }),
      ),
    )
    .catch((error) => {
      console.error(
        error.outcomeUnknown
          ? 'Migration commit outcome is unknown; retain staging and reconcile before activation.'
          : 'PostgreSQL migration did not complete; no cutover was performed.',
      );
      process.exitCode = 1;
    });
module.exports = { main };
