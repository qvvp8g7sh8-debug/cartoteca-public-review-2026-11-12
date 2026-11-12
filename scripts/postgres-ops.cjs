const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const {
  operatorServerConnection,
  applicationRole,
  secretFile,
} = require('../src/server/infrastructure/postgres/connection.cjs');
const { identifier: q } = require('../src/server/infrastructure/postgres/catalog-sqlite.cjs');
function fileOnly(environment) {
  if (
    environment.CARTOTECA_STORAGE_BACKEND !== 'postgres' ||
    environment.CARTOTECA_POSTGRES_PROFILE !== 'production-v1' ||
    !environment.CARTOTECA_PG_PASSWORD_FILE ||
    ['CARTOTECA_PG_PASSWORD', 'CARTOTECA_POSTGRES_URL', 'CARTOTECA_BACKUP_POSTGRES_URL'].some(
      (key) => environment[key],
    )
  )
    throw Error('Explicit private PostgreSQL profile and secret files required.');
}
function scramSecret(password, salt = crypto.randomBytes(16)) {
  if (typeof password !== 'string' || !/^[!-~]{32,128}$/.test(password))
    throw Error('Application password must contain 32–128 printable ASCII characters.');
  const salted = crypto.pbkdf2Sync(password, salt, 4096, 32, 'sha256'),
    client = crypto.createHmac('sha256', salted).update('Client Key').digest();
  return (
    'SCRAM-SHA-256$4096:' +
    salt.toString('base64') +
    '$' +
    crypto.createHash('sha256').update(client).digest('base64') +
    ':' +
    crypto.createHmac('sha256', salted).update('Server Key').digest('base64')
  );
}
async function withOwner(
  environment,
  callback,
  { connect = operatorServerConnection, createClient = (settings) => new Client(settings) } = {},
) {
  fileOnly(environment);
  const connection = await connect(undefined, environment),
    client = createClient(connection);
  try {
    await client.connect();
    return await callback(client, connection);
  } finally {
    await client.end();
  }
}
async function verifyApplicationRole(client, connection, environment, dependencies = {}) {
  fileOnly(environment);
  const role = applicationRole(undefined, environment);
  if (connection.user === role) throw Error('Migration owner and application role must differ.');
  async function assertRole(connection, where, values = []) {
    const flags = (
      await connection.query(
        'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE ' +
          where,
        values,
      )
    ).rows;
    if (flags.length !== 1 || Object.values(flags[0]).some(Boolean))
      throw Error('Application role verification failed.');
    if (
      (
        await connection.query(
          'SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1 LIMIT 1',
          [role],
        )
      ).rows.length
    )
      throw Error('Application role membership is unsafe.');
  }
  // This reusable preflight contains only SELECTs and an authenticated login.
  // In particular standalone migrate cannot create roles or publish any assets.
  await assertRole(client, 'rolname=$1', [role]);
  const password = secretFile(environment.CARTOTECA_PG_APPLICATION_PASSWORD_FILE);
  const check = (dependencies.createClient || ((settings) => new Client(settings)))({
    ...connection,
    user: role,
    password,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  try {
    await check.connect();
    await assertRole(check, 'rolname=current_user');
  } finally {
    await check.end();
  }
  return role;
}
async function provisionPostgres(environment = process.env, dependencies = {}) {
  fileOnly(environment);
  const role = applicationRole(undefined, environment),
    password = secretFile(environment.CARTOTECA_PG_APPLICATION_PASSWORD_FILE),
    encoded = scramSecret(password);
  return withOwner(
    environment,
    async (client, connection) => {
      if (connection.user === role)
        throw Error('Migration owner and application role must differ.');
      await client.query('BEGIN');
      let committed = false,
        created = false;
      try {
        await client.query(
          "SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'",
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('cartoteca-bootstrap-app-role',0))",
        );
        const rows = (
          await client.query(
            'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1',
            [role],
          )
        ).rows;
        if (rows.length) {
          if (
            Object.values(rows[0]).some(Boolean) ||
            (
              await client.query(
                'SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1 LIMIT 1',
                [role],
              )
            ).rows.length
          )
            throw Error('Existing application role has unsafe privileges.');
        } else {
          await client.query(
            'CREATE ROLE ' +
              q(role) +
              " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 24 PASSWORD '" +
              encoded +
              "'",
          );
          created = true;
        }
        await client.query('REVOKE ALL ON DATABASE ' + q(connection.database) + ' FROM PUBLIC');
        await client.query(
          'GRANT CONNECT,TEMPORARY ON DATABASE ' + q(connection.database) + ' TO ' + q(role),
        );
        await client.query('COMMIT');
        committed = true;
      } finally {
        if (!committed) await client.query('ROLLBACK').catch(() => {});
      }
      await verifyApplicationRole(client, connection, environment, dependencies);
      return { provisioned: true, created, applicationRoleSafe: true };
    },
    dependencies,
  );
}
function migrationOptions(args, environment = process.env) {
  const options = {
    source: '/migration/source',
    destination: environment.CARTOTECA_DATA_DIR,
    dryRun: true,
    offline: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--offline') options.offline = true;
    else if (args[i] === '--apply') options.dryRun = false;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (['--source', '--destination'].includes(args[i])) {
      const name = args[i].slice(2),
        value = args[++i];
      if (!value || value.startsWith('--')) throw Error('Missing migration path.');
      options[name] = value;
    } else throw Error('Unsupported server migration option.');
  }
  if (
    !options.offline ||
    ![options.source, options.destination].every(
      (value) => typeof value === 'string' && path.isAbsolute(value),
    )
  )
    throw Error('Explicit offline source and separate new asset destination required.');
  return options;
}
async function migrateServer(args, environment = process.env, dependencies = {}) {
  const options = migrationOptions(args, environment);
  return withOwner(
    environment,
    async (client, connection) => {
      const role = await verifyApplicationRole(client, connection, environment, dependencies);
      const migrated = await (
        dependencies.migrate ||
        require('../src/server/infrastructure/postgres/migration.cjs').migratePostgresData
      )({ ...options, client, applicationRole: role });
      return {
        migrated: !migrated.dryRun,
        dryRun: migrated.dryRun,
        rolledBack: migrated.rolledBack === true,
        stores: migrated.reports.length,
        sourceUnchanged: migrated.sourceUnchanged === true,
        cutover: false,
      };
    },
    dependencies,
  );
}
function roleLeaseOptions(args) {
  if (
    args.length !== 2 ||
    args.filter((value) => value === '--offline').length !== 1 ||
    args.filter((value) => value === '--apply' || value === '--dry-run').length !== 1
  )
    throw Error('Role lease preparation requires exactly --offline and --apply or --dry-run.');
  return { dryRun: args.includes('--dry-run') };
}
async function rolePreparationSnapshot(client) {
  const registry = {};
  // Aggregate only technical catalogs in PostgreSQL; store metadata never crosses
  // into output, and the result size is independent of the number of tenants.
  for (const table of [
    'stores',
    'asset_profiles',
    'objects',
    'columns',
    'indexes',
    'index_columns',
    'templates',
    'native_objects',
    'native_manifests',
  ]) {
    const result = (
      await client.query(
        `SELECT count(*)::text AS rows,md5(coalesce(string_agg(fingerprint,'' ORDER BY fingerprint),'')) AS digest
       FROM (SELECT md5(row_to_json(t)::text) AS fingerprint FROM cartoteca_catalog.${q(table)} t) s`,
      )
    ).rows;
    if (
      result.length !== 1 ||
      !/^[0-9]+$/.test(result[0].rows) ||
      !/^[a-f0-9]{32}$/.test(result[0].digest)
    )
      throw Error('Role lease preparation catalog proof is unavailable.');
    registry[table] = result[0];
  }
  if (registry.stores.rows === '0') throw Error('Existing PostgreSQL stores are required.');
  const { nativeSignature } = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');
  const schemas = {};
  for (const kind of ['platform', 'cabinet', 'budget'])
    schemas[kind] = crypto
      .createHash('sha256')
      .update(JSON.stringify(await nativeSignature(client, kind)))
      .digest('hex');
  return {
    registry: crypto.createHash('sha256').update(JSON.stringify(registry)).digest('hex'),
    schemas: JSON.stringify(schemas),
  };
}
async function prepareRoleLeases(args, environment = process.env, dependencies = {}) {
  const { dryRun } = roleLeaseOptions(args);
  return withOwner(
    environment,
    async (client, connection) => {
      const role = await verifyApplicationRole(client, connection, environment, dependencies);
      const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
      const ensure =
        dependencies.ensureRoleLeaseSchema ||
        require('../src/server/infrastructure/postgres/process-role-schema.cjs')
          .ensureRoleLeaseSchema;
      await client.query('BEGIN');
      let settled = false;
      try {
        await client.query(
          "SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'",
        );
        // Every old application process must already be stopped. This is the
        // exclusive maintenance fence used by existing migration/backup operations.
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
        const before = await rolePreparationSnapshot(client);
        const ensured = await ensure(client, role);
        if (ensured?.validated !== true || typeof ensured.created !== 'boolean')
          throw Error('Role lease schema verification did not complete.');
        const after = await rolePreparationSnapshot(client);
        if (before.registry !== after.registry || before.schemas !== after.schemas)
          throw Error(
            'Existing PostgreSQL store or business schema changed during role preparation.',
          );
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        settled = true;
        return {
          prepared: !dryRun,
          dryRun,
          rolledBack: dryRun,
          created: !dryRun && ensured.created,
          wouldCreate: ensured.created,
          verified: true,
          nativeStoreRowsUnchanged: true,
          businessSchemaUnchanged: true,
          rolesChanged: false,
          cutover: false,
        };
      } finally {
        if (!settled) await client.query('ROLLBACK').catch(() => {});
      }
    },
    dependencies,
  );
}
async function main(args = process.argv.slice(2), environment = process.env) {
  if (args[0] === 'provision' && args.length === 1) return provisionPostgres(environment);
  if (args[0] === 'migrate') return migrateServer(args.slice(1), environment);
  if (args[0] === 'prepare-role-leases') return prepareRoleLeases(args.slice(1), environment);
  if (
    args[0] === 'prepare-compound' ||
    args[0] === 'rollback-compound' ||
    args[0] === 'rollback-revisions'
  )
    return require('../src/server/infrastructure/postgres/revision-operator133.cjs').operateCompoundProfile(
      args.slice(1),
      environment,
      {},
      args[0] === 'prepare-compound' ? 3 : args[0] === 'rollback-compound' ? 2 : 1,
    );
  if (args[0] === 'prepare-revisions')
    return require('../src/server/infrastructure/postgres/revision-operator132.cjs').operateRevisionProfile(
      args.slice(1),
      environment,
      {},
      2,
    );
  if (args[0] === 'help' && args.length === 1)
    return {
      commands: [
        'provision',
        'migrate --offline [--apply] [--source /path]',
        'prepare-role-leases --offline --apply|--dry-run',
        'prepare-revisions --offline --apply|--dry-run',
        'rollback-revisions --offline --apply|--dry-run',
        'prepare-compound --offline --apply|--dry-run',
        'rollback-compound --offline --apply|--dry-run',
      ],
      automaticMigration: false,
      revisionOperatorAuthority: 'superuser-or-bypassrls; application privileges unchanged',
    };
  throw Error('Unsupported PostgreSQL operation.');
}
module.exports = {
  main,
  prepareRoleLeases,
  roleLeaseOptions,
  withOwner,
  provisionPostgres,
  verifyApplicationRole,
  migrateServer,
  migrationOptions,
  fileOnly,
  scramSecret,
};
if (require.main === module)
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error('PostgreSQL operation did not complete; no runtime cutover was performed.');
      process.exitCode = 1;
    });
