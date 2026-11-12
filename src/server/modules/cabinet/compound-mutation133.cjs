// Only server composition supplies these operations and cabinet handles. The
// native owner checks the prepared profile, lineage and closed write set again.
function scopeFor(storage, organizationId, operation) {
  const native = storage?.db?.scope;
  return {
    operation,
    organizationId,
    cabinetStoreId: native?.kind === 'cabinet' ? native.storeId : null,
  };
}
function compoundMutation(platform, storage, organizationId, operation, callback) {
  if (platform.withCompoundMutation)
    return platform.withCompoundMutation(callback, scopeFor(storage, organizationId, operation));
  return platform.withWriteLock(callback);
}
function asyncCompoundMutation(platform, storage, organizationId, operation, callback, options) {
  if (platform.withAsyncCompoundMutation)
    return platform.withAsyncCompoundMutation(
      callback,
      scopeFor(storage, organizationId, operation),
      options,
    );
  const write = platform.withAsyncWriteLock || ((work) => platform.withWriteLock(work));
  return write(callback, options);
}
module.exports = { scopeFor, compoundMutation, asyncCompoundMutation };
