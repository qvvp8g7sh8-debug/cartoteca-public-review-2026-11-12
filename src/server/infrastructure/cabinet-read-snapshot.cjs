// Pure cabinet projections only. PostgreSQL uses its write-rejecting READONLY
// snapshot; legacy storage keeps DEFERRED. Never retry a rejected authority.
const readCabinetSnapshot = (storage, read) =>
  storage.readOnlySnapshot ? storage.readOnlySnapshot(read) : storage.transaction(read, 'DEFERRED');

module.exports = { readCabinetSnapshot };
