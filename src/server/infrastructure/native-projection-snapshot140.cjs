'use strict';
// The identity proves only this synchronous projection's physical read snapshot.
// It is never serialized, reused across responses, or used as session authority.
function createProjectionSnapshot(database, postgres) {
  let active = null;
  function synchronous(work) {
    const value = work();
    if (value && typeof value.then === 'function')
      throw Error('Asynchronous query projection is not allowed');
    return value;
  }
  function assertOwned() {
    if (
      !database.db.isOpen ||
      !database.db.isTransaction ||
      database.db.transactionIntent !== 'READONLY'
    )
      throw Object.assign(Error('Query read snapshot is unavailable.'), {
        code: 'POSTGRES_QUERY_SNAPSHOT_INVALID',
        status: 503,
      });
    // The owner probes SQL after a prior failure; different physical roots get
    // different identities even if PostgreSQL reports the same snapshot text.
    const identity = database.db.readSnapshotIdentity();
    if (active && active.readIdentity !== identity)
      throw Object.assign(Error('Query read snapshot changed.'), {
        code: 'POSTGRES_QUERY_SNAPSHOT_INVALID',
        status: 503,
      });
    return identity;
  }
  return {
    run(organizationId, work) {
      if (!postgres) return synchronous(work);
      if (active) throw Error('Nested query projection is not allowed');
      return database.readOnlySnapshot(() => {
        active = Object.freeze({ organizationId, readIdentity: assertOwned() });
        try {
          return synchronous(work);
        } finally {
          active = null;
        }
      });
    },
    read(work) {
      if (!active) return database.readOnlySnapshot(work);
      assertOwned();
      return synchronous(work);
    },
    proof() {
      if (!active) return null;
      assertOwned();
      return active;
    },
    contains(proof, organizationId) {
      if (!active || proof !== active || active.organizationId !== organizationId) return false;
      assertOwned();
      return true;
    },
  };
}
module.exports = { createProjectionSnapshot };
