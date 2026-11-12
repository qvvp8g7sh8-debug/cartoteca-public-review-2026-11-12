const mutations = new Set([
  'PUT /api/cabinet',
  'PATCH /api/cabinet/changes',
  'POST /api/cabinet/appointments',
]);
const routes = require('../modules/cabinet/routes.cjs').routes.filter((route) =>
  mutations.has(route.method + ' ' + route.path),
);
if (routes.length !== mutations.size) throw Error('Native command routes are incomplete.');
function isNativeCommand(req) {
  if (typeof req?.url !== 'string') return false;
  try {
    return mutations.has(req.method + ' ' + new URL(req.url, 'http://native.invalid').pathname);
  } catch {
    return false;
  }
}
// Only an operator/configuration option enables the extra owner. Old prepared
// profiles retain their topology; no URL, body or header selects an owner.
function nativeCommandIsolation(config) {
  if (config.nativeCommandIsolation !== undefined) {
    if (typeof config.nativeCommandIsolation !== 'boolean')
      throw Error('Invalid native command isolation option.');
    return config.nativeCommandIsolation;
  }
  return config.storageBackend === 'postgres' && [2, 3].includes(config.postgresRevisionProfile);
}
function nativeCommandOwnerCount(config) {
  const isolated = nativeCommandIsolation(config),
    count = config.nativeCommandOwners ?? 2;
  if (!Number.isSafeInteger(count) || count < 2 || count > 4)
    throw Error('Invalid native command owner count.');
  if (
    count > 2 &&
    (!isolated ||
      config.storageBackend !== 'postgres' ||
      config.postgresRevisionProfile !== 3 ||
      config.nativeMemoryBudgetVersion !== 1 ||
      ![4096, 8192].includes(config.nativeMemoryBudgetMiB))
  )
    throw Error('Additional command owners require the managed 4096/8192 MiB PostgreSQL profile.');
  if (!isolated) return 0;
  if (config.storageBackend !== 'postgres' || config.postgresRevisionProfile !== 3) return 1;
  // Independent command owners share bounded work admission. HTTP input cannot
  // create another process; fresh database authorization and CAS remain decisive.
  return count;
}
module.exports = { routes, isNativeCommand, nativeCommandIsolation, nativeCommandOwnerCount };
