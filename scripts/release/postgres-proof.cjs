function assertPostgresConfiguration(config) {
  if (
    config.storageBackend !== 'postgres' ||
    config.postgresProfile !== 'production-v1' ||
    config.paymentNetworkEnabled !== false ||
    config.migration !== undefined ||
    config.publicationGate !== undefined ||
    (config.assistantSavingVersion !== undefined &&
      (config.assistantSavingVersion !== 1 ||
        config.schema !== 19 ||
        config.readBudgetVersion !== 1 ||
        config.bookingLinksVersion !== 1)) ||
    ![11, 15, 16, 17, 18, 19, 20].includes(config.schema)
  )
    throw Error(
      'PostgreSQL requires its explicit server profile; automatic cutover is unavailable',
    );
  for (const name of ['readBudgetVersion', 'bookingLinksVersion'])
    if (config[name] !== undefined && (config[name] !== 1 || ![17, 19, 20].includes(config.schema)))
      throw Error('Unsupported PostgreSQL component pin');
  if (config.bookingLinksVersion === 1 && config.readBudgetVersion !== 1)
    throw Error('PostgreSQL short links require the prepared read budget');
}
function assertPostgresReadiness(value, config) {
  const e = value?.executors,
    q = e?.queries,
    saving = config.assistantSavingVersion === 1,
    authority = value?.assistantAuthority;
  const savingMatches = saving
    ? value?.assistantSavingVersion === 1 &&
      value.assistantAppointmentSavingConfigured === true &&
      value.assistantAppointmentSavingEnabled === true &&
      value.releaseGate === false &&
      authority?.required === true &&
      authority.owned === true &&
      authority.holders === 1
    : value?.assistantAppointmentSavingEnabled === false &&
      (value.assistantSavingVersion === undefined || value.assistantSavingVersion === 0) &&
      (value.assistantAppointmentSavingConfigured === undefined ||
        value.assistantAppointmentSavingConfigured === false) &&
      (value.releaseGate === undefined || value.releaseGate === false) &&
      (authority === undefined ||
        (authority.required === false && authority.owned === false && authority.holders === 0));
  if (
    value?.version !== 1 ||
    value.backend !== 'postgres' ||
    value.profile !== 'production-v1' ||
    value.ready !== true ||
    value.schema !== config.schema ||
    value.nativeSchema !== true ||
    value.rls !== true ||
    value.assetLineage !== true ||
    value.preparedModes !== true ||
    !Number.isSafeInteger(value.stores) ||
    value.stores < 2 ||
    value.stores > 100000 ||
    value.paymentNetworkEnabled !== false ||
    !savingMatches ||
    e?.version !== 1 ||
    e.backend !== 'postgres' ||
    e.ready !== true ||
    e.profileMatches !== true ||
    e.gateway?.open !== true ||
    e.children?.web !== true ||
    e.children?.background !== true ||
    !Number.isSafeInteger(q?.configured) ||
    q.configured < 1 ||
    q.configured > 16 ||
    q.ready !== q.configured ||
    q.closed !== false ||
    (config.readBudgetVersion === 1 &&
      (value.readBudgetVersion !== 1 || value.sharedCabinetWrites !== true)) ||
    (config.bookingLinksVersion === 1 && value.bookingLinksVersion !== 1)
  )
    throw Error('PostgreSQL native readiness is not confirmed');
  return true;
}
function assertPostgresBackup(value) {
  if (
    !['protected', 'local_only'].includes(value?.state) ||
    value.backend !== 'postgres' ||
    value.verified !== true ||
    value.drill?.backend !== 'postgres' ||
    value.drill.restored !== true ||
    value.drill.started !== true ||
    value.drill.notificationsPaused !== true
  )
    throw Error('PostgreSQL native backup and restore drill are not confirmed');
  return true;
}
function assertPostgresServerProof(server, config) {
  assertPostgresConfiguration(config);
  const source = server.public?.storageBackend ? server.public : server;
  if (source.storageBackend !== 'postgres' || source.postgresProfile !== 'production-v1')
    throw Error('PostgreSQL backend identity changed');
  assertPostgresReadiness(source.postgresReadiness, config);
  assertPostgresBackup(source.backupBefore);
  assertPostgresBackup(source.backupAfter);
}
module.exports = {
  assertPostgresConfiguration,
  assertPostgresReadiness,
  assertPostgresBackup,
  assertPostgresServerProof,
};
