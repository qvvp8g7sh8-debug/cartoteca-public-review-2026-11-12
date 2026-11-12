const { readRuntime } = require('./runtime.cjs');
const { createPostgresCoordinator } = require('./coordinator.cjs');

// Called only inside an isolated application/query owner. The public gateway
// keeps its event loop free of synchronous business SQL and clinical decoding.
async function initializePostgresOwner(options, { onFatal } = {}) {
  if (options.storageBackend !== 'postgres') return options;
  if (options.databaseOwner) throw Error('PostgreSQL owner must be private to its executor.');
  const marker = readRuntime(options.dataDir);
  if (
    options.notificationSchema != null &&
    options.notificationSchema !== marker.notificationSchema
  )
    throw Error('PostgreSQL schema does not match prepared assets.');
  const prepared = await require('./prepared-profile.cjs').preparePostgresRuntimeConfig(options);
  const connection = await require('./connection.cjs').serverConnection(prepared.postgres, {
    profile: prepared.postgresProfile || 'local',
    allowedHosts: prepared.postgresAllowedHosts,
    pin: prepared.postgresPin,
  });
  let processRoles, owner;
  try {
    if (['combined', 'background'].includes(prepared.processRole) && !prepared.releaseGate)
      processRoles = await require('./process-role-channel.cjs').createProcessRoleChannel({
        connection,
        marker,
        ...(prepared.nativeMemoryProcess
          ? { nativeMemoryProcess: prepared.nativeMemoryProcess }
          : {}),
      });
    owner = createPostgresCoordinator({
      connection,
      allowBlocking: true,
      onFatal,
      processRoles,
      revisionProfile: prepared.postgresRevisionProfile,
      ...(prepared.nativeMemoryProcess
        ? {
            nativeMemoryProcess: prepared.nativeMemoryProcess,
            nativeMemoryMailbox: prepared.nativeMemoryMailbox,
          }
        : {}),
    });
    await owner.ready();
    return { ...prepared, notificationSchema: marker.notificationSchema, databaseOwner: owner };
  } catch (error) {
    await owner?.close().catch(() => {});
    await processRoles?.close().catch(() => {});
    throw error;
  }
}
module.exports = { initializePostgresOwner };
