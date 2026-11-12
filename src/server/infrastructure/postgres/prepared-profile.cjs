const { Client } = require('pg');
const { serverConnection } = require('./connection.cjs');
const { readRuntime } = require('./runtime.cjs');
const { digest } = require('./catalog-sqlite.cjs');
const { validatePostgresSchema } = require('./catalog-postgres.cjs');
// Async technical startup reads only. No key, clinical JSON or provider is opened.
async function preparedPostgresProfile(connection, directory, connectionOptions = {}) {
  const marker = readRuntime(directory),
    client = new Client({
      ...(await serverConnection(connection, connectionOptions)),
      query_timeout: 5000,
    });
  await client.connect();
  try {
    await validatePostgresSchema(client, { kind: 'platform', applicationRole: client.user });
    await require('./process-role-schema.cjs').validateRoleLeaseSchema(client, client.user);
    const revisionProfile = await require('./revision-profile132.cjs').readRevisionProfile(
      client,
      client.user,
    );
    await require('./catalog-postgres.cjs').verifyAssetProfile(client, marker);
    await client.query(
      "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
      [marker.platformStoreId],
    );
    const registered = (
      await client.query(
        "SELECT metadata,catalog_hash FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
        [marker.platformStoreId],
      )
    ).rows[0];
    if (
      !registered ||
      digest(registered.metadata) !== registered.catalog_hash ||
      registered.metadata.version !== marker.notificationSchema
    )
      throw Error('Prepared PostgreSQL platform does not match its asset lineage.');
    const tables = registered.metadata.tables;
    let isolatedReadBudgets = false,
      assistantStateBackend = 'file';
    if (tables.booking_read_budget_store) {
      const rows = (
        await client.query(
          'SELECT mode,version FROM cartoteca_platform.booking_read_budget_store WHERE _store_id=$1 AND id=1',
          [marker.platformStoreId],
        )
      ).rows;
      if (
        rows.length !== 1 ||
        Number(rows[0].version) !== 1 ||
        !['isolated', 'legacy'].includes(rows[0].mode) ||
        !marker.budgetStoreId
      )
        throw Error('Prepared PostgreSQL read budget profile is invalid.');
      isolatedReadBudgets = rows[0].mode === 'isolated';
    } else if (marker.budgetStoreId) throw Error('Prepared PostgreSQL budget has no registration.');
    if (tables.assistant_state_schema) {
      const rows = (
        await client.query(
          'SELECT backend,version FROM cartoteca_platform.assistant_state_schema WHERE _store_id=$1 AND id=1',
          [marker.platformStoreId],
        )
      ).rows;
      if (rows.length !== 1 || Number(rows[0].version) !== 1 || rows[0].backend !== 'rows-v1')
        throw Error('Prepared PostgreSQL assistant profile is invalid.');
      assistantStateBackend = 'rows-v1';
    }
    let bookingLinksVersion = 0;
    if (tables.booking_public_links_schema || tables.booking_public_links) {
      if (!tables.booking_public_links_schema || !tables.booking_public_links)
        throw Error('Prepared PostgreSQL public link profile is invalid.');
      const rows = (
        await client.query(
          'SELECT id,version FROM cartoteca_platform.booking_public_links_schema WHERE _store_id=$1',
          [marker.platformStoreId],
        )
      ).rows;
      if (rows.length !== 1 || Number(rows[0].id) !== 1 || Number(rows[0].version) !== 1)
        throw Error('Prepared PostgreSQL public link profile is invalid.');
      bookingLinksVersion = 1;
    }
    return {
      bookingLinksVersion,
      notificationSchema: marker.notificationSchema,
      isolatedReadBudgets,
      assistantStateBackend,
      sharedCabinetWrites: true,
      ...([2, 3].includes(revisionProfile) ? { postgresRevisionProfile: revisionProfile } : {}),
    };
  } finally {
    await client.end();
  }
}
async function preparePostgresRuntimeConfig(config) {
  const options = {
    profile: config.postgresProfile || 'local',
    allowedHosts: config.postgresAllowedHosts,
    pin: config.postgresPin,
  };
  const connection = await serverConnection(config.postgres, options);
  const pin =
    config.postgresProfile === 'production-v1'
      ? { version: 1, host: config.postgres.host, address: connection.host }
      : undefined;
  const prepared = await preparedPostgresProfile(config.postgres, config.dataDir, {
    ...options,
    pin,
  });
  if (
    config.notificationSchema != null &&
    config.notificationSchema !== prepared.notificationSchema
  )
    throw Error('PostgreSQL schema does not match prepared assets.');
  if (
    config.postgresRevisionProfile != null &&
    config.postgresRevisionProfile !== prepared.postgresRevisionProfile
  )
    throw Error('PostgreSQL revision profile differs from prepared assets.');
  return {
    ...config,
    ...prepared,
    ...(pin ? { postgresPin: pin } : {}),
    readBudgetVersion: prepared.isolatedReadBudgets ? 1 : 0,
  };
}

module.exports = { preparedPostgresProfile, preparePostgresRuntimeConfig };
